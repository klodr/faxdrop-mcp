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

/**
 * Tools that mutate state outside the process (i.e. actually send a fax).
 * Read-only tools bypass dry-run + audit log.
 */
const WRITE_TOOLS = new Set<string>(["faxdrop_send_fax"]);

export function isDryRun(): boolean {
  return process.env.FAXDROP_MCP_DRY_RUN === "true";
}

const SENSITIVE_KEYS = new Set([
  "apikey",
  "authorization",
  "password",
  "token",
  "secret",
  "x-api-key",
]);

export function redactSensitive(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redactSensitive(v);
  }
  return out;
}

export function logAudit(
  toolName: string,
  args: unknown,
  result: "ok" | "dry-run" | "error"
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

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

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
  handler: (args: TArgs) => Promise<ToolResult>
): (args: TArgs) => Promise<ToolResult> {
  const isWriteOp = WRITE_TOOLS.has(toolName);

  return async (args: TArgs): Promise<ToolResult> => {
    if (isWriteOp && isDryRun()) {
      logAudit(toolName, args, "dry-run");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                dryRun: true,
                tool: toolName,
                wouldCallWith: redactSensitive(args),
                note: "FAXDROP_MCP_DRY_RUN=true; no actual fax was sent. Sensitive fields are redacted.",
              },
              null,
              2
            ),
          },
        ],
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
            ? " (No fax credits remaining — see https://faxdrop.com/pricing.)"
            : err.status === 429 && err.retryAfter
              ? ` (Rate-limited by FaxDrop; retry in ${err.retryAfter}s.)`
              : err.hint
                ? ` Hint: ${err.hint}`
                : "";
        return {
          content: [
            {
              type: "text",
              text: `FaxDrop API error ${err.status}${err.errorType ? ` (${err.errorType})` : ""}: ${err.message}${hint}`,
            },
          ],
          isError: true,
        };
      }
      throw err;
    }
  };
}
