import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, VERSION } from "../src/server.js";

describe("createServer", () => {
  it("creates a server that lists 2 tools", async () => {
    const server = createServer({ apiKey: "fd_live_test", log: () => {} });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["faxdrop_get_fax_status", "faxdrop_send_fax"]);

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
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
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
    tmpDir = mkdtempSync(join(tmpdir(), "faxdrop-int-"));
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    rmSync(tmpDir, { recursive: true, force: true });
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

    const result = await callTool("faxdrop_send_fax", {
      filePath: pdf,
      recipientNumber: "+12125551234",
      senderName: "Test",
      senderEmail: "t@example.com",
    });
    const content = (result as { content: { type: string; text: string }[] }).content[0];
    expect(content.text).toContain('"faxId": "fax_xyz"');
  });
});
