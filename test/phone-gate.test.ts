import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetPairedCache,
  checkGate,
  getAllowedCountries,
  getAllowedTypes,
  getMode,
  isPaired,
  isValidE164,
  pairNumber,
  validateAll,
  validateTypeAndCountry,
} from "../src/phone-gate.js";

const ENV_KEYS = [
  "FAXDROP_MCP_NUMBER_GATE",
  "FAXDROP_MCP_ALLOWED_TYPES",
  "FAXDROP_MCP_ALLOWED_COUNTRIES",
  "FAXDROP_MCP_STATE_DIR",
] as const;

describe("phone-gate", () => {
  let stateDir: string;

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    stateDir = mkdtempSync(join(tmpdir(), "faxdrop-gate-"));
    process.env.FAXDROP_MCP_STATE_DIR = stateDir;
    _resetPairedCache();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    rmSync(stateDir, { recursive: true, force: true });
    _resetPairedCache();
  });

  describe("getMode", () => {
    it("defaults to 'pairing' when env is unset (HITL approve-by-default)", () => {
      expect(getMode()).toBe("pairing");
    });
    it("accepts 'open', 'pairing', 'closed' (any case)", () => {
      process.env.FAXDROP_MCP_NUMBER_GATE = "OPEN";
      expect(getMode()).toBe("open");
      process.env.FAXDROP_MCP_NUMBER_GATE = "Pairing";
      expect(getMode()).toBe("pairing");
      process.env.FAXDROP_MCP_NUMBER_GATE = "closed";
      expect(getMode()).toBe("closed");
    });
    it("falls back to 'closed' on unknown values (fail-safe)", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.FAXDROP_MCP_NUMBER_GATE = "permissive";
      expect(getMode()).toBe("closed");
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unknown FAXDROP_MCP_NUMBER_GATE"),
      );
      errSpy.mockRestore();
    });
  });

  describe("getAllowedTypes / getAllowedCountries", () => {
    it("returns the US/CA + territories defaults", () => {
      expect(getAllowedCountries()).toEqual(["US", "CA", "PR", "GU", "VI", "AS", "MP"]);
      expect(getAllowedTypes()).toEqual([
        "FIXED_LINE",
        "FIXED_LINE_OR_MOBILE",
        "VOIP",
        "TOLL_FREE",
      ]);
    });
    it("env override (countries upper-cased, whitespace trimmed)", () => {
      process.env.FAXDROP_MCP_ALLOWED_COUNTRIES = "us, gb, fr";
      expect(getAllowedCountries()).toEqual(["US", "GB", "FR"]);
    });
    it("env override (types)", () => {
      process.env.FAXDROP_MCP_ALLOWED_TYPES = "FIXED_LINE, MOBILE";
      expect(getAllowedTypes()).toEqual(["FIXED_LINE", "MOBILE"]);
    });
    it("env override (types) is upper-cased — lowercase input still matches libphonenumber", () => {
      process.env.FAXDROP_MCP_ALLOWED_TYPES = "fixed_line, voip";
      expect(getAllowedTypes()).toEqual(["FIXED_LINE", "VOIP"]);
    });
    it("empty env value falls back to defaults", () => {
      process.env.FAXDROP_MCP_ALLOWED_COUNTRIES = " , ,";
      expect(getAllowedCountries()).toEqual(["US", "CA", "PR", "GU", "VI", "AS", "MP"]);
    });
  });

  describe("validateTypeAndCountry — layer 1 (TYPE)", () => {
    it("rejects an unparseable string", () => {
      const r = validateTypeAndCountry("garbage");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.layer).toBe("parse");
    });
    it("rejects a parseable but invalid number (e.g. wrong length)", () => {
      // libphonenumber parses "+12" without throwing, but isValid() returns
      // false — exercises the second `parse` branch (isValid check).
      const r = validateTypeAndCountry("+12");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.layer).toBe("parse");
    });
    it("rejects a MOBILE-typed number (MOBILE not in defaults)", () => {
      // In the US, libphonenumber returns FIXED_LINE_OR_MOBILE for nearly
      // every consumer prefix (which IS in defaults). Use an FR mobile
      // (+33 6 …, classified as MOBILE) and force-allow FR so the country
      // check passes — leaving the type check as the failing layer.
      process.env.FAXDROP_MCP_ALLOWED_COUNTRIES = "FR";
      const r = validateTypeAndCountry("+33612345678");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.layer).toBe("type");
        expect(r.reason).toContain("MOBILE");
      }
    });
    it("accepts a US toll-free number (covered by TOLL_FREE)", () => {
      const r = validateTypeAndCountry("+18005551212");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.country).toBe("US");
        expect(r.type).toBe("TOLL_FREE");
      }
    });
  });

  describe("validateTypeAndCountry — layer 2 (COUNTRY)", () => {
    it("rejects a French landline (FR not in defaults)", () => {
      const r = validateTypeAndCountry("+33144556677");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.layer).toBe("country");
        expect(r.reason).toContain("FR");
      }
    });
    it("accepts CA with default countries", () => {
      const r = validateTypeAndCountry("+14165551212");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.country).toBe("CA");
    });
    it("accepts PR (US territory) with default countries", () => {
      const r = validateTypeAndCountry("+17875551212");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.country).toBe("PR");
    });
  });

  describe("checkGate — layer 3 (per-number policy)", () => {
    it("'open' lets every number through", () => {
      process.env.FAXDROP_MCP_NUMBER_GATE = "open";
      expect(checkGate("+12125551234")).toEqual({ ok: true });
    });
    it("'pairing' rejects unknown numbers with a hint pointing to faxdrop_pair_number", () => {
      process.env.FAXDROP_MCP_NUMBER_GATE = "pairing";
      const r = checkGate("+12125551234");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.layer).toBe("gate");
        expect(r.hint).toContain("faxdrop_pair_number");
      }
    });
    it("'closed' rejects unknown numbers with a hint pointing to manual edit", () => {
      process.env.FAXDROP_MCP_NUMBER_GATE = "closed";
      const r = checkGate("+12125551234");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.hint).toContain("manually");
    });
    it("'pairing' accepts a number that's in paired.json", () => {
      process.env.FAXDROP_MCP_NUMBER_GATE = "pairing";
      pairNumber("+12125551234");
      _resetPairedCache();
      expect(checkGate("+12125551234")).toEqual({ ok: true });
    });
    it("'closed' accepts a number that's in paired.json", () => {
      process.env.FAXDROP_MCP_NUMBER_GATE = "closed";
      pairNumber("+12125551234");
      _resetPairedCache();
      expect(checkGate("+12125551234")).toEqual({ ok: true });
    });
  });

  describe("paired.json storage", () => {
    // POSIX-only: chmodSync + statSync().mode are unreliable on Windows
    // (libuv only toggles the read-only attribute; mode bits are fabricated).
    // The hardening behaviors themselves still work on Windows, but the tests
    // that depend on enforced mode bits / EACCES from chmod can't validate
    // them there.
    const itPosix = process.platform === "win32" ? it.skip : it;

    itPosix("writes mode 0o600", () => {
      pairNumber("+12125551234");
      const stat = statSync(join(stateDir, "paired.json"));
      expect(stat.mode & 0o777).toBe(0o600);
    });
    it("survives a cache reset (persisted to disk)", () => {
      pairNumber("+12125551234");
      _resetPairedCache();
      expect(isPaired("+12125551234")).toBe(true);
    });
    it("ignores a paired.json with the wrong shape (not an array)", () => {
      writeFileSync(join(stateDir, "paired.json"), JSON.stringify({ not: "an array" }));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(isPaired("+12125551234")).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unexpected shape"));
      errSpy.mockRestore();
    });
    it("ignores a paired.json with non-string entries", () => {
      writeFileSync(join(stateDir, "paired.json"), JSON.stringify(["+12125551234", 42]));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(isPaired("+12125551234")).toBe(false);
      errSpy.mockRestore();
    });
    it("logs and returns empty on a corrupted JSON file", () => {
      writeFileSync(join(stateDir, "paired.json"), "{not valid json");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(isPaired("+12125551234")).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("failed to read"));
      errSpy.mockRestore();
    });
    it("rejects a relative FAXDROP_MCP_STATE_DIR", () => {
      process.env.FAXDROP_MCP_STATE_DIR = "relative/path";
      expect(() => pairNumber("+12125551234")).toThrow(/must be an absolute path/);
    });

    itPosix("refuses to write paired.json when the prior read failed (no clobber)", () => {
      // Pre-create the file with content the load can't read (mode 0).
      const file = join(stateDir, "paired.json");
      writeFileSync(file, JSON.stringify(["+18005551212"]));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // chmod 0 → readFileSync raises EACCES.
      chmodSync(file, 0o000);
      try {
        // First isPaired triggers loadPaired → EACCES → pairedLoaded stays false.
        expect(isPaired("+12125551234")).toBe(false);
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("failed to read"));
        // pairNumber must throw now, NOT silently overwrite the unreadable file.
        expect(() => pairNumber("+12125551234")).toThrow(/Refusing to overwrite/);
      } finally {
        chmodSync(file, 0o600);
        errSpy.mockRestore();
      }
      // The original on-disk content is intact.
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["+18005551212"]);
    });
    it("pairing the same number twice is idempotent (no duplicates)", () => {
      pairNumber("+12125551234");
      pairNumber("+12125551234");
      const raw = readFileSync(join(stateDir, "paired.json"), "utf8");
      expect(JSON.parse(raw)).toEqual(["+12125551234"]);
    });
    it("removes the .lock file after a successful pair", () => {
      pairNumber("+12125551234");
      const lockFile = join(stateDir, "paired.json.lock");
      expect(existsSync(lockFile)).toBe(false);
    });
    it("merges concurrent on-disk additions instead of clobbering them", () => {
      // Simulate a peer process that paired a different number AFTER our
      // loadPaired() but BEFORE our rename. The merge-under-lock must
      // preserve both, not just our snapshot.
      pairNumber("+12125551234");
      _resetPairedCache();
      // Peer writes a new number directly to disk (between our load and write):
      writeFileSync(
        join(stateDir, "paired.json"),
        JSON.stringify(["+12125551234", "+19998887777"]),
      );
      pairNumber("+13105551111"); // our pair
      const onDisk = JSON.parse(readFileSync(join(stateDir, "paired.json"), "utf8")) as string[];
      expect(onDisk).toEqual(["+12125551234", "+13105551111", "+19998887777"].sort());
    });
    itPosix("acquireLock recovers a stale lock (mtime > staleMs) instead of timing out", () => {
      // Manually create a stale lock file with old mtime, then call pairNumber.
      // The lock-acquire path must reclaim it on the first retry instead of
      // waiting out the full timeout.
      const lockFile = join(stateDir, "paired.json.lock");
      const fd = openSync(lockFile, "wx", 0o600);
      closeSync(fd);
      // Set mtime to >30s ago (staleMs default).
      const oldTs = (Date.now() - 60_000) / 1000;
      utimesSync(lockFile, oldTs, oldTs);
      // Now pair — should reclaim the stale lock and succeed.
      const t0 = Date.now();
      pairNumber("+12125551234");
      // Reclaim happens in the first retry iteration → must finish well under
      // the 3 s default timeout (give us 1 s of headroom for slow CI).
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(isPaired("+12125551234")).toBe(true);
      // Lock file is gone after success.
      expect(existsSync(lockFile)).toBe(false);
    });
    itPosix(
      "acquireLock throws a timeout when a fresh lock is held by another process",
      () => {
        // Hold a non-stale lock; pairNumber must time out (not steal it).
        const lockFile = join(stateDir, "paired.json.lock");
        const fd = openSync(lockFile, "wx", 0o600);
        try {
          // Override timeout via the module's defaults isn't possible — but we
          // can detect the throw by setting a short busy-wait. The lock is
          // fresh, so after ~3 s acquireLock should throw "lock timeout".
          // Mock clock would be cleaner; for an integration test we rely on
          // the real timeout.
          const t0 = Date.now();
          expect(() => pairNumber("+12125551234")).toThrow(/pair-number lock timeout/);
          // Should be near 3 s (default), give wide margin for CI jitter.
          expect(Date.now() - t0).toBeGreaterThanOrEqual(2_500);
        } finally {
          closeSync(fd);
          try {
            unlinkSync(lockFile);
          } catch {
            /* may not exist */
          }
        }
      },
      10_000, // generous test timeout (default 5 s would race the 3 s lock timeout)
    );
    itPosix("does NOT pair the number in memory if the disk write fails (transactional)", () => {
      // Pair one number successfully (cache is warm + pairedLoaded=true).
      pairNumber("+12125551234");
      // Strip write perms on the state dir → writeFileSync(tmp) raises EACCES.
      // The new number must NOT appear in isPaired() — pairing in memory while
      // the file write failed would cause the next process restart to silently
      // undo the addition.
      chmodSync(stateDir, 0o500);
      try {
        expect(() => pairNumber("+13105551111")).toThrow();
        expect(isPaired("+13105551111")).toBe(false);
        // The previously paired number is unaffected.
        expect(isPaired("+12125551234")).toBe(true);
      } finally {
        chmodSync(stateDir, 0o700);
      }
      // Disk state matches in-memory state: only the original number persisted.
      expect(JSON.parse(readFileSync(join(stateDir, "paired.json"), "utf8"))).toEqual([
        "+12125551234",
      ]);
    });
  });

  describe("isValidE164", () => {
    it("accepts a valid E.164 number", () => {
      expect(isValidE164("+12125551234")).toBe(true);
    });
    it("rejects garbage", () => {
      expect(isValidE164("not a phone")).toBe(false);
    });
    it("rejects an empty string", () => {
      expect(isValidE164("")).toBe(false);
    });
  });

  describe("validateTypeAndCountry — additional parse paths", () => {
    it("returns layer='parse' on an unparseable input (catch branch)", () => {
      const r = validateTypeAndCountry("");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.layer).toBe("parse");
    });
    it("returns layer='parse' (parsed but isValid()=false) for +10000000000", () => {
      // libphonenumber parses this (enough digits, leading +) but isValid()
      // returns false — exercises the !phone.isValid() branch (distinct from
      // the catch branch above).
      const r = validateTypeAndCountry("+10000000000");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.layer).toBe("parse");
        expect(r.reason).toContain("Invalid phone number");
      }
    });
  });

  describe("validateAll (full 3-layer pipeline)", () => {
    it("fails on layer 1 (type) before checking country or gate", () => {
      process.env.FAXDROP_MCP_ALLOWED_COUNTRIES = "FR";
      process.env.FAXDROP_MCP_NUMBER_GATE = "open";
      const r = validateAll("+33612345678"); // FR mobile
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.layer).toBe("type");
    });
    it("fails on layer 2 (country) before checking gate", () => {
      process.env.FAXDROP_MCP_NUMBER_GATE = "open";
      const r = validateAll("+33144556677"); // FR landline (passes type, fails country)
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.layer).toBe("country");
    });
    it("fails on layer 3 (gate) when types and country pass but number isn't paired", () => {
      process.env.FAXDROP_MCP_NUMBER_GATE = "closed";
      const r = validateAll("+12125551234");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.layer).toBe("gate");
    });
    it("passes all 3 layers in 'open' mode for a US toll-free number", () => {
      process.env.FAXDROP_MCP_NUMBER_GATE = "open";
      const r = validateAll("+18005551212");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.country).toBe("US");
        expect(r.type).toBe("TOLL_FREE");
      }
    });
  });
});
