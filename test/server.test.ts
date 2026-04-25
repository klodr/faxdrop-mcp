import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, FAXDROP_HOSTS, validateBaseUrl, VERSION } from "../src/server.js";
import { _resetOutboxCache } from "../src/file-jail.js";
import { _resetStatusCache } from "../src/status-cache.js";

/**
 * Both the `createServer` and `validateBaseUrl` suites exercise
 * non-FaxDrop hostnames as the property under test, so they need the
 * `FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST=true` opt-in for every test
 * case. Centralise the toggle so a future tweak to the policy flag
 * (different env name, different value semantics, etc.) updates one
 * place. Each test that wants to exercise the policy default
 * (allowlist enforced) deletes the env var explicitly inside the test
 * body.
 */
function withNonFaxDropHostOptIn(): void {
  beforeEach(() => {
    process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST = "true";
  });
  afterEach(() => {
    delete process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST;
  });
}

describe("createServer", () => {
  withNonFaxDropHostOptIn();

  it("creates a server that lists the 3 tools", async () => {
    const server = createServer({ apiKey: "fd_live_test", log: () => {} });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["faxdrop_get_fax_status", "faxdrop_pair_number", "faxdrop_send_fax"]);

    await client.close();
  });

  it("logs base URL override when provided", () => {
    const logs: string[] = [];
    createServer({
      apiKey: "fd_live_test",
      baseUrl: "https://my-proxy.example.com",
      log: (m) => logs.push(m),
    });
    expect(logs.some((l) => l.includes("base URL overridden"))).toBe(true);
  });

  it("does not log base URL override by default", () => {
    const logs: string[] = [];
    createServer({ apiKey: "fd_live_test", log: (m) => logs.push(m) });
    expect(logs.length).toBe(0);
  });

  it("exposes the package VERSION", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("falls back to console.error when no log option is given", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createServer({ apiKey: "fd_live_test", baseUrl: "https://x.example.com" });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("base URL overridden"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("rejects an invalid baseUrl at startup (createServer throws)", () => {
    expect(() =>
      createServer({ apiKey: "fd_live_test", baseUrl: "http://attacker.example", log: () => {} }),
    ).toThrow(/must use https:\/\//);
  });
});

describe("validateBaseUrl", () => {
  // Mirrors the strict outbound webhook URL validation in
  // klodr/mercury-invoicing-mcp's src/tools/webhooks.ts (HttpsWebhookUrl).
  // The bearer API key + every fax payload + every recipient number is
  // sent to FAXDROP_API_BASE_URL, so the same SSRF / cleartext / private
  // network safeguards apply here.

  // Same env-toggle as the createServer suite above — most assertions
  // exercise non-FaxDrop hosts as their property under test.
  withNonFaxDropHostOptIn();

  it("accepts a valid public HTTPS URL", () => {
    expect(() => validateBaseUrl("https://www.faxdrop.com")).not.toThrow();
    expect(() => validateBaseUrl("https://api.faxdrop.com/v1")).not.toThrow();
    expect(() => validateBaseUrl("https://my-proxy.example.com:8443/api")).not.toThrow();
  });

  it("rejects a malformed URL", () => {
    expect(() => validateBaseUrl("not a url")).toThrow(/not a valid URL/);
    expect(() => validateBaseUrl("")).toThrow(/not a valid URL/);
  });

  it("rejects http://", () => {
    expect(() => validateBaseUrl("http://www.faxdrop.com")).toThrow(/must use https:\/\//);
  });

  it("rejects file://, data:, ftp://, gopher:// schemes", () => {
    expect(() => validateBaseUrl("file:///etc/passwd")).toThrow(/must use https:\/\//);
    expect(() => validateBaseUrl("data:text/plain,hello")).toThrow(/must use https:\/\//);
    expect(() => validateBaseUrl("ftp://attacker.example")).toThrow(/must use https:\/\//);
    expect(() => validateBaseUrl("gopher://attacker.example")).toThrow(/must use https:\/\//);
  });

  it("rejects loopback hostnames (localhost, 127.0.0.0/8, ::1)", () => {
    expect(() => validateBaseUrl("https://localhost/api")).toThrow(/\.localhost namespace/);
    expect(() => validateBaseUrl("https://127.0.0.1/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://127.0.0.2/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://[::1]/api")).toThrow(/non-public range/);
  });

  it("rejects the RFC 6761 .localhost namespace and *.localhost subdomains", () => {
    expect(() => validateBaseUrl("https://foo.localhost/api")).toThrow(/\.localhost namespace/);
    expect(() => validateBaseUrl("https://api.staging.localhost/v1")).toThrow(
      /\.localhost namespace/,
    );
  });

  it("rejects RFC 1918 private IPv4 addresses", () => {
    // ipaddr.js classifies 10/8, 172.16/12, 192.168/16 as `private`.
    expect(() => validateBaseUrl("https://10.0.0.1/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://10.255.255.255/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://172.16.0.1/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://172.31.255.255/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://192.168.1.1/api")).toThrow(/non-public range/);
  });

  it("rejects link-local + cloud metadata (169.254.0.0/16)", () => {
    // ipaddr.js classifies 169.254/16 as `linkLocal`.
    expect(() => validateBaseUrl("https://169.254.169.254/latest/meta-data/")).toThrow(
      /non-public range/,
    );
    expect(() => validateBaseUrl("https://169.254.0.1/api")).toThrow(/non-public range/);
  });

  it("rejects 0.0.0.0/8 (the unspecified address)", () => {
    // ipaddr.js classifies 0.0.0.0/8 as `unspecified`.
    expect(() => validateBaseUrl("https://0.0.0.0/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://0.1.2.3/api")).toThrow(/non-public range/);
  });

  it("rejects IPv6 ULA (fc00::/7)", () => {
    // ipaddr.js classifies fc00::/7 as `uniqueLocal`.
    expect(() => validateBaseUrl("https://[fc00::1]/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://[fd00::1]/api")).toThrow(/non-public range/);
  });

  it("rejects IPv6 link-local (fe80::/10) including the upper half of the range", () => {
    // ipaddr.js classifies fe80::/10 as `linkLocal` for both halves.
    expect(() => validateBaseUrl("https://[fe80::1]/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://[febf::1]/api")).toThrow(/non-public range/);
  });

  it("rejects RFC 6598 carrier-grade NAT (100.64.0.0/10)", () => {
    expect(() => validateBaseUrl("https://100.64.0.5/api")).toThrow(/non-public range/);
  });

  it("rejects RFC 2544 benchmarking + RFC 5737 documentation ranges", () => {
    expect(() => validateBaseUrl("https://198.18.0.5/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://192.0.2.5/api")).toThrow(/non-public range/);
  });

  it("rejects IPv4-mapped IPv6 loopback in both encodings", () => {
    // Node's URL.hostname canonicalises `::ffff:127.0.0.1` into the hex-pair
    // form `::ffff:7f00:1`. ipaddr.js normalises both shapes back into the
    // underlying IPv4 range, so the same loopback classification applies.
    expect(() => validateBaseUrl("https://[::ffff:127.0.0.1]/api")).toThrow(/non-public range/);
    expect(() => validateBaseUrl("https://[::ffff:7f00:1]/api")).toThrow(/non-public range/);
  });

  it("does NOT reject RFC 1918-adjacent but routable IPv4 addresses", () => {
    // 11.0.0.0/8 is publicly routable (DOD) — must NOT be rejected.
    expect(() => validateBaseUrl("https://11.0.0.1/api")).not.toThrow();
    // 172.32.0.0 is just outside the 172.16/12 range — must be allowed.
    expect(() => validateBaseUrl("https://172.32.0.1/api")).not.toThrow();
    // 192.169.0.0 is just outside 192.168/16 — must be allowed.
    expect(() => validateBaseUrl("https://192.169.0.1/api")).not.toThrow();
  });
});

describe("validateBaseUrl — FaxDrop hostname allowlist", () => {
  it("accepts every host on the strict allowlist (no wildcard)", () => {
    delete process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST;
    // Iterate the exported allowlist constant so the test does not pin a
    // literal hostname — the allowlist can be tightened (or extended)
    // without rewriting the assertion.
    for (const allowed of FAXDROP_HOSTS) {
      expect(() => validateBaseUrl(`https://${allowed}`)).not.toThrow();
      expect(() => validateBaseUrl(`https://${allowed}/api/v1`)).not.toThrow();
    }
  });

  it("rejects faxdrop subdomains that aren't on the strict allowlist", () => {
    delete process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST;
    // No wildcard: bare `faxdrop.com` and arbitrary subdomains are
    // rejected until they pass explicit code review.
    expect(() => validateBaseUrl("https://faxdrop.com/api")).toThrow(/not a FaxDrop hostname/);
    expect(() => validateBaseUrl("https://api.faxdrop.com/v1")).toThrow(/not a FaxDrop hostname/);
    expect(() => validateBaseUrl("https://api.staging.faxdrop.com/v1")).toThrow(
      /not a FaxDrop hostname/,
    );
  });

  it("rejects non-FaxDrop hosts by default (no opt-in)", () => {
    delete process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST;
    expect(() => validateBaseUrl("https://attacker.example.com/api")).toThrow(
      /not a FaxDrop hostname/,
    );
    expect(() => validateBaseUrl("https://my-proxy.example.com/api")).toThrow(
      /not a FaxDrop hostname/,
    );
  });

  it("accepts non-FaxDrop hosts when FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST=true", () => {
    process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST = "true";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => validateBaseUrl("https://my-proxy.example.com/api")).not.toThrow();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("non-FaxDrop host"));
    } finally {
      errSpy.mockRestore();
      delete process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST;
    }
  });

  it("only the literal string 'true' opts in", () => {
    delete process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST;
    process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST = "1";
    expect(() => validateBaseUrl("https://my-proxy.example.com/api")).toThrow(
      /not a FaxDrop hostname/,
    );
    process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST = "yes";
    expect(() => validateBaseUrl("https://my-proxy.example.com/api")).toThrow(
      /not a FaxDrop hostname/,
    );
    delete process.env.FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST;
  });
});

describe("Tools wired through the server", () => {
  // These integration tests exercise the actual tool handlers (defineTool +
  // wrapToolHandler + textResult), which the schema-only listTools test
  // doesn't reach.
  const ORIGINAL_FETCH = global.fetch;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "faxdrop-int-")));
    process.env.FAXDROP_MCP_WORK_DIR = tmpDir;
    _resetOutboxCache();
    _resetStatusCache();
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.FAXDROP_MCP_WORK_DIR;
    _resetOutboxCache();
    _resetStatusCache();
  });

  function mockJsonResponse(body: unknown) {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    })) as unknown as typeof fetch;
  }

  async function callTool(toolName: string, args: Record<string, unknown>) {
    const server = createServer({ apiKey: "fd_live_test", log: () => {} });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      return await client.callTool({ name: toolName, arguments: args });
    } finally {
      await client.close();
    }
  }

  it("faxdrop_get_fax_status returns the JSON status", async () => {
    mockJsonResponse({ id: "fax_abc", status: "delivered" });
    const result = await callTool("faxdrop_get_fax_status", { faxId: "fax_abc" });
    const content = (result as { content: { type: string; text: string }[] }).content[0];
    expect(content.type).toBe("text");
    expect(content.text).toContain('"status": "delivered"');
  });

  it("faxdrop_send_fax returns the create response", async () => {
    const pdf = join(tmpDir, "doc.pdf");
    writeFileSync(pdf, "%PDF-1.4\n%fake\n");
    mockJsonResponse({ success: true, faxId: "fax_xyz", status: "queued" });

    process.env.FAXDROP_MCP_NUMBER_GATE = "open";
    try {
      const result = await callTool("faxdrop_send_fax", {
        filePath: pdf,
        recipientNumber: "+12125551234",
        senderName: "Test",
        senderEmail: "t@example.com",
      });
      const content = (result as { content: { type: string; text: string }[] }).content[0];
      expect(content.text).toContain('"faxId": "fax_xyz"');
    } finally {
      delete process.env.FAXDROP_MCP_NUMBER_GATE;
    }
  });

  it("faxdrop_send_fax returns isError when the phone-gate rejects (default 'closed' mode)", async () => {
    const pdf = join(tmpDir, "doc.pdf");
    writeFileSync(pdf, "%PDF-1.4\n%fake\n");
    process.env.FAXDROP_MCP_STATE_DIR = tmpDir;
    try {
      const result = (await callTool("faxdrop_send_fax", {
        filePath: pdf,
        recipientNumber: "+12125551234",
        senderName: "Test",
        senderEmail: "t@example.com",
      })) as { content: { type: string; text: string }[]; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("phone_gate");
    } finally {
      delete process.env.FAXDROP_MCP_STATE_DIR;
    }
  });

  it("faxdrop_pair_number rejects when gate mode is not 'pairing'", async () => {
    process.env.FAXDROP_MCP_NUMBER_GATE = "closed";
    try {
      const result = (await callTool("faxdrop_pair_number", {
        recipientNumber: "+12125551234",
      })) as { content: { type: string; text: string }[]; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("pair_disabled");
    } finally {
      delete process.env.FAXDROP_MCP_NUMBER_GATE;
    }
  });

  it("faxdrop_pair_number adds a number that passes type+country in 'pairing' mode", async () => {
    process.env.FAXDROP_MCP_NUMBER_GATE = "pairing";
    process.env.FAXDROP_MCP_STATE_DIR = tmpDir;
    try {
      const result = (await callTool("faxdrop_pair_number", {
        recipientNumber: "+18005551212",
      })) as { content: { type: string; text: string }[]; isError?: boolean };
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('"paired": "+18005551212"');
      expect(result.content[0].text).toContain('"country": "US"');
    } finally {
      delete process.env.FAXDROP_MCP_NUMBER_GATE;
      delete process.env.FAXDROP_MCP_STATE_DIR;
    }
  });

  it("returns structuredContent (parseable JSON) alongside the fenced text", async () => {
    mockJsonResponse({ id: "fax_abc", status: "delivered", pages: 2 });
    const result = (await callTool("faxdrop_get_fax_status", { faxId: "fax_abc" })) as {
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    // content[0].text is fence-wrapped (NOT raw JSON-parseable).
    expect(result.content[0].text).toContain("<untrusted-tool-output>");
    // structuredContent is the raw object — programmatic consumers use this.
    expect(result.structuredContent).toMatchObject({
      id: "fax_abc",
      status: "delivered",
      pages: 2,
    });
  });

  it("faxdrop_pair_number rejects a number that fails type+country (no bypass)", async () => {
    process.env.FAXDROP_MCP_NUMBER_GATE = "pairing";
    process.env.FAXDROP_MCP_STATE_DIR = tmpDir;
    try {
      const result = (await callTool("faxdrop_pair_number", {
        // FR landline — passes E.164 regex but fails country check
        recipientNumber: "+33144556677",
      })) as { content: { type: string; text: string }[]; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("phone_country");
    } finally {
      delete process.env.FAXDROP_MCP_NUMBER_GATE;
      delete process.env.FAXDROP_MCP_STATE_DIR;
    }
  });

  it("faxdrop_send_fax surfaces FileIoError as a bad_request (e.g. missing file)", async () => {
    process.env.FAXDROP_MCP_NUMBER_GATE = "open";
    try {
      const result = (await callTool("faxdrop_send_fax", {
        filePath: join(tmpDir, "does-not-exist.pdf"),
        recipientNumber: "+12125551234",
        senderName: "Test",
        senderEmail: "t@example.com",
      })) as { content: { type: string; text: string }[]; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("bad_request");
      expect(result.content[0].text).toContain("Cannot access file");
    } finally {
      delete process.env.FAXDROP_MCP_NUMBER_GATE;
    }
  });

  it("faxdrop_get_fax_status short-circuits on a previously-cached terminal status", async () => {
    // Use a spy (not the plain mockJsonResponse helper) so we can prove the
    // 2nd call truly bypassed fetch — without that assertion, a regression
    // that re-queried FaxDrop and *then* annotated `_cached` would still pass.
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ id: "fax_zzz", status: "delivered", pages: 4 }),
      headers: { get: () => null },
    }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    // First call: hits FaxDrop (mock), result cached because status is terminal.
    const first = (await callTool("faxdrop_get_fax_status", { faxId: "fax_zzz" })) as {
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    expect(first.structuredContent).toMatchObject({ status: "delivered", pages: 4 });
    expect(first.structuredContent).not.toHaveProperty("_cached");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Second call: short-circuit — fetch must NOT be called again.
    const second = (await callTool("faxdrop_get_fax_status", { faxId: "fax_zzz" })) as {
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    expect(second.structuredContent).toMatchObject({
      status: "delivered",
      pages: 4,
      _cached: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
