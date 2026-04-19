import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetOutboxCache } from "../src/file-jail.js";
import { FileIoError, openInsideOutbox } from "../src/file-io.js";

describe("openInsideOutbox", () => {
  let tmpDir: string;
  let pdfPath: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "faxdrop-fileio-")));
    process.env.FAXDROP_MCP_WORK_DIR = tmpDir;
    _resetOutboxCache();
    pdfPath = join(tmpDir, "doc.pdf");
    writeFileSync(pdfPath, "%PDF-1.4\n%fake\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.FAXDROP_MCP_WORK_DIR;
    _resetOutboxCache();
  });

  it("opens a regular file inside the outbox and returns its bytes", async () => {
    const opened = await openInsideOutbox(pdfPath);
    expect(opened.bytes.toString()).toBe("%PDF-1.4\n%fake\n");
    expect(opened.filename).toBe("doc.pdf");
    expect(opened.mimeType).toBe("application/pdf");
  });

  it("rejects a relative path", async () => {
    await expect(openInsideOutbox("relative/doc.pdf")).rejects.toMatchObject({
      name: "FileIoError",
      message: expect.stringContaining("must be absolute"),
    });
  });

  it("rejects an unsupported extension", async () => {
    const exe = join(tmpDir, "x.exe");
    writeFileSync(exe, "MZ");
    await expect(openInsideOutbox(exe)).rejects.toMatchObject({
      name: "FileIoError",
      message: expect.stringContaining("Unsupported file type"),
    });
  });

  it("rejects a leaf symlink (anti symlink-target swap)", async () => {
    const realFile = join(tmpDir, "secret.txt");
    writeFileSync(realFile, "PII here");
    const symlinkPdf = join(tmpDir, "innocent.pdf");
    symlinkSync(realFile, symlinkPdf);
    await expect(openInsideOutbox(symlinkPdf)).rejects.toMatchObject({
      name: "FileIoError",
      message: expect.stringContaining("must be a regular file, not a symlink"),
    });
  });

  it("rejects a missing file with a clear error", async () => {
    await expect(openInsideOutbox(join(tmpDir, "does-not-exist.pdf"))).rejects.toMatchObject({
      name: "FileIoError",
      message: expect.stringContaining("Cannot access file"),
    });
  });

  it("rejects a file > 10MB (early via stat)", async () => {
    const big = join(tmpDir, "big.pdf");
    writeFileSync(big, Buffer.alloc(11 * 1024 * 1024, 0));
    await expect(openInsideOutbox(big)).rejects.toMatchObject({
      name: "FileIoError",
      message: expect.stringContaining("File too large"),
    });
  });

  it("rejects a file outside the outbox", async () => {
    // Create a sibling tmp dir that is NOT the outbox.
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "faxdrop-outside-")));
    const outside = join(outsideDir, "doc.pdf");
    writeFileSync(outside, "%PDF-1.4\n");
    try {
      await expect(openInsideOutbox(outside)).rejects.toMatchObject({
        name: "FileIoError",
        message: expect.stringContaining("outside the outbox"),
      });
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("FileIoError", () => {
  it("captures message + hint", () => {
    const e = new FileIoError("boom", "do this instead");
    expect(e.message).toBe("boom");
    expect(e.hint).toBe("do this instead");
    expect(e.name).toBe("FileIoError");
  });
});
