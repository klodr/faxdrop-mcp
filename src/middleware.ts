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
 * Lower-case names of fields that must never appear in audit logs, dry-run
 * payloads, or error responses. Exported so test/fuzz.test.ts uses the
 * canonical list (avoids drift between implementation and properties).
 *
 * Frozen at runtime: `as const` only widens the type, so without
 * Object.freeze the exported array would still be mutable from outside the
 * module. Freezing locks it down at runtime too.
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

export function redactSensitive(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS_SET.has(k.toLowerCase()) ? "[REDACTED]" : redactSensitive(v);
  }
  return out;
}

export function logAudit(
  toolName: string,
  args: unknown,
  result: "ok" | "dry-run" | "error",
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
    args: redactSensitive(args),
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
      if (isWriteOp) logAudit(toolName, args, "ok");
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
