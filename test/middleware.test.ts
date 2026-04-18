import {
  isDryRun,
  wrapToolHandler,
  redactSensitive,
  logAudit,
} from "../src/middleware.js";
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
      const handler = jest.fn(async () => ({
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
      const handler = jest.fn(async () => ({
        content: [{ type: "text" as const, text: "real-status" }],
      }));
      const wrapped = wrapToolHandler("faxdrop_get_fax_status", handler);
      const result = await wrapped({ faxId: "fax_abc" });
      expect(handler).toHaveBeenCalled();
      expect(result.content[0].text).toBe("real-status");
    });

    it("returns dry-run response without calling handler when DRY_RUN=true on write", async () => {
      process.env.FAXDROP_MCP_DRY_RUN = "true";
      const handler = jest.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({ recipientNumber: "+12125551234" });
      expect(handler).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("dryRun");
      expect(result.content[0].text).toContain("faxdrop_send_fax");
    });

    it("converts FaxDropError 402 to isError with credits hint", async () => {
      const handler = jest.fn(async () => {
        throw new FaxDropError("No credits", 402, "payment_required");
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("FaxDrop API error 402");
      expect(result.content[0].text).toContain("No fax credits remaining");
    });

    it("converts FaxDropError 429 to isError with retry-after hint", async () => {
      const handler = jest.fn(async () => {
        throw new FaxDropError("Slow down", 429, "rate_limited", undefined, 30);
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("FaxDrop API error 429");
      expect(result.content[0].text).toContain("retry in 30s");
    });

    it("converts FaxDropError 400 with hint surfaced", async () => {
      const handler = jest.fn(async () => {
        throw new FaxDropError("File too big", 400, "bad_request", "Compress to <10MB.");
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      const result = await wrapped({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Hint: Compress to <10MB.");
    });

    it("re-throws non-FaxDrop errors unchanged", async () => {
      const handler = jest.fn(async () => {
        throw new Error("unexpected");
      });
      const wrapped = wrapToolHandler("faxdrop_send_fax", handler);
      await expect(wrapped({})).rejects.toThrow("unexpected");
    });

    it("dry-run wouldCallWith redacts sensitive args", async () => {
      process.env.FAXDROP_MCP_DRY_RUN = "true";
      const handler = jest.fn(async () => ({
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
  });

  describe("redactSensitive", () => {
    it("redacts top-level sensitive keys (case-insensitive)", () => {
      expect(redactSensitive({ apiKey: "fd_live_xxx", senderName: "Bob" })).toEqual({
        apiKey: "[REDACTED]",
        senderName: "Bob",
      });
      expect(redactSensitive({ APIKey: "x" })).toEqual({ APIKey: "[REDACTED]" });
      expect(redactSensitive({ Authorization: "Bearer abc" })).toEqual({
        Authorization: "[REDACTED]",
      });
      expect(redactSensitive({ "X-API-Key": "x" })).toEqual({ "X-API-Key": "[REDACTED]" });
    });

    it("recursively redacts nested objects", () => {
      const input = { wrapper: { creds: { password: "p@ss", username: "alice" } } };
      const out = redactSensitive(input) as {
        wrapper: { creds: { password: string; username: string } };
      };
      expect(out.wrapper.creds.password).toBe("[REDACTED]");
      expect(out.wrapper.creds.username).toBe("alice");
    });

    it("walks arrays", () => {
      const input = [{ token: "t1" }, { token: "t2", safe: "x" }];
      expect(redactSensitive(input)).toEqual([
        { token: "[REDACTED]" },
        { token: "[REDACTED]", safe: "x" },
      ]);
    });

    it("returns primitives and null unchanged", () => {
      expect(redactSensitive("plain")).toBe("plain");
      expect(redactSensitive(42)).toBe(42);
      expect(redactSensitive(null)).toBe(null);
      expect(redactSensitive(undefined)).toBe(undefined);
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
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      process.env.FAXDROP_MCP_AUDIT_LOG = "relative/audit.log";
      logAudit("faxdrop_send_fax", {}, "ok");
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("must be an absolute path"),
      );
      errSpy.mockRestore();
    });

    it("does not throw when write fails (best-effort)", () => {
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      process.env.FAXDROP_MCP_AUDIT_LOG = "/nonexistent-dir-faxdrop-test/audit.log";
      expect(() => logAudit("faxdrop_send_fax", {}, "error")).not.toThrow();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to write"),
        expect.any(String),
      );
      errSpy.mockRestore();
    });
  });
});
