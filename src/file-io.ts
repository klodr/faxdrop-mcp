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
  // with ELOOP. On platforms without O_NOFOLLOW the constant is 0 and
  // the flag is a no-op (we still have the lstat + realpath checks).
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
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

  return {
    bytes,
    filename: basename(canonical),
    mimeType: MIME_BY_EXT[ext],
  };
}
