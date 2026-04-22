/**
 * MCP middleware: dry-run, audit log, FaxDrop error mapping.
 *
 * Rate limiting is intentionally NOT done here — FaxDrop publishes its own
 * limits (10/min, 100/h, 500/day with X-RateLimit-* headers) and returns
 * 429 with retry_after, which we surface back to the caller below.
 */

import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { FaxDropError } from "./client.js";
import { sanitizeForLlm } from "./sanitize.js";

/**
 * Tools that mutate state outside the in-memory tool handler (sending a
 * fax over the wire OR persisting trust expansion to disk). Read-only
 * tools bypass dry-run + audit log.
 *
 * `faxdrop_pair_number` writes to paired.json — exactly the kind of trust
 * expansion you want recorded in the audit log, and that you want
 * dry-run-friendly during setup.
 */
const WRITE_TOOLS = new Set<string>(["faxdrop_send_fax", "faxdrop_pair_number"]);

export function isDryRun(): boolean {
  return process.env.FAXDROP_MCP_DRY_RUN === "true";
}

/**
 * Lower-case names of fields that are fully redacted to `[REDACTED]` as a
 * defense-in-depth layer — these never appear in logs regardless of
 * allowlist rules. API keys & co.
 *
 * Exported so test/fuzz.test.ts uses the canonical list (avoids drift).
 * Frozen at runtime because `as const` only widens the type.
 */
export const SENSITIVE_KEYS = Object.freeze([
  "apikey",
  "authorization",
  "password",
  "token",
  "secret",
  "x-api-key",
] as const);

const SENSITIVE_KEYS_SET: ReadonlySet<string> = new Set(SENSITIVE_KEYS);

/**
 * Keys that ARE surfaced in the audit log, in clear. Intentionally narrow:
 * this is the intersection of "fields the FaxDrop API returns in its
 * response" and "operational metadata needed to reconstruct a delivery
 * receipt". Anything absent from this set is elided — so a prompt-injected
 * cover note, a leaking filesystem path, or a sender email never lands in
 * the audit log.
 *
 * The list mirrors the FaxDrop status response shape verbatim:
 *   { id, status, recipientNumber, pages, completedAt, error }
 * plus `faxId` (the args-side name for the same `id` on status polls).
 */
export const AUDIT_SAFE_KEYS = Object.freeze([
  "recipientNumber", // delivery receipt: where the fax went
  "faxId", // args-side name for the response `id` field
  "id", // response-side name
  "status", // queued | sending | delivered | failed | partial
  "pages", // page count on completion
  "completedAt", // ISO timestamp on completion
  "error", // error message on failure
] as const);

const AUDIT_SAFE_KEYS_SET: ReadonlySet<string> = new Set(AUDIT_SAFE_KEYS);

/**
 * Redact a value for the audit log using an allowlist strategy:
 *
 *   - keys in AUDIT_SAFE_KEYS (the FaxDrop response fields) are kept in clear
 *   - keys in SENSITIVE_KEYS are replaced with "[REDACTED]"
 *   - everything else is elided with a length marker so a reader sees that
 *     a field was present without seeing its contents:
 *       "filePath":  "[ELIDED:42 chars]"
 *       "coverNote": "[ELIDED:137 chars]"
 *       "attachments": "[ELIDED:3 items]"
 *
 * The goal: the audit log records the delivery receipt (who we faxed, what
 * the API said about it) but never leaks the message content, the sender's
 * identity, or the local filesystem paths that carried the payload. A
 * single regex pass can show "was fax X delivered to +1212…?" without
 * exposing the letter body or the ops setup.
 */
export function redactForAudit(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return `[ELIDED:${value.length} items]`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (SENSITIVE_KEYS_SET.has(lower)) {
      out[k] = "[REDACTED]";
    } else if (AUDIT_SAFE_KEYS_SET.has(k)) {
      // Pass through; still recurse so nested objects also follow the rule.
      out[k] = typeof v === "object" && v !== null ? redactForAudit(v) : v;
    } else if (typeof v === "string") {
      out[k] = `[ELIDED:${v.length} chars]`;
    } else if (Array.isArray(v)) {
      out[k] = `[ELIDED:${v.length} items]`;
    } else if (typeof v === "object") {
      out[k] = "[ELIDED]";
    } else {
      // boolean / number / null / undefined: safe to keep as a type marker
      out[k] = `[ELIDED:${typeof v}]`;
    }
  }
  return out;
}

/**
 * Backward-compat alias. The dry-run payload and the error surface still
 * call `redactSensitive(args)`; they now go through the same audit-scoped
 * redaction. No caller relied on the older "only mask credential keys"
 * behaviour in a way that would leak PHI — so it is safe to tighten here.
 */
export const redactSensitive = redactForAudit;

export function logAudit(
  toolName: string,
  args: unknown,
  result: "ok" | "dry-run" | "error",
  response?: unknown,
): void {
  const path = process.env.FAXDROP_MCP_AUDIT_LOG;
  if (!path) return;
  if (!isAbsolute(path)) {
    console.error(`[audit] FAXDROP_MCP_AUDIT_LOG must be an absolute path; got: ${path}`);
    return;
  }
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    tool: toolName,
    result,
    args: redactForAudit(args),
    ...(response !== undefined ? { response: redactForAudit(response) } : {}),
  });
  try {
    appendFileSync(path, entry + "\n", { mode: 0o600 });
  } catch (err) {
    console.error(`[audit] failed to write to ${path}:`, (err as Error).message);
  }
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  /**
   * Per MCP spec (2025-06-18+), the parseable JSON form of the response.
   * `content[0].text` is sanitized + fence-wrapped for safe LLM display
   * and is NOT JSON-parseable; programmatic consumers should read
   * `structuredContent` instead.
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Wrap a tool handler with dry-run + audit + FaxDrop error mapping.
 *
 * - Dry-run: when FAXDROP_MCP_DRY_RUN=true, write tools return a mock
 *   response without calling FaxDrop (sensitive args redacted).
 * - Audit: writes a JSONL entry to FAXDROP_MCP_AUDIT_LOG (if set, absolute
 *   path, file mode 0o600, sensitive fields redacted).
 * - Error mapping: FaxDropError is returned as a clean isError:true response
 *   with type/hint/retry-after surfaced to the caller. Other errors propagate.
 */
export function wrapToolHandler<TArgs>(
  toolName: string,
  handler: (args: TArgs) => Promise<ToolResult>,
): (args: TArgs) => Promise<ToolResult> {
  const isWriteOp = WRITE_TOOLS.has(toolName);

  return async (args: TArgs): Promise<ToolResult> => {
    if (isWriteOp && isDryRun()) {
      logAudit(toolName, args, "dry-run");
      const dryPayload = {
        dryRun: true,
        tool: toolName,
        wouldCallWith: redactSensitive(args),
        note: "FAXDROP_MCP_DRY_RUN=true; no actual fax was sent. Sensitive fields are redacted.",
      };
      return {
        content: [{ type: "text", text: sanitizeForLlm(JSON.stringify(dryPayload, null, 2)) }],
        structuredContent: dryPayload,
      };
    }

    try {
      const result = await handler(args);
      if (isWriteOp) logAudit(toolName, args, "ok", result.structuredContent);
      return result;
    } catch (err) {
      logAudit(toolName, args, "error");
      if (err instanceof FaxDropError) {
        const hint =
          err.status === 402
            ? " (No fax credits remaining — top up at https://faxdrop.com/pricing)"
            : err.status === 429 && err.retryAfter
              ? ` (Rate-limited by FaxDrop; retry in ${err.retryAfter}s.)`
              : err.hint
                ? ` Hint: ${err.hint}`
                : "";
        // err.message and err.hint can be reflected from the FaxDrop API
        // body (attacker-influenced), so route them through sanitize+fence
        // and surface the structured form for programmatic consumers.
        const errorPayload = {
          error_type: err.errorType ?? "fax_error",
          status: err.status,
          message: err.message,
          hint: err.hint,
          retryAfter: err.retryAfter,
        };
        return {
          content: [
            {
              type: "text",
              text: sanitizeForLlm(
                `FaxDrop API error ${err.status}${err.errorType ? ` (${err.errorType})` : ""}: ${err.message}${hint}`,
              ),
            },
          ],
          structuredContent: errorPayload,
          isError: true,
        };
      }
      throw err;
    }
  };
}
