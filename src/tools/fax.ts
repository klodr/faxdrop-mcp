import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, textResult } from "./_shared.js";
import { FaxDropClient } from "../client.js";

// E.164-ish: leading +, country code, 6–14 more digits.
const FAX_NUMBER = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Must be E.164 format, e.g. +12125551234")
  .describe("Recipient fax number, international (E.164) format with leading + and country code, e.g. +12125551234");

const EMAIL = z.string().email().describe("Sender email for delivery confirmation.");

export function registerFaxTools(server: McpServer, client: FaxDropClient): void {
  defineTool(
    server,
    "faxdrop_send_fax",
    "Send a fax via FaxDrop. Uploads a local file (PDF, DOCX, JPEG, or PNG, ≤10MB) to a fax number in E.164 format. Returns the FaxDrop fax ID for status polling. ALWAYS confirm with the user (recipient number, file path, cover page details) before calling this tool.",
    {
      filePath: z
        .string()
        .min(1)
        .describe(
          "Absolute path to the document to fax (PDF, DOCX, JPEG, or PNG, ≤10MB)."
        ),
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
          "Include a FaxDrop cover page. Free accounts default to true; paid accounts default to false."
        ),
      coverNote: z
        .string()
        .max(500)
        .optional()
        .describe("Message shown on the cover page (max 500 chars)."),
      recipientName: z
        .string()
        .max(200)
        .optional()
        .describe("Recipient display name shown on the cover page."),
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
      senderPhone: z
        .string()
        .max(30)
        .optional()
        .describe("Sender callback number shown on the cover page."),
    },
    async (args) => {
      const data = await client.sendFax(args);
      return textResult(data);
    }
  );

  defineTool(
    server,
    "faxdrop_get_fax_status",
    "Check the delivery status of a previously sent fax. Status values: queued | sending | delivered | failed | partial. Most US faxes complete in under 90 seconds.",
    {
      faxId: z
        .string()
        .min(1)
        .describe("The fax ID returned by faxdrop_send_fax (e.g. fax_abc123)."),
    },
    async ({ faxId }) => {
      const data = await client.getFaxStatus(faxId);
      return textResult(data);
    }
  );
}
