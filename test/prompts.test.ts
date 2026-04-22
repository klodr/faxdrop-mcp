import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

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

  it("send-letter-fax has args aligned with faxdrop_send_fax", async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    const p = prompts.find((p) => p.name === "send-letter-fax");
    expect(p).toBeDefined();
    const argNames = (p?.arguments ?? []).map((a) => a.name).sort();
    expect(argNames).toEqual([
      "coverNote",
      "filePath",
      "recipientNumber",
      "senderEmail",
      "senderName",
    ]);
    const required = (p?.arguments ?? [])
      .filter((a) => a.required)
      .map((a) => a.name)
      .sort();
    expect(required).toEqual(["filePath", "recipientNumber", "senderEmail", "senderName"]);
  });

  it("send-letter-fax mentions faxdrop_send_fax with the real arg names + polling strategy", async () => {
    const { client } = await connect();
    const result = await client.getPrompt({
      name: "send-letter-fax",
      arguments: {
        filePath: "/Users/me/FaxOutbox/invoice.pdf",
        recipientNumber: "+18005551234",
        senderName: "Alice",
        senderEmail: "alice@example.com",
      },
    });
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0];
    expect(msg?.role).toBe("user");
    expect(msg?.content.type).toBe("text");
    const text = (msg?.content as { text: string }).text;
    expect(text).toContain("faxdrop_send_fax");
    expect(text).toContain("faxdrop_get_fax_status");
    expect(text).toContain("filePath");
    expect(text).toContain("recipientNumber");
    expect(text).toContain("senderName");
    expect(text).toContain("senderEmail");
    expect(text).toContain("/Users/me/FaxOutbox/invoice.pdf");
    expect(text).toContain("+18005551234");
    expect(text).toContain("Alice");
    expect(text).toContain("alice@example.com");
    // Outbox safety hint is load-bearing — prompt must not tell the LLM to
    // blindly call the tool with an arbitrary path.
    expect(text.toLowerCase()).toContain("outbox");
  });

  it("send-letter-fax includes the cover note AND forces includeCover:true when a note is provided", async () => {
    // Regression for a CR finding: the fax tool silently drops coverNote
    // unless includeCover is true. The prompt must force the gate when it
    // asks the LLM to pass a cover note, otherwise paid accounts lose it.
    const { client } = await connect();
    const result = await client.getPrompt({
      name: "send-letter-fax",
      arguments: {
        filePath: "/Users/me/FaxOutbox/invoice.pdf",
        recipientNumber: "+18005551234",
        senderName: "Alice",
        senderEmail: "alice@example.com",
        coverNote: "Please see attached invoice.",
      },
    });
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain("Please see attached invoice.");
    expect(text).toContain("includeCover: true");
  });

  it("send-letter-fax does NOT mention includeCover when no cover note is given", async () => {
    const { client } = await connect();
    const result = await client.getPrompt({
      name: "send-letter-fax",
      arguments: {
        filePath: "/Users/me/FaxOutbox/invoice.pdf",
        recipientNumber: "+18005551234",
        senderName: "Alice",
        senderEmail: "alice@example.com",
      },
    });
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).not.toContain("includeCover");
    expect(text).not.toContain("coverNote");
  });

  it("send-letter-fax rejects missing required args (senderEmail)", async () => {
    const { client } = await connect();
    await expect(
      client.getPrompt({
        name: "send-letter-fax",
        arguments: {
          filePath: "/Users/me/FaxOutbox/invoice.pdf",
          recipientNumber: "+18005551234",
          senderName: "Alice",
          // senderEmail missing → Zod validation must fail
        },
      }),
    ).rejects.toThrow();
  });

  it("send-letter-fax rejects a non-email senderEmail", async () => {
    const { client } = await connect();
    await expect(
      client.getPrompt({
        name: "send-letter-fax",
        arguments: {
          filePath: "/Users/me/FaxOutbox/invoice.pdf",
          recipientNumber: "+18005551234",
          senderName: "Alice",
          senderEmail: "not-an-email",
        },
      }),
    ).rejects.toThrow();
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

  it("fax-history-summary rejects comma-only / whitespace-only input (no real IDs)", async () => {
    const { client } = await connect();
    for (const empty of [",", ",,", "  ", " , "]) {
      await expect(
        client.getPrompt({ name: "fax-history-summary", arguments: { faxIds: empty } }),
      ).rejects.toThrow();
    }
  });
});
