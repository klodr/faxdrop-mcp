import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

describe("prompts: user-facing slash commands", () => {
  async function connect() {
    const server = createServer({ apiKey: "dummy_test_key_for_prompts" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([client.connect(clientT), server.connect(serverT)]);
    return { client, server };
  }

  it("declares the `prompts` capability via registerPrompt", async () => {
    const { client } = await connect();
    const caps = client.getServerCapabilities();
    expect(caps?.prompts).toBeDefined();
  });

  it("exposes exactly the 2 documented slash commands", async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual(["fax-history-summary", "send-letter-fax"]);
  });

  it("send-letter-fax has the documented args", async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    const p = prompts.find((p) => p.name === "send-letter-fax");
    expect(p).toBeDefined();
    const argNames = (p?.arguments ?? []).map((a) => a.name).sort();
    expect(argNames).toEqual(["coverNote", "faxNumber", "fileUrl"]);
    const required = (p?.arguments ?? [])
      .filter((a) => a.required)
      .map((a) => a.name)
      .sort();
    expect(required).toEqual(["faxNumber", "fileUrl"]);
  });

  it("send-letter-fax mentions faxdrop_send_fax and the polling strategy", async () => {
    const { client } = await connect();
    const result = await client.getPrompt({
      name: "send-letter-fax",
      arguments: { fileUrl: "https://example.com/a.pdf", faxNumber: "+18005551234" },
    });
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg?.role).toBe("user");
    expect(msg?.content.type).toBe("text");
    const text = (msg?.content as { text: string }).text;
    expect(text).toContain("faxdrop_send_fax");
    expect(text).toContain("faxdrop_get_fax_status");
    expect(text).toContain("https://example.com/a.pdf");
    expect(text).toContain("+18005551234");
  });

  it("send-letter-fax includes the cover note when provided", async () => {
    const { client } = await connect();
    const result = await client.getPrompt({
      name: "send-letter-fax",
      arguments: {
        fileUrl: "https://example.com/a.pdf",
        faxNumber: "+18005551234",
        coverNote: "Please see attached invoice.",
      },
    });
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain("Please see attached invoice.");
  });

  it("fax-history-summary iterates the provided fax IDs", async () => {
    const { client } = await connect();
    const result = await client.getPrompt({
      name: "fax-history-summary",
      arguments: { faxIds: "fax_abc, fax_def ,fax_ghi" },
    });
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain("fax_abc");
    expect(text).toContain("fax_def");
    expect(text).toContain("fax_ghi");
    expect(text).toContain("faxdrop_get_fax_status");
  });

  it("fax-history-summary warns against re-polling terminal statuses", async () => {
    const { client } = await connect();
    const result = await client.getPrompt({
      name: "fax-history-summary",
      arguments: { faxIds: "fax_abc" },
    });
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text.toLowerCase()).toContain("terminal");
    expect(text.toLowerCase()).toContain("cache");
  });
});
