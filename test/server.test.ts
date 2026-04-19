import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, VERSION } from "../src/server.js";
import { _resetOutboxCache } from "../src/file-jail.js";
import { _resetStatusCache } from "../src/status-cache.js";

describe("createServer", () => {
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
