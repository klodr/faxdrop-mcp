import { FaxDropClient, FaxDropError } from "../src/client.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockFetch(response: {
  ok: boolean;
  status: number;
  statusText?: string;
  body: unknown;
  headers?: Record<string, string>;
}) {
  global.fetch = vi.fn(async () => ({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? (response.ok ? "OK" : "Error"),
    text: async () =>
      typeof response.body === "string" ? response.body : JSON.stringify(response.body),
    headers: { get: (k: string) => response.headers?.[k.toLowerCase()] ?? null },
  })) as unknown as typeof fetch;
}

describe("FaxDropClient", () => {
  let tmpDir: string;
  let pdfPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "faxdrop-test-"));
    pdfPath = join(tmpDir, "doc.pdf");
    writeFileSync(pdfPath, "%PDF-1.4\n%fake\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("constructs with an API key", () => {
    const client = new FaxDropClient({ apiKey: "fd_live_test" });
    expect(client).toBeInstanceOf(FaxDropClient);
  });

  it("getFaxStatus parses JSON and uses X-API-Key header", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    global.fetch = (async (url: URL | string, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ id: "fax_abc", status: "delivered" }),
        headers: { get: () => null },
      };
    }) as unknown as typeof fetch;

    const client = new FaxDropClient({ apiKey: "fd_live_secret" });
    const result = await client.getFaxStatus("fax_abc");
    expect(result).toEqual({ id: "fax_abc", status: "delivered" });
    expect(capturedUrl).toContain("/api/v1/fax/fax_abc");
    expect(capturedInit?.method).toBe("GET");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("fd_live_secret");
    expect(headers.Accept).toBe("application/json");
  });

  it("getFaxStatus URL-encodes faxId", async () => {
    let capturedUrl: string | undefined;
    global.fetch = (async (url: URL | string) => {
      capturedUrl = url.toString();
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "{}",
        headers: { get: () => null },
      };
    }) as unknown as typeof fetch;

    const client = new FaxDropClient({ apiKey: "k" });
    await client.getFaxStatus("fax/with/slash");
    expect(capturedUrl).toContain("/api/v1/fax/fax%2Fwith%2Fslash");
  });

  it("sendFax rejects relative path", async () => {
    const client = new FaxDropClient({ apiKey: "k" });
    await expect(
      client.sendFax({
        filePath: "relative/doc.pdf",
        recipientNumber: "+12125551234",
        senderName: "X",
        senderEmail: "x@y.com",
      }),
    ).rejects.toMatchObject({ status: 400, errorType: "bad_request" });
  });

  it("sendFax rejects unsupported extension", async () => {
    const exe = join(tmpDir, "x.exe");
    writeFileSync(exe, "MZ");
    const client = new FaxDropClient({ apiKey: "k" });
    await expect(
      client.sendFax({
        filePath: exe,
        recipientNumber: "+12125551234",
        senderName: "X",
        senderEmail: "x@y.com",
      }),
    ).rejects.toMatchObject({ status: 400, errorType: "bad_request" });
  });

  it("sendFax rejects file > 10MB", async () => {
    const big = join(tmpDir, "big.pdf");
    writeFileSync(big, Buffer.alloc(11 * 1024 * 1024, 0));
    const client = new FaxDropClient({ apiKey: "k" });
    await expect(
      client.sendFax({
        filePath: big,
        recipientNumber: "+12125551234",
        senderName: "X",
        senderEmail: "x@y.com",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("sendFax POSTs multipart with required fields", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    global.fetch = (async (url: URL | string, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ success: true, faxId: "fax_xyz", status: "queued" }),
        headers: { get: () => null },
      };
    }) as unknown as typeof fetch;

    const client = new FaxDropClient({ apiKey: "fd_live_xxx" });
    const result = await client.sendFax({
      filePath: pdfPath,
      recipientNumber: "+12125551234",
      senderName: "Claude Test",
      senderEmail: "test@example.com",
      coverNote: "Hello",
      includeCover: true,
    });

    expect(result).toEqual({ success: true, faxId: "fax_xyz", status: "queued" });
    expect(capturedUrl).toContain("/api/send-fax");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBeInstanceOf(FormData);

    const fd = capturedInit?.body as FormData;
    expect(fd.get("recipientNumber")).toBe("+12125551234");
    expect(fd.get("senderName")).toBe("Claude Test");
    expect(fd.get("senderEmail")).toBe("test@example.com");
    expect(fd.get("coverNote")).toBe("Hello");
    expect(fd.get("includeCover")).toBe("true");
    expect(fd.get("file")).toBeInstanceOf(Blob);

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("fd_live_xxx");
    // Important: no Content-Type override — fetch sets multipart boundary itself
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("throws FaxDropError with parsed error body on non-2xx", async () => {
    mockFetch({
      ok: false,
      status: 402,
      statusText: "Payment Required",
      body: { error: "No credits", error_type: "payment_required", hint: "Buy more" },
    });
    const client = new FaxDropClient({ apiKey: "k" });
    try {
      await client.getFaxStatus("fax_abc");
      fail("Expected FaxDropError");
    } catch (err) {
      expect(err).toBeInstanceOf(FaxDropError);
      const e = err as FaxDropError;
      expect(e.status).toBe(402);
      expect(e.message).toBe("No credits");
      expect(e.errorType).toBe("payment_required");
      expect(e.hint).toBe("Buy more");
    }
  });

  it("falls back to Retry-After header when retry_after is missing", async () => {
    mockFetch({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      body: { error: "Slow down", error_type: "rate_limited" },
      headers: { "retry-after": "42" },
    });
    const client = new FaxDropClient({ apiKey: "k" });
    try {
      await client.getFaxStatus("fax_abc");
      fail("Expected FaxDropError");
    } catch (err) {
      expect((err as FaxDropError).retryAfter).toBe(42);
    }
  });

  it("uses retry_after from body when present (preferred over header)", async () => {
    mockFetch({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      body: { error: "Slow down", error_type: "rate_limited", retry_after: 17 },
      headers: { "retry-after": "999" },
    });
    const client = new FaxDropClient({ apiKey: "k" });
    try {
      await client.getFaxStatus("fax_abc");
      fail("Expected FaxDropError");
    } catch (err) {
      expect((err as FaxDropError).retryAfter).toBe(17);
    }
  });

  it("returns { ok: true } when the response body is empty (e.g. 200 with no payload)", async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      headers: { get: () => null },
    })) as unknown as typeof fetch;
    const client = new FaxDropClient({ apiKey: "k" });
    const result = await client.getFaxStatus("fax_abc");
    expect(result).toEqual({ ok: true });
  });

  it("sendFax forwards every optional cover-page field when set", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: URL | string, init?: RequestInit) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ success: true, faxId: "fax_full" }),
        headers: { get: () => null },
      };
    }) as unknown as typeof fetch;

    const client = new FaxDropClient({ apiKey: "k" });
    await client.sendFax({
      filePath: pdfPath,
      recipientNumber: "+12125551234",
      senderName: "X",
      senderEmail: "x@y.com",
      recipientName: "Dr. Smith",
      subject: "Lab results",
      senderCompany: "Acme Co",
      senderPhone: "+12125550000",
    });
    const fd = capturedInit?.body as FormData;
    expect(fd.get("recipientName")).toBe("Dr. Smith");
    expect(fd.get("subject")).toBe("Lab results");
    expect(fd.get("senderCompany")).toBe("Acme Co");
    expect(fd.get("senderPhone")).toBe("+12125550000");
  });
});

describe("FaxDropClient — non-JSON response handling", () => {
  it("falls back to raw text when the response body is not JSON", async () => {
    mockFetch({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      body: "<html><body>Bad gateway</body></html>",
    });
    const client = new FaxDropClient({ apiKey: "k" });
    try {
      await client.getFaxStatus("fax_abc");
      fail("Expected FaxDropError");
    } catch (err) {
      expect(err).toBeInstanceOf(FaxDropError);
      const e = err as FaxDropError;
      expect(e.status).toBe(502);
      // The body should be the raw HTML string (not parsed)
      expect(e.body).toBe("<html><body>Bad gateway</body></html>");
      // No structured error_type because the body wasn't a JSON object
      expect(e.errorType).toBeUndefined();
    }
  });
});

describe("FaxDropError", () => {
  it("captures status, type, hint, retry-after", () => {
    const err = new FaxDropError("boom", 429, "rate_limited", "Wait", 30, { meta: 1 });
    expect(err.message).toBe("boom");
    expect(err.status).toBe(429);
    expect(err.errorType).toBe("rate_limited");
    expect(err.hint).toBe("Wait");
    expect(err.retryAfter).toBe(30);
    expect(err.body).toEqual({ meta: 1 });
    expect(err.name).toBe("FaxDropError");
  });

  it("toString does not leak the response body", () => {
    const err = new FaxDropError("boom", 500, "internal_error", undefined, undefined, {
      sensitive: "leak-me",
    });
    const str = err.toString();
    expect(str).toContain("FaxDropError");
    expect(str).toContain("boom");
    expect(str).toContain("500");
    expect(str).not.toContain("leak-me");
    expect(str).not.toContain("sensitive");
  });

  it("toJSON does not leak the response body", () => {
    const err = new FaxDropError("boom", 500, "internal_error", undefined, undefined, {
      sensitive: "leak-me",
    });
    const json = err.toJSON() as Record<string, unknown>;
    expect(json).toMatchObject({ name: "FaxDropError", message: "boom", status: 500 });
    expect(JSON.stringify(json)).not.toContain("leak-me");
  });
});
