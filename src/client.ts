/**
 * FaxDrop API client
 * Docs: https://www.faxdrop.com/for-developers
 */

import { open } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

const BASE_URL = "https://www.faxdrop.com";

export interface FaxDropClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface SendFaxArgs {
  /** Absolute path to the file to fax (PDF, DOCX, JPEG, or PNG, ≤10MB). */
  filePath: string;
  /** Recipient fax number in international format (e.g. "+12125551234"). */
  recipientNumber: string;
  /** Sender display name. */
  senderName: string;
  /** Sender email for delivery confirmation. */
  senderEmail: string;
  /** Optional: include cover page ("true" / "false"). */
  includeCover?: boolean;
  /** Optional cover page fields. */
  coverNote?: string;
  recipientName?: string;
  subject?: string;
  senderCompany?: string;
  senderPhone?: string;
}

export class FaxDropError extends Error {
  constructor(
    message: string,
    public status: number,
    public errorType?: string,
    public hint?: string,
    public retryAfter?: number,
    public body?: unknown
  ) {
    super(message);
    this.name = "FaxDropError";
  }

  // Keep response body out of accidental string interpolation.
  toString(): string {
    return `FaxDropError: ${this.message} (status: ${this.status}${this.errorType ? `, type: ${this.errorType}` : ""})`;
  }
  toJSON(): unknown {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      errorType: this.errorType,
      hint: this.hint,
      retryAfter: this.retryAfter,
    };
  }
}

const ALLOWED_EXTS = new Set([".pdf", ".docx", ".jpeg", ".jpg", ".png"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

export class FaxDropClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(opts: FaxDropClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
  }

  /** POST /api/send-fax — multipart upload. */
  async sendFax(args: SendFaxArgs): Promise<unknown> {
    if (!isAbsolute(args.filePath)) {
      throw new FaxDropError(
        `filePath must be absolute; got: ${args.filePath}`,
        400,
        "bad_request",
        "Pass an absolute path like /Users/you/doc.pdf"
      );
    }
    const path = resolve(args.filePath);
    const ext = "." + (path.split(".").pop() ?? "").toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) {
      throw new FaxDropError(
        `Unsupported file type: ${ext || "(none)"}. Allowed: PDF, DOCX, JPEG, PNG.`,
        400,
        "bad_request",
        "Convert the document to PDF first."
      );
    }
    const tooLarge = (size: number): FaxDropError =>
      new FaxDropError(
        `File too large: ${size} bytes (max ${MAX_FILE_BYTES}).`,
        400,
        "bad_request",
        "Compress the file or split it across multiple faxes."
      );

    // Pin the file descriptor: open() locks us to the inode at open time, so
    // a swap of the path between syscalls can no longer cause us to read a
    // different file than the one we size-checked. fh.stat() is a fast-path
    // reject; the chunked read below enforces the cap continuously, so we
    // never allocate more than MAX_FILE_BYTES + one chunk even if the file
    // grows between stat() and the end of the read.
    const fh = await open(path, "r");
    let buf: Buffer;
    try {
      const info = await fh.stat();
      if (info.size > MAX_FILE_BYTES) throw tooLarge(info.size);

      const CHUNK = 64 * 1024;
      const chunkBuf = Buffer.alloc(CHUNK);
      const chunks: Buffer[] = [];
      let total = 0;
      let bytesRead: number;
      do {
        ({ bytesRead } = await fh.read(chunkBuf, 0, CHUNK));
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > MAX_FILE_BYTES) throw tooLarge(total);
        chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
      } while (true);
      buf = Buffer.concat(chunks, total);
    } finally {
      await fh.close();
    }

    const blob = new Blob([new Uint8Array(buf)], { type: MIME_BY_EXT[ext] });

    const form = new FormData();
    form.set("file", blob, basename(path));
    form.set("recipientNumber", args.recipientNumber);
    form.set("senderName", args.senderName);
    form.set("senderEmail", args.senderEmail);
    if (args.includeCover !== undefined) form.set("includeCover", String(args.includeCover));
    if (args.coverNote !== undefined) form.set("coverNote", args.coverNote);
    if (args.recipientName !== undefined) form.set("recipientName", args.recipientName);
    if (args.subject !== undefined) form.set("subject", args.subject);
    if (args.senderCompany !== undefined) form.set("senderCompany", args.senderCompany);
    if (args.senderPhone !== undefined) form.set("senderPhone", args.senderPhone);

    return this.requestRaw("POST", "/api/send-fax", form);
  }

  /** GET /api/v1/fax/{faxId} */
  async getFaxStatus(faxId: string): Promise<unknown> {
    const safe = encodeURIComponent(faxId);
    return this.requestRaw("GET", `/api/v1/fax/${safe}`);
  }

  private async requestRaw(
    method: "GET" | "POST",
    path: string,
    body?: FormData
  ): Promise<unknown> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      Accept: "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    });

    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }

    if (!res.ok) {
      const obj = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
      const retryHeader = res.headers.get("retry-after");
      const retryAfter =
        typeof obj.retry_after === "number"
          ? obj.retry_after
          : retryHeader
            ? Number(retryHeader)
            : undefined;
      throw new FaxDropError(
        typeof obj.error === "string"
          ? obj.error
          : `FaxDrop API ${method} ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
        typeof obj.error_type === "string" ? obj.error_type : undefined,
        typeof obj.hint === "string" ? obj.hint : undefined,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
        json
      );
    }

    return json ?? { ok: true };
  }
}
