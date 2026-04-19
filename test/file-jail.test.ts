import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetOutboxCache, assertInsideOutbox, getOutboxDir } from "../src/file-jail.js";

describe("file-jail", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "faxdrop-jail-")));
    delete process.env.FAXDROP_MCP_WORK_DIR;
    _resetOutboxCache();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.FAXDROP_MCP_WORK_DIR;
    _resetOutboxCache();
  });

  describe("getOutboxDir", () => {
    it("uses FAXDROP_MCP_WORK_DIR when set, and creates it (mode 0o700)", () => {
      const target = join(tmpDir, "outbox-from-env");
      process.env.FAXDROP_MCP_WORK_DIR = target;
      expect(getOutboxDir()).toBe(target);
      const stat = statSync(target);
      expect(stat.mode & 0o777).toBe(0o700);
    });

    it("rejects a relative FAXDROP_MCP_WORK_DIR", () => {
      process.env.FAXDROP_MCP_WORK_DIR = "relative/path";
      expect(() => getOutboxDir()).toThrow(/must be an absolute path/);
    });

    it("returns ~/FaxOutbox by default and ensures it exists (mode 0o700)", () => {
      // Redirect HOME to tmpDir so the test doesn't pollute the real home.
      const realHome = process.env.HOME;
      process.env.HOME = tmpDir;
      try {
        const dir = getOutboxDir();
        expect(dir).toBe(join(tmpDir, "FaxOutbox"));
        const stat = statSync(dir);
        expect(stat.mode & 0o777).toBe(0o700);
      } finally {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
      }
    });
  });

  describe("assertInsideOutbox", () => {
    it("accepts a path inside the outbox", () => {
      process.env.FAXDROP_MCP_WORK_DIR = tmpDir;
      const inside = join(tmpDir, "doc.pdf");
      writeFileSync(inside, "x");
      expect(() => assertInsideOutbox(inside)).not.toThrow();
    });

    it("accepts the outbox dir itself", () => {
      process.env.FAXDROP_MCP_WORK_DIR = tmpDir;
      expect(() => assertInsideOutbox(tmpDir)).not.toThrow();
    });

    it("rejects a path outside the outbox", () => {
      const outboxDir = join(tmpDir, "outbox");
      process.env.FAXDROP_MCP_WORK_DIR = outboxDir;
      const outside = join(tmpDir, "other", "secret.pdf");
      expect(() => assertInsideOutbox(outside)).toThrow(/outside the outbox/);
    });

    it("rejects sibling paths that share a prefix (no `outbox/` confusion with `outbox-other/`)", () => {
      const outboxDir = join(tmpDir, "outbox");
      process.env.FAXDROP_MCP_WORK_DIR = outboxDir;
      const sibling = join(tmpDir, "outbox-other", "doc.pdf");
      expect(() => assertInsideOutbox(sibling)).toThrow(/outside the outbox/);
    });

    it("handles an outbox path that already ends with the path separator", () => {
      // Exercises the `outbox.endsWith(sep) ? outbox : outbox + sep` branch
      // — without this the prefix test would double the separator.
      const outboxDir = join(tmpDir, "outbox") + "/";
      process.env.FAXDROP_MCP_WORK_DIR = outboxDir;
      const inside = join(tmpDir, "outbox", "doc.pdf");
      expect(() => assertInsideOutbox(inside)).not.toThrow();
    });
  });

  describe("getOutboxDir caching", () => {
    it("returns the cached canonical path on the second call (no re-mkdir)", () => {
      const target = join(tmpDir, "outbox-cache");
      process.env.FAXDROP_MCP_WORK_DIR = target;
      const first = getOutboxDir();
      const second = getOutboxDir();
      expect(first).toBe(second);
    });

    it("re-resolves when the FAXDROP_MCP_WORK_DIR value changes between calls", () => {
      const targetA = join(tmpDir, "outbox-A");
      const targetB = join(tmpDir, "outbox-B");
      process.env.FAXDROP_MCP_WORK_DIR = targetA;
      const a = getOutboxDir();
      process.env.FAXDROP_MCP_WORK_DIR = targetB;
      const b = getOutboxDir();
      expect(a).not.toBe(b);
      expect(b).toContain("outbox-B");
    });
  });
});
