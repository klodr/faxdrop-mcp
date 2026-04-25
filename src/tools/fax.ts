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
// FAX_NUMBER and EMAIL are defined in the standalone schemas module so
// the prompt layer can reuse them without importing the tool runtime.
import { EMAIL, FAX_NUMBER } from "../schemas.js";

// Re-export for anyone who already depends on them being exposed here.
export { FAX_NUMBER, EMAIL };

const SENDER_PHONE = z
  .string()
  .refine(isValidE164, {
    message: "Must be a valid international (E.164) phone number, e.g. +13155550123",
  })
  .describe("Sender callback number shown on the cover page (E.164 format).");

export function registerFaxTools(server: McpServer, client: FaxDropClient): void {
  defineTool(
    server,
    "faxdrop_send_fax",
    [
      "Send a real fax via FaxDrop.",
      "",
      "USE WHEN: user needs to fax a document (PDF, DOCX, JPEG, PNG ≤10MB) to a fax number — medical records, legal forms, government submissions, recipients who only accept fax.",
      "",
      "DO NOT USE: for digital delivery (email, sftp), for files outside the outbox, for non-fax numbers — the 3-layer phone gate (TYPE → COUNTRY → per-number policy) rejects mobile/landline/premium.",
      "",
      "SIDE EFFECTS: charges FaxDrop balance (or consumes free credits + adds branded cover on free tier), creates an audit log entry, allocates a fax ID server-side. ALWAYS confirm recipient + file + cover with the user before calling.",
      "",
      "FILE LOCATION: document must live inside the outbox (default `~/FaxOutbox/`, override via FAXDROP_MCP_WORK_DIR). Files outside are rejected — ask the user to copy in first.",
      "",
      'RETURNS: `{ faxId, status: "queued", ... }` — poll with `faxdrop_get_fax_status`.',
    ].join("\n"),
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
    { title: "Send Fax", destructiveHint: true },
  );

  defineTool(
    server,
    "faxdrop_pair_number",
    [
      "Add a fax number to the per-recipient whitelist (paired.json).",
      "",
      "USE WHEN: server runs with FAXDROP_MCP_NUMBER_GATE=pairing and the user wants to pre-approve a recurring recipient (clinic, lawyer, supplier) so future `faxdrop_send_fax` calls skip the per-number confirmation step.",
      "",
      "DO NOT USE: when gate mode is `open` (no whitelist needed) or `closed` (whitelist edited out-of-band only — pairing rejected). For one-off faxes, skip pairing and call `faxdrop_send_fax` directly.",
      "",
      "SIDE EFFECTS: writes to `~/.faxdrop-mcp/paired.json` (or `$FAXDROP_MCP_STATE_DIR/paired.json`). Persistent across runs. ALWAYS confirm with the user — paired numbers can be faxed without further per-number approval.",
      "",
      "VALIDATION: TYPE + COUNTRY checks still apply (no bypass). Mobile/landline/premium numbers are rejected even at pairing time.",
      "",
      "RETURNS: `{ paired, country, type }`.",
    ].join("\n"),
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
    { title: "Pair Recipient Number", destructiveHint: false, idempotentHint: true },
  );

  defineTool(
    server,
    "faxdrop_get_fax_status",
    [
      "Check the delivery status of a previously sent fax.",
      "",
      "USE WHEN: polling for the outcome of a fax sent via `faxdrop_send_fax`. Status values: `queued` | `sending` | `delivered` | `failed` | `partial`.",
      "",
      "DO NOT USE: for faxes sent outside this MCP (no provenance — server returns 404). Once status is `delivered`, `failed`, or `partial`, STOP polling — these are terminal.",
      "",
      "SIDE EFFECTS: each non-cached call hits the FaxDrop API and counts toward its per-key rate limits (no monetary cost). Terminal results are cached process-wide.",
      "",
      "POLLING STRATEGY: every ~5s for the first 2 min, then every ~30s up to 10 min. Most US faxes complete in <90s.",
      "",
      "RETURNS: provider status object + optional `_cached: true` flag.",
    ].join("\n"),
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
    { title: "Get Fax Status", readOnlyHint: true },
  );
}
