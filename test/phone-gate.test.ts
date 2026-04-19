import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetPairedCache,
  checkGate,
  getAllowedCountries,
  getAllowedTypes,
  getMode,
  isPaired,
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
    it("writes mode 0o600", () => {
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

    it("refuses to write paired.json when the prior read failed (no clobber)", () => {
      // Pre-create the file with content the load can't read (mode 0).
      const file = join(stateDir, "paired.json");
      writeFileSync(file, JSON.stringify(["+18005551212"]));
      // chmod 0 → readFileSync raises EACCES.
      // (skipped: chmod imported separately at the test top — inline here.)
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- inline import for test isolation
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
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
