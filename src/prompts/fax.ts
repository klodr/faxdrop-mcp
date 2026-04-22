import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FAX_NUMBER, EMAIL } from "../tools/fax.js";

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

/**
 * `/send-letter-fax` — send a document already placed in the outbox to a fax number.
 *
 * Arg names and shape mirror `faxdrop_send_fax` exactly so the LLM
 * doesn't have to translate. The upstream tool rejects files outside
 * the outbox (`FAXDROP_MCP_WORK_DIR` or `~/FaxOutbox/`), so the prompt
 * hint explicitly tells the model to verify placement before sending.
 */
const SendLetterFaxArgs = {
  filePath: z
    .string()
    .min(1)
    .describe(
      "Absolute path to the document to fax (PDF, DOCX, JPEG, PNG; ≤ 10MB). Must live inside the FaxDrop outbox directory (`FAXDROP_MCP_WORK_DIR` or `~/FaxOutbox/`). Files outside are rejected.",
    ),
  // Reuse the tool-level validators so the prompt acceptance and the
  // tool acceptance cannot drift. If `FAX_NUMBER` gets tightened (country
  // whitelist, E.164 regex, length cap) or `EMAIL` is swapped for a
  // stricter validator, both the prompt and the tool move together.
  recipientNumber: FAX_NUMBER,
  senderName: z.string().min(1).max(100).describe("Sender display name shown on the cover page."),
  senderEmail: EMAIL,
  coverNote: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional cover-page note (max 500 chars). Only printed when the account includes a cover page.",
    ),
};

/**
 * `/fax-history-summary` — summarize recent fax statuses.
 *
 * Schema uses a strict refinement so `","` or `"  "` don't pass as
 * "valid but empty" and leave the LLM with nothing to iterate.
 */
const FaxHistorySummaryArgs = {
  faxIds: z
    .string()
    .min(1)
    .refine(
      (s) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean).length > 0,
      "faxIds must contain at least one non-empty FaxDrop ID",
    )
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
        "Send a PDF/DOCX/JPG/PNG already placed in the outbox to a fax number and poll delivery status until terminal.",
      argsSchema: SendLetterFaxArgs,
    },
    ({ filePath, recipientNumber, senderName, senderEmail, coverNote }) => ({
      description: `Send ${filePath} as a fax to ${recipientNumber}`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Call \`faxdrop_send_fax\` with:\n` +
              `  - filePath: "${filePath}"\n` +
              `  - recipientNumber: "${recipientNumber}"\n` +
              `  - senderName: "${senderName}"\n` +
              `  - senderEmail: "${senderEmail}"\n` +
              // coverNote is silently dropped by the tool unless includeCover
              // is true (see `src/tools/fax.ts` — cover-page fields are only
              // applied under the `includeCover` gate). If the caller gave
              // us a note, we also force includeCover so the note actually
              // renders.
              (coverNote ? `  - includeCover: true\n` + `  - coverNote: "${coverNote}"\n` : "") +
              `\nBefore calling: confirm the file lives inside the outbox ` +
              `(\`FAXDROP_MCP_WORK_DIR\` or \`~/FaxOutbox/\`). Files outside the ` +
              `outbox are rejected by the tool for safety — if the user referenced ` +
              `a file elsewhere, ask them to move or copy it into the outbox first.\n\n` +
              `Once the fax is submitted and you have the returned \`faxId\`, ` +
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
