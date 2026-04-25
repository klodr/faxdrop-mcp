/**
 * Outbox-jailed, TOCTOU-safe file reader for fax uploads.
 *
 * Centralises every filesystem precaution that used to live half in the
 * client and half in the tool layer: symlink hardening (lstat + realpath +
 * O_NOFOLLOW), outbox jail enforcement, extension allow-list, and chunked
 * read with a continuous size cap. Returns the file as bytes — callers
 * (the FaxDrop HTTP client, or any future tool that needs the same
 * guarantees) never touch the filesystem themselves.
 *
 * Threat model:
 * - Leaf symlink targeting a forbidden file (e.g. /etc/passwd):
 *   rejected by lstat before realpath.
 * - Symlink-swapped between lstat and open: rejected at open by
 *   O_NOFOLLOW (ELOOP).
 * - File outside the outbox: rejected by assertInsideOutbox(canonical).
 * - File grows during read (TOCTOU): chunked read enforces the cap
 *   continuously, allocating at most MAX_FILE_BYTES + one chunk.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { assertInsideOutbox } from "./file-jail.js";

const ALLOWED_EXTS = new Set([".pdf", ".docx", ".jpeg", ".jpg", ".png"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

/**
 * Magic-byte signatures used to confirm that the bytes actually carry the
 * format the extension advertises. Catches both an attacker-placed
 * misnaming (`id_rsa` renamed to `id_rsa.pdf`) AND operator typos
 * (a `.docx` that's actually a legacy `.doc` binary). Cheap because the
 * file is already in memory after the chunked read.
 *
 * Signatures (per ISO / Adobe / Microsoft / W3C / JFIF):
 *   PDF   →  "%PDF-"               25 50 44 46 2D
 *   DOCX  →  "PK\x03\x04" or "PK\x05\x06" (empty zip) — DOCX is a ZIP container
 *   JPEG  →  FF D8 FF                                  (any APP marker variant)
 *   PNG   →  89 50 4E 47 0D 0A 1A 0A
 *
 * Returned as ranges (per-extension list of byte arrays) so the check
 * stays a simple `bytes.startsWith(any-signature)`.
 */
const MAGIC_BY_EXT: Record<string, readonly Uint8Array[]> = {
  ".pdf": [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], // %PDF-
  ".docx": [
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04 (standard ZIP local file header)
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]), // PK\x05\x06 (empty ZIP — accepted defensively)
  ],
  ".jpeg": [new Uint8Array([0xff, 0xd8, 0xff])],
  ".jpg": [new Uint8Array([0xff, 0xd8, 0xff])],
  ".png": [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
};

function bytesStartsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function magicMatches(ext: string, bytes: Uint8Array): boolean {
  const sigs = MAGIC_BY_EXT[ext];
  if (!sigs) return false;
  return sigs.some((sig) => bytesStartsWith(bytes, sig));
}

// One-shot startup guard: O_NOFOLLOW is the TOCTOU barrier between
// realpath() and open(), and it is undefined on Windows (the constant
// resolves to `undefined`, which would silently disable the flag via
// `(fsConstants.O_NOFOLLOW || 0)`). faxdrop-mcp is documented Unix-only;
// rather than degrade to lstat+realpath alone on Windows, refuse to
// start. Operators who need Windows support must use WSL.
//
// The check runs once at module load: throwing here surfaces a clear
// startup error in the MCP launcher logs instead of a confusing
// "everything works but symlink TOCTOU is open" runtime drift.
/* v8 ignore start -- guard runs once at module load on Windows only;
   POSIX CI never hits this branch and a faithful test would require a
   second test process with a stubbed `fs.constants` module. */
if (fsConstants.O_NOFOLLOW === undefined) {
  throw new Error(
    "faxdrop-mcp requires fs.constants.O_NOFOLLOW to enforce its symlink TOCTOU guard. " +
      "This platform does not expose O_NOFOLLOW (Windows). Use WSL or another POSIX environment.",
  );
}
/* v8 ignore stop */

export class FileIoError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "FileIoError";
  }
}

export interface OpenedFile {
  bytes: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * Open a file inside the outbox jail, validate it, and return its bytes.
 * Throws `FileIoError` (with a user-friendly message + hint) on any
 * validation or I/O failure. Caller wraps into the appropriate
 * domain-specific error.
 */
export async function openInsideOutbox(filePath: string): Promise<OpenedFile> {
  if (!isAbsolute(filePath)) {
    throw new FileIoError(
      `filePath must be absolute; got: ${filePath}`,
      "Pass an absolute path like /Users/you/FaxOutbox/doc.pdf.",
    );
  }
  const requested = resolve(filePath);

  // Reject if the LEAF is a symlink (the actual attack vector — a benign
  // .pdf path that resolves to an arbitrary target). Parent-component
  // symlinks are tolerated (macOS aliases /var → /private/var, /tmp →
  // /private/tmp; many setups symlink /home or app dirs).
  let info;
  try {
    info = await lstat(requested);
  } catch (err) {
    throw new FileIoError(
      `Cannot access file: ${requested} (${(err as Error).message})`,
      "Verify the path exists and is readable.",
    );
  }
  if (info.isSymbolicLink()) {
    throw new FileIoError(
      `filePath must be a regular file, not a symlink: ${requested}`,
      "Pass the canonical path; leaf symlinks are rejected to prevent target swaps.",
    );
  }
  const canonical = await realpath(requested);

  // Outbox jail — the canonical path must live inside FAXDROP_MCP_WORK_DIR
  // (default ~/FaxOutbox/). Symlinks pointing outside are rejected here.
  try {
    assertInsideOutbox(canonical);
  } catch (err) {
    throw new FileIoError(
      (err as Error).message,
      "Move the document into the outbox before faxing.",
    );
  }

  const ext = extname(canonical).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    throw new FileIoError(
      `Unsupported file type: ${ext || "(none)"}. Allowed: PDF, DOCX, JPEG, PNG.`,
      "Convert the document to PDF first.",
    );
  }

  // Pin the file descriptor with O_NOFOLLOW so any symlink swap that
  // sneaks in after the realpath/lstat checks (TOCTOU) fails the open
  // with ELOOP. The startup guard above guarantees O_NOFOLLOW is defined
  // (Windows is rejected at module load), so we OR it in unconditionally —
  // no silent platform degradation.
  const openFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const fh = await open(canonical, openFlags);
  let bytes: Buffer;
  try {
    const stat = await fh.stat();
    if (stat.size > MAX_FILE_BYTES) {
      throw new FileIoError(
        `File too large: ${stat.size} bytes (max ${MAX_FILE_BYTES}).`,
        "Compress the file or split it across multiple faxes.",
      );
    }
    const chunkBuf = Buffer.alloc(READ_CHUNK);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { bytesRead } = await fh.read(chunkBuf, 0, READ_CHUNK);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) {
        throw new FileIoError(
          `File too large: ${total} bytes (max ${MAX_FILE_BYTES}).`,
          "Compress the file or split it across multiple faxes.",
        );
      }
      chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
    }
    bytes = Buffer.concat(chunks, total);
  } finally {
    await fh.close();
  }

  // Magic-byte check: confirm the file content matches the extension.
  // Catches an attacker-placed misnaming (e.g. `id_rsa` → `id_rsa.pdf` to
  // sneak a binary through the outbox jail) AND operator typos (a `.docx`
  // that's actually a legacy `.doc`). The chunked-read above already
  // brought the bytes into memory; peeking at the first 8 bytes is free.
  if (!magicMatches(ext, bytes)) {
    throw new FileIoError(
      `File content does not match extension ${ext}.`,
      "Rename to the correct extension or convert the file (e.g. doc → docx, raw image → JPEG/PNG).",
    );
  }

  return {
    bytes,
    filename: basename(canonical),
    mimeType: MIME_BY_EXT[ext],
  };
}
