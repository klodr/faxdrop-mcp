/**
 * FaxDrop API client — pure HTTP wrapper.
 *
 * Filesystem-touching code (path validation, symlink hardening, outbox
 * jail, chunked-read with size cap) lives in `src/file-io.ts`. This
 * client takes already-opened bytes and pushes them to FaxDrop.
 * Docs: https://www.faxdrop.com/for-developers
 */

import { assertSafeUrl } from "./safe-url.js";

const BASE_URL = "https://www.faxdrop.com";

export interface FaxDropClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface SendFaxArgs {
  /** File contents (already validated + size-capped by the caller). */
  fileBytes: Buffer;
  /** Filename to advertise in the multipart body (basename only, no path). */
  filename: string;
  /** MIME type derived from the file extension. */
  mimeType: string;
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
    public body?: unknown,
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

export class FaxDropClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(opts: FaxDropClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
  }

  /** POST /api/send-fax — multipart upload. */
  async sendFax(args: SendFaxArgs): Promise<unknown> {
    const blob = new Blob([new Uint8Array(args.fileBytes)], { type: args.mimeType });

    const form = new FormData();
    form.set("file", blob, args.filename);
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
    body?: FormData,
  ): Promise<unknown> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      Accept: "application/json",
    };

    // Runtime SSRF defense: re-resolve the URL hostname and reject if any
    // record points at a non-`unicast` range. Combined with the boot-time
    // `validateBaseUrl()` check this closes DNS-rebinding + redirect-into-
    // private-host gaps without migrating off the native fetch API.
    await assertSafeUrl(url);

    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    });

    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // Discard non-JSON responses entirely: FaxDrop's API always returns
        // JSON (success and error), so non-JSON is a proxy interception, an
        // upstream HTML error page, or a service incident. Surfacing the
        // raw body would re-inject untrusted text into the LLM context.
        throw new FaxDropError(
          `FaxDrop API ${method} ${path} returned a non-JSON response (HTTP ${res.status})`,
          res.status,
          "invalid_response",
          "FaxDrop returned an unexpected body (likely a proxy or incident page); body discarded for safety.",
        );
      }
    }

    if (!res.ok) {
      const obj = (typeof json === "object" && json !== null ? json : {}) as Record<
        string,
        unknown
      >;
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
        json,
      );
    }

    return json ?? { ok: true };
  }
}
