import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
});
