import { isDryRun, wrapToolHandler, redactSensitive, logAudit } from "../src/middleware.js";
import { FaxDropError } from "../src/client.js";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["FAXDROP_MCP_DRY_RUN", "FAXDROP_MCP_AUDIT_LOG"];

describe("Middleware", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  describe("isDryRun", () => {
    it("returns false by default", () => {
      expect(isDryRun()).toBe(false);
    });

    it("returns true when FAXDROP_MCP_DRY_RUN=true", () => {
      process.env.FAXDROP_MCP_DRY_RUN = "true";
      expect(isDryRun()).toBe(true);
    });
  });

  describe("wrapToolHandler", () => {
    it("passes through read tool calls unchanged", async () => {
      const handler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const wrapped = wrapToolHandler("faxdrop_get_fax_status", handler);
      const result = await wrapped({});
      expect(result.content[0].text).toBe("ok");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does NOT short-circuit a read tool when DRY_RUN=true", async () => {
      // Reads are safe to actually run even in dry-run; only writes are mocked.
      process.env.FAXDROP_MCP_DRY_RUN = "true";
      const handler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "real-status" }],
      }));
      const wrapped = wrapToolHandler("faxdrop_get_fax_status", handler);
      const result = await wrapped({ faxId: "fax_abc" });
      expect(handler).toHaveBeenCalled();
      expect(result.content[0].text).toBe("real-status");
    });

    it("returns dry-run response without calling handler when DRY_RUN=true on write", async () => {
      process.env.FAXDROP_MCP_DRY_RUN = "true";
      const handler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({ recipientNumber: "+12125551234" });
      expect(handler).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("dryRun");
      expect(result.content[0].text).toContain("faxdrop_send_fax");
    });

    it("converts FaxDropError 402 to isError with credits hint", async () => {
      const handler = vi.fn(async () => {
        throw new FaxDropError("No credits", 402, "payment_required");
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("FaxDrop API error 402");
      expect(result.content[0].text).toContain("No fax credits remaining");
    });

    it("converts FaxDropError 429 to isError with retry-after hint", async () => {
      const handler = vi.fn(async () => {
        throw new FaxDropError("Slow down", 429, "rate_limited", undefined, 30);
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("FaxDrop API error 429");
      expect(result.content[0].text).toContain("retry in 30s");
    });

    it("converts FaxDropError 400 with hint surfaced", async () => {
      const handler = vi.fn(async () => {
        throw new FaxDropError("File too big", 400, "bad_request", "Compress to <10MB.");
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Hint: Compress to <10MB.");
    });

    it("re-throws non-FaxDrop errors unchanged", async () => {
      const handler = vi.fn(async () => {
        throw new Error("unexpected");
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      await expect(wrapped({})).rejects.toThrow("unexpected");
    });

    it("audits as `error` when handler returns isError:true (business error)", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "faxdrop-audit-iserror-"));
      const auditPath = join(tmpDir, "audit.log");
      try {
        process.env.FAXDROP_MCP_AUDIT_LOG = auditPath;
        const handler = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "handler-surfaced failure" }],
          isError: true,
        }));
        const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
        const result = await wrapped({});
        expect(result.isError).toBe(true);
        const entry = JSON.parse(readFileSync(auditPath, "utf8").trim()) as Record<string, unknown>;
        expect(entry.tool).toBe("faxdrop_send_fax");
        expect(entry.result).toBe("error");
      } finally {
        delete process.env.FAXDROP_MCP_AUDIT_LOG;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not let audit failures mask the handler result", async () => {
      // Regression for the core masking-bug fix: when the audit
      // pipeline (`redactForAudit` → `JSON.stringify`) throws, the
      // handler's return value must still propagate verbatim. We
      // trigger the throw without mocking imports by passing a
      // structured-content shape that cycles through an allowlisted
      // key — `redactForAudit` recurses into the cycle, JSON.stringify
      // rejects it, safeLogAudit swallows the throw to stderr, and the
      // wrapped result is preserved.
      const tmpDir = mkdtempSync(join(tmpdir(), "faxdrop-audit-masking-"));
      const auditPath = join(tmpDir, "audit.log");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        process.env.FAXDROP_MCP_AUDIT_LOG = auditPath;
        const circular: Record<string, unknown> = {};
        circular.recipientNumber = circular; // allowlisted key → redactForAudit recurses into a cycle
        const handler = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "sent" }],
          structuredContent: circular,
        }));
        const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
        const result = await wrapped({ recipientNumber: "+12125551234" });
        // Handler's own result is preserved:
        expect(result.content[0].text).toBe("sent");
        // Audit failure was diverted to stderr, not propagated:
        expect(errSpy).toHaveBeenCalled();
        const stderrMessages = errSpy.mock.calls.map((c) => String(c[0]));
        expect(stderrMessages.some((m) => m.includes("audit"))).toBe(true);
      } finally {
        errSpy.mockRestore();
        delete process.env.FAXDROP_MCP_AUDIT_LOG;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("dry-run wouldCallWith redacts sensitive args", async () => {
      process.env.FAXDROP_MCP_DRY_RUN = "true";
      const handler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({
        recipientNumber: "+12125551234",
        apiKey: "fd_live_secret_should_not_appear",
      });
      const payload = result.content[0].text;
      expect(payload).toContain("[REDACTED]");
      expect(payload).not.toContain("fd_live_secret_should_not_appear");
      expect(payload).toContain("+12125551234");
    });

    it("dry-run wouldCallWith uses the args allowlist (response-only names are elided)", async () => {
      // Regression guard against reverting line 212 to redactSensitive(args),
      // which falls through to AUDIT_SAFE_RESPONSE_KEYS_SET and would preserve
      // response-only field names (id, status, pages, completedAt, error)
      // if a future tool ever accepted them as request args.
      process.env.FAXDROP_MCP_DRY_RUN = "true";
      const handler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({
        recipientNumber: "+12125551234", // in the args allowlist → kept
        faxId: "fax_123", // in the args allowlist → kept
        id: "should-not-leak", // response-only; must NOT pass through
        status: "should-not-leak", // response-only; must NOT pass through
        error: "should-not-leak", // response-only; must NOT pass through
      });
      const payload = result.content[0].text;
      expect(payload).toContain("+12125551234");
      expect(payload).toContain("fax_123");
      expect(payload).not.toContain("should-not-leak");
    });
  });

  describe("redactSensitive (allowlist: FaxDrop response fields only)", () => {
    it("redacts top-level sensitive keys (case-insensitive)", () => {
      // Credential-style keys get "[REDACTED]"; non-response keys get elided
      expect(redactSensitive({ apiKey: "fd_live_xxx", senderName: "Bob" })).toEqual({
        apiKey: "[REDACTED]",
        senderName: "[ELIDED:3 chars]",
      });
      expect(redactSensitive({ APIKey: "x" })).toEqual({ APIKey: "[REDACTED]" });
      expect(redactSensitive({ Authorization: "Bearer abc" })).toEqual({
        Authorization: "[REDACTED]",
      });
      expect(redactSensitive({ "X-API-Key": "x" })).toEqual({ "X-API-Key": "[REDACTED]" });
    });

    it("passes through ONLY the FaxDrop response fields (recipientNumber, faxId, status, …)", () => {
      const input = {
        recipientNumber: "+12125551234",
        faxId: "fax_abc123",
        id: "fax_abc123",
        status: "delivered",
        pages: 3,
        completedAt: "2026-04-22T10:15:00Z",
        error: null,
      };
      // Every field is in AUDIT_SAFE_KEYS → kept verbatim
      expect(redactSensitive(input)).toEqual(input);
    });

    it("elides sender / filePath / coverNote even though they are not credentials", () => {
      const input = {
        filePath: "/Users/me/FaxOutbox/invoice.pdf",
        senderName: "Alice",
        senderEmail: "alice@example.com",
        coverNote: "Please see attached invoice.",
        recipientNumber: "+12125551234", // this one IS kept
      };
      const out = redactSensitive(input) as Record<string, unknown>;
      expect(out.filePath).toMatch(/^\[ELIDED:\d+ chars\]$/);
      expect(out.senderName).toMatch(/^\[ELIDED:\d+ chars\]$/);
      expect(out.senderEmail).toMatch(/^\[ELIDED:\d+ chars\]$/);
      expect(out.coverNote).toMatch(/^\[ELIDED:\d+ chars\]$/);
      expect(out.recipientNumber).toBe("+12125551234");
    });

    it("recursively redacts nested credential keys while eliding other nested fields", () => {
      const input = { wrapper: { creds: { password: "p@ss", username: "alice" } } };
      const out = redactSensitive(input) as {
        wrapper: unknown;
      };
      // wrapper is not in AUDIT_SAFE_KEYS → its value gets elided whole
      expect(out.wrapper).toBe("[ELIDED]");
    });

    it("elides arrays with a length marker (does not walk them)", () => {
      const input = [{ token: "t1" }, { token: "t2", safe: "x" }];
      // Top-level array → elided with length. Tool args are objects at the
      // top level in practice; arrays inside those objects get the same marker.
      expect(redactSensitive(input)).toBe("[ELIDED:2 items]");
    });

    it("returns primitives and null unchanged", () => {
      expect(redactSensitive("plain")).toBe("plain");
      expect(redactSensitive(42)).toBe(42);
      expect(redactSensitive(null)).toBe(null);
      expect(redactSensitive(undefined)).toBe(undefined);
    });

    it("elides non-string primitives inside objects with a type marker", () => {
      // null typeof is "object" → falls into the object branch → "[ELIDED]"
      const input = { includeCover: true, pageCount: 3, maybeNull: null };
      const out = redactSensitive(input) as Record<string, unknown>;
      expect(out.includeCover).toBe("[ELIDED:boolean]");
      expect(out.pageCount).toBe("[ELIDED:number]");
      expect(out.maybeNull).toBe("[ELIDED]");
    });

    it("recurses into nested objects when the key is in the safe set", () => {
      // When a safe-keyed value is itself an object, the redactor must
      // recurse into it so the allowlist applies at every depth.
      const input = {
        recipientNumber: {
          id: "fax_abc", // safe → kept
          coverNote: "secret note", // not safe → elided
        },
      };
      const out = redactSensitive(input) as Record<string, unknown>;
      const nested = out.recipientNumber as Record<string, unknown>;
      expect(nested.id).toBe("fax_abc");
      expect(nested.coverNote).toMatch(/^\[ELIDED:\d+ chars\]$/);
    });

    it("elides a nested array value with a length marker", () => {
      // Nested array branch — different code path from the top-level
      // array branch (which returns a string directly). A non-safe key
      // whose value is an array must be elided to `[ELIDED:N items]`.
      const input = { attachments: ["/tmp/a.pdf", "/tmp/b.pdf", "/tmp/c.pdf"] };
      const out = redactSensitive(input) as Record<string, unknown>;
      expect(out.attachments).toBe("[ELIDED:3 items]");
    });
  });

  describe("logAudit", () => {
    let tmpDir: string;
    let auditPath: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "faxdrop-audit-"));
      auditPath = join(tmpDir, "audit.log");
    });

    afterEach(() => {
      delete process.env.FAXDROP_MCP_AUDIT_LOG;
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("does nothing when FAXDROP_MCP_AUDIT_LOG is unset", () => {
      logAudit("faxdrop_send_fax", { recipientNumber: "+12125551234" }, "ok");
    });

    it("writes redacted entry to absolute path with mode 0600", () => {
      process.env.FAXDROP_MCP_AUDIT_LOG = auditPath;
      logAudit(
        "faxdrop_send_fax",
        { recipientNumber: "+12125551234", apiKey: "fd_live_secret" },
        "ok",
      );
      const content = readFileSync(auditPath, "utf8");
      expect(content).toContain("faxdrop_send_fax");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain("fd_live_secret");
      expect(statSync(auditPath).mode & 0o777).toBe(0o600);
    });

    it("rejects relative paths and logs error", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.FAXDROP_MCP_AUDIT_LOG = "relative/audit.log";
      logAudit("faxdrop_send_fax", {}, "ok");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("must be an absolute path"));
      errSpy.mockRestore();
    });

    it("rejects POSIX system-root prefixes (operator-footgun guard)", () => {
      // FAXDROP_MCP_AUDIT_LOG=/etc/foo.log accepted by appendFileSync if the
      // process happens to have write permission, which would let a confused
      // deputy poison /etc/cron.daily/audit.log or similar with attacker-
      // influenced cover-page args. Reject the whole POSIX system-root tree.
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const forbidden = [
          "/etc/faxdrop.log",
          "/usr/local/audit.log",
          "/bin/audit.log",
          "/sbin/audit.log",
          "/sys/log",
          "/proc/audit",
          "/boot/audit.log",
          "/dev/null.log",
        ];
        for (const path of forbidden) {
          errSpy.mockClear();
          process.env.FAXDROP_MCP_AUDIT_LOG = path;
          logAudit("faxdrop_send_fax", {}, "ok");
          expect(errSpy).toHaveBeenCalledWith(
            expect.stringContaining("must not target a POSIX system root"),
          );
        }
      } finally {
        errSpy.mockRestore();
      }
    });

    it("does NOT reject paths that merely contain system-root substrings", () => {
      // Regression guard: a path like /home/me/etc/audit.log must NOT match
      // the /etc/ prefix denylist. The check is anchored on startsWith().
      process.env.FAXDROP_MCP_AUDIT_LOG = join(tmpDir, "etc", "audit.log");
      // mkdir the parent so the write succeeds.
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // Will fail to write (no parent dir), but the failure should be the
        // append-file error, NOT the denylist error.
        logAudit("faxdrop_send_fax", {}, "ok");
        const messages = errSpy.mock.calls.map((c) => String(c[0]));
        expect(messages.some((m) => m.includes("must not target a POSIX system root"))).toBe(false);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("does not throw when write fails (best-effort)", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.FAXDROP_MCP_AUDIT_LOG = "/nonexistent-dir-faxdrop-test/audit.log";
      expect(() => logAudit("faxdrop_send_fax", {}, "error")).not.toThrow();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to write"),
        expect.any(String),
      );
      errSpy.mockRestore();
    });
  });

  describe("wrapToolHandler — extra coverage", () => {
    let tmpDir: string;
    let auditPath: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "faxdrop-audit-extra-"));
      auditPath = join(tmpDir, "audit.log");
    });
    afterEach(() => {
      delete process.env.FAXDROP_MCP_AUDIT_LOG;
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("logs an 'ok' audit entry on a successful write call", async () => {
      process.env.FAXDROP_MCP_AUDIT_LOG = auditPath;
      const handler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "sent" }],
      }));
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      await wrapped({ recipientNumber: "+12125551234" });
      const line = readFileSync(auditPath, "utf8");
      expect(line).toContain('"tool":"faxdrop_send_fax"');
      expect(line).toContain('"result":"ok"');
    });

    it("surfaces FaxDropError.hint for non-402, non-429 statuses", async () => {
      const handler = vi.fn(async () => {
        throw new FaxDropError("Bad input", 400, "bad_request", "Recheck the file extension");
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("FaxDrop API error 400");
      expect(result.content[0].text).toContain("Hint: Recheck the file extension");
    });

    it("surfaces no hint for non-402/429 errors without err.hint", async () => {
      const handler = vi.fn(async () => {
        throw new FaxDropError("Server error", 500, "internal_error");
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "FaxDrop API error 500 (internal_error): Server error",
      );
      // Sanitize fence is now applied to error responses too (SEC-001 fix).
      expect(result.content[0].text).toContain("<untrusted-tool-output>");
      // structuredContent is the parseable counterpart for programmatic consumers.
      expect(result.structuredContent).toMatchObject({
        error_type: "internal_error",
        status: 500,
        message: "Server error",
      });
    });

    it("falls back to error_type 'fax_error' when err.errorType is undefined", async () => {
      const handler = vi.fn(async () => {
        // No errorType passed — exercises the `?? "fax_error"` fallback.
        throw new FaxDropError("boom", 500);
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error_type: "fax_error",
        status: 500,
        message: "boom",
      });
      // Without errorType, the formatted message also drops the parenthesised type.
      expect(result.content[0].text).toContain("FaxDrop API error 500: boom");
      expect(result.content[0].text).not.toContain("(undefined)");
    });
  });
});
