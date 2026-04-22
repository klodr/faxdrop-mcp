import { z } from "zod";

/**
 * Shared Zod validators used by both the tool registration layer
 * (`src/tools/fax.ts`) and the prompt registration layer
 * (`src/prompts/fax.ts`). Kept in a dedicated module so prompts do
 * not have to import the full tool runtime just to reuse two schemas
 * — smaller coupling, and any future validator tightening (country
 * whitelist, stricter E.164 regex, length cap) propagates to every
 * consumer with one edit.
 */

// `recipientNumber` is validated by validateAll() inside the fax-send
// handler — libphonenumber there emits the structured 3-layer
// diagnostic (parse / type / country / gate). A Zod refine would
// re-parse the same string and deliver a less informative error to
// the caller. So the schema here is deliberately lenient (non-empty
// string) and the serious validation lives in the handler.
export const FAX_NUMBER = z
  .string()
  .min(1)
  .describe(
    "Recipient fax number, international (E.164) format with leading + and country code, e.g. +12125551234",
  );

export const EMAIL = z.string().email().describe("Sender email for delivery confirmation.");

/**
 * Parse the comma-separated list of FaxDrop IDs that both the
 * `fax-history-summary` prompt arg validator and its body handler
 * need. Keeping this as one helper prevents the two sides from
 * drifting (different trim behaviour, different filter rules).
 */
export const parseFaxIds = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
