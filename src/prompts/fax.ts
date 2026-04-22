import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Two user-facing slash commands exposed through MCP's prompt API
 * (https://modelcontextprotocol.io/specification/2025-11-25/server/prompts).
 *
 * Prompts are user-controlled: clients like Claude Desktop surface them
 * as slash commands so a human explicitly picks them before the LLM
 * runs the corresponding tool chain. The prompt body below is the
 * template the LLM sees at invocation time — it deliberately names the
 * `faxdrop_*` tools and describes the polling strategy so the model
 * does not re-discover them.
 */

/** `/send-letter-fax` — send a PDF to a fax number with an optional cover note. */
const SendLetterFaxArgs = {
  fileUrl: z
    .string()
    .describe(
      "HTTPS URL of the PDF (or DOCX/JPG/PNG) to fax. Must be publicly fetchable by FaxDrop — no auth-walled URLs.",
    ),
  faxNumber: z
    .string()
    .describe(
      "Destination fax number in E.164 (e.g. +18005551234) or an explicit country-code-prefixed national form. Local-only formats will be rejected.",
    ),
  coverNote: z
    .string()
    .optional()
    .describe("Optional short cover note prepended to the fax (max ~200 chars)."),
};

/** `/fax-history-summary` — summarize recent fax statuses. */
const FaxHistorySummaryArgs = {
  faxIds: z
    .string()
    .describe(
      "Comma-separated list of FaxDrop IDs to summarize (e.g. `fax_abc,fax_def,fax_ghi`). Each is polled via faxdrop_get_fax_status.",
    ),
};

export function registerFaxPrompts(server: McpServer): void {
  server.registerPrompt(
    "send-letter-fax",
    {
      title: "Send a letter as a fax",
      description:
        "Send a PDF/DOCX/JPG/PNG to a fax number and poll delivery status until terminal.",
      argsSchema: SendLetterFaxArgs,
    },
    ({ fileUrl, faxNumber, coverNote }) => ({
      description: `Send ${fileUrl} as a fax to ${faxNumber}`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Use the \`faxdrop_send_fax\` tool to send the document at ${fileUrl} ` +
              `to fax number ${faxNumber}.` +
              (coverNote ? ` Include this cover note verbatim: "${coverNote}".` : "") +
              `\n\nOnce the fax is submitted and you have the returned \`faxId\`, ` +
              `poll \`faxdrop_get_fax_status\` every ~5 seconds for the first 2 minutes, ` +
              `then every ~30 seconds for up to 10 minutes, and stop as soon as ` +
              `status is terminal (\`delivered\`, \`failed\`, or \`partial\`). ` +
              `Report back the final status, duration, and — if the fax failed — ` +
              `the failure reason from the FaxDrop response.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "fax-history-summary",
    {
      title: "Summarize recent fax statuses",
      description:
        "Given a set of FaxDrop IDs, fetch their current status and return a concise per-fax summary.",
      argsSchema: FaxHistorySummaryArgs,
    },
    ({ faxIds }) => {
      const ids = faxIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        description: `Summarize status of ${ids.length} fax(es)`,
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `For each of these FaxDrop IDs — ${ids.map((id) => `\`${id}\``).join(", ")} — ` +
                `call \`faxdrop_get_fax_status\` and collect the returned status, ` +
                `recipient number, and duration.\n\n` +
                `Return a single compact markdown table with columns: ` +
                `\`faxId\` | \`status\` | \`to\` | \`duration\` | \`notes\`. ` +
                `Group terminal statuses (\`delivered\`/\`failed\`/\`partial\`) at the top, ` +
                `in-flight (\`queued\`/\`sending\`) below. ` +
                `Do NOT re-poll a terminal fax — the MCP short-circuits those via its ` +
                `status cache, so a second call is both redundant and counts toward the quota.`,
            },
          },
        ],
      };
    },
  );
}
