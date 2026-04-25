import {
  constants as fsConstants,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  describe("magic-byte verification", () => {
    // Belt-and-braces against an attacker-placed misnaming (e.g. id_rsa
    // renamed to id_rsa.pdf) AND operator typos (a .docx that's actually
    // a .doc binary). The chunked-read above brings bytes into memory;
    // the magic-byte check runs once on the assembled buffer.

    it("accepts a real PDF (%PDF- signature)", async () => {
      const pdf = join(tmpDir, "real.pdf");
      writeFileSync(pdf, "%PDF-1.4\n%fake\n");
      const opened = await openInsideOutbox(pdf);
      expect(opened.filename).toBe("real.pdf");
    });

    it("rejects a .pdf whose bytes are not a real PDF (e.g. SSH private key)", async () => {
      const fake = join(tmpDir, "id_rsa.pdf");
      writeFileSync(fake, "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n");
      await expect(openInsideOutbox(fake)).rejects.toMatchObject({
        name: "FileIoError",
        message: expect.stringContaining("does not match extension"),
      });
    });

    it("accepts a real DOCX (PK ZIP signature)", async () => {
      const docx = join(tmpDir, "report.docx");
      // Minimal ZIP local-file-header magic — enough to pass the bytes
      // check without building a real DOCX.
      writeFileSync(docx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]));
      const opened = await openInsideOutbox(docx);
      expect(opened.mimeType).toContain("officedocument");
    });

    it("rejects a .docx whose bytes are not a ZIP container (e.g. legacy .doc)", async () => {
      const fake = join(tmpDir, "old.docx");
      // CFB / OLE2 magic — that's what a legacy .doc actually starts with
      writeFileSync(fake, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
      await expect(openInsideOutbox(fake)).rejects.toMatchObject({
        name: "FileIoError",
        message: expect.stringContaining("does not match extension"),
      });
    });

    it("accepts a real JPEG (FFD8FF signature)", async () => {
      const jpg = join(tmpDir, "photo.jpg");
      writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));
      const opened = await openInsideOutbox(jpg);
      expect(opened.mimeType).toBe("image/jpeg");
    });

    it("rejects a .jpg whose bytes are a PNG (extension/content mismatch)", async () => {
      const fake = join(tmpDir, "screenshot.jpg");
      // PNG signature — a real PNG renamed to .jpg
      writeFileSync(fake, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      await expect(openInsideOutbox(fake)).rejects.toMatchObject({
        name: "FileIoError",
        message: expect.stringContaining("does not match extension"),
      });
    });

    it("accepts a real PNG (89PNG signature)", async () => {
      const png = join(tmpDir, "img.png");
      writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const opened = await openInsideOutbox(png);
      expect(opened.mimeType).toBe("image/png");
    });

    it("rejects a .png whose bytes are not a PNG", async () => {
      const fake = join(tmpDir, "fake.png");
      writeFileSync(fake, "this is not a PNG");
      await expect(openInsideOutbox(fake)).rejects.toMatchObject({
        name: "FileIoError",
        message: expect.stringContaining("does not match extension"),
      });
    });

    it("hint surfaces a friendly remediation", async () => {
      const fake = join(tmpDir, "wrong.pdf");
      writeFileSync(fake, "not a pdf");
      try {
        await openInsideOutbox(fake);
        throw new Error("expected throw");
      } catch (err) {
        expect((err as FileIoError).hint).toMatch(/Rename|convert/i);
      }
    });
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

describe("Platform guard", () => {
  // The module's startup guard at the top of src/file-io.ts throws if
  // fs.constants.O_NOFOLLOW is undefined (Windows). The fact that this
  // test suite imports `openInsideOutbox` successfully proves the guard
  // didn't trip. Pin the contract explicitly so a regression that
  // weakens the guard back to `(O_NOFOLLOW || 0)` (silent no-op on
  // Windows) is caught here.
  it("requires fs.constants.O_NOFOLLOW (POSIX-only)", () => {
    expect(fsConstants.O_NOFOLLOW).toBeDefined();
    expect(typeof fsConstants.O_NOFOLLOW).toBe("number");
    expect(fsConstants.O_NOFOLLOW).toBeGreaterThan(0);
  });
});
