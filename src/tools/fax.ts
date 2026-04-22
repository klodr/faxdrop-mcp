import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, errorResult, textResult } from "./_shared.js";
import { FaxDropClient } from "../client.js";
import { FileIoError, openInsideOutbox } from "../file-io.js";
import {
  getMode,
  isValidE164,
  pairNumber,
  validateAll,
  validateTypeAndCountry,
} from "../phone-gate.js";
import { getCachedStatus, maybeCacheStatus } from "../status-cache.js";

// `recipientNumber` is validated by validateAll() inside the handler — it
// runs libphonenumber once and emits the structured 3-layer diagnostic
// (parse / type / country / gate). A Zod refine here would re-parse the
// same string with no extra information, just so the error reaches the
// caller through Zod instead of through the handler. Skip it.
export const FAX_NUMBER = z
  .string()
  .min(1)
  .describe(
    "Recipient fax number, international (E.164) format with leading + and country code, e.g. +12125551234",
  );

const SENDER_PHONE = z
  .string()
  .refine(isValidE164, {
    message: "Must be a valid international (E.164) phone number, e.g. +13155550123",
  })
  .describe("Sender callback number shown on the cover page (E.164 format).");

export const EMAIL = z.string().email().describe("Sender email for delivery confirmation.");

export function registerFaxTools(server: McpServer, client: FaxDropClient): void {
  defineTool(
    server,
    "faxdrop_send_fax",
    "Send a fax via FaxDrop. Uploads a local file (PDF, DOCX, JPEG, or PNG, ≤10MB) to a fax number in E.164 format. Returns the FaxDrop fax ID for status polling. ALWAYS confirm with the user (recipient number, file path, cover page details) before calling this tool. IMPORTANT: the document must live inside the outbox directory — by default `~/FaxOutbox/` (auto-created), or wherever the user set FAXDROP_MCP_WORK_DIR. Files outside the outbox are rejected for safety. If the user references a file elsewhere, ask them to copy or move it to the outbox first.",
    {
      filePath: z
        .string()
        .min(1)
        .describe("Absolute path to the document to fax (PDF, DOCX, JPEG, or PNG, ≤10MB)."),
      recipientNumber: FAX_NUMBER,
      senderName: z
        .string()
        .min(1)
        .max(100)
        .describe("Sender display name shown on the cover page."),
      senderEmail: EMAIL,

      includeCover: z
        .boolean()
        .optional()
        .describe(
          "Include a FaxDrop cover page. Free accounts always include a branded cover regardless; paid accounts default to false. The cover-page fields below (coverNote, recipientName, subject, senderCompany, senderPhone) are only printed when includeCover is true.",
        ),
      coverNote: z
        .string()
        .max(500)
        .optional()
        .describe(
          "Message printed on the cover page (max 500 chars). Only used when includeCover is true.",
        ),
      recipientName: z
        .string()
        .max(50)
        .optional()
        .describe(
          'Recipient display name on the cover page, e.g. "Dr. Jane Smith" (max 50 chars).',
        ),
      subject: z
        .string()
        .max(200)
        .optional()
        .describe("Cover page subject / RE: line (max 200 chars)."),
      senderCompany: z
        .string()
        .max(100)
        .optional()
        .describe("Sender company shown on the cover page (max 100 chars)."),
      senderPhone: SENDER_PHONE.optional(),
    },
    async (args) => {
      // 3-layer phone-number gate: TYPE → COUNTRY → per-number policy
      // (open / pairing / closed). All three must pass before the fax is
      // dispatched. See src/phone-gate.ts for semantics + env overrides.
      const gate = validateAll(args.recipientNumber);
      if (!gate.ok) {
        return errorResult({
          error_type: `phone_${gate.layer}`,
          message: gate.reason,
          hint: gate.hint,
        });
      }
      // Outbox jail + symlink hardening + extension allow-list + size cap +
      // chunked TOCTOU-safe read. See src/file-io.ts for the threat model.
      let opened;
      try {
        opened = await openInsideOutbox(args.filePath);
      } catch (err) {
        if (err instanceof FileIoError) {
          return errorResult({
            error_type: "bad_request",
            message: err.message,
            hint: err.hint,
          });
        }
        throw err;
      }
      const { filePath: _filePath, ...rest } = args;
      void _filePath;
      const data = await client.sendFax({
        ...rest,
        fileBytes: opened.bytes,
        filename: opened.filename,
        mimeType: opened.mimeType,
      });
      return textResult(data);
    },
  );

  defineTool(
    server,
    "faxdrop_pair_number",
    "Add a fax number to the pairing whitelist (default `~/.faxdrop-mcp/paired.json`, overridable via FAXDROP_MCP_STATE_DIR). Only effective when FAXDROP_MCP_NUMBER_GATE=pairing. The number must still pass the TYPE and COUNTRY checks (no bypass). ALWAYS confirm with the user before pairing — paired numbers can be faxed without further per-number approval.",
    {
      recipientNumber: FAX_NUMBER,
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- defineTool expects async handlers; pairing is purely sync
    async ({ recipientNumber }) => {
      if (getMode() !== "pairing") {
        return errorResult({
          error_type: "pair_disabled",
          message: `Pairing is disabled (current mode: ${getMode()})`,
          hint: "Set FAXDROP_MCP_NUMBER_GATE=pairing to enable runtime pairing. In 'closed' mode the paired list is edited out-of-band only.",
        });
      }
      const tac = validateTypeAndCountry(recipientNumber);
      if (!tac.ok) {
        return errorResult({
          error_type: `phone_${tac.layer}`,
          message: tac.reason,
          hint: tac.hint,
        });
      }
      pairNumber(tac.e164);
      return textResult({
        paired: tac.e164,
        country: tac.country,
        type: tac.type,
      });
    },
  );

  defineTool(
    server,
    "faxdrop_get_fax_status",
    "Check the delivery status of a previously sent fax. Status values: queued | sending | delivered | failed | partial. Most US faxes complete in under 90 seconds. POLLING STRATEGY: every ~5s for the first 2 min, then every ~30s for up to 10 min, and STOP polling once status is delivered, failed, or partial — these are terminal and the MCP will short-circuit further calls (returning a `_cached: true` marker) to spare your FaxDrop quota. Status checks count toward FaxDrop's per-key rate limits.",
    {
      faxId: z
        .string()
        .min(1)
        .describe("The fax ID returned by faxdrop_send_fax (e.g. fax_abc123)."),
    },
    async ({ faxId }) => {
      // Anti-poll-storm: terminal statuses (delivered/failed/partial) are
      // cached process-wide. Re-polling them is a quota waste; serve from
      // cache + flag so the LLM stops looping.
      const cached = getCachedStatus(faxId);
      if (cached !== undefined) {
        return textResult({ ...(cached as Record<string, unknown>), _cached: true });
      }
      const data = await client.getFaxStatus(faxId);
      maybeCacheStatus(faxId, data);
      return textResult(data);
    },
  );
}
