/**
 * MCP middleware: dry-run, rate limiting, audit log.
 */

import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { FaxDropError } from "./client.js";

const TOOL_CATEGORIES: Record<string, string> = {
  faxdrop_send_fax: "send",
};

// FaxDrop's documented limits are 10/min, 100/hour, 500/day per API key.
// We enforce a daily ceiling well below the API's hard limit so that a
// single misbehaving agent cannot burn the user's whole quota in a loop.
const DEFAULT_LIMITS_PER_DAY: Record<string, number> = {
  send: 100,
};

interface ParsedRate {
  count: number;
  windowMs: number;
}

function parseRate(raw: string): ParsedRate | null {
  const m = raw.match(/^(\d+)\s*\/\s*(minute|hour|day|week)$/i);
  if (!m) return null;
  const count = Number(m[1]);
  const unit = m[2].toLowerCase();
  const windowMs =
    unit === "minute"
      ? 60_000
      : unit === "hour"
        ? 3600_000
        : unit === "day"
          ? 86400_000
          : 604800_000;
  return { count, windowMs };
}

function getRateLimit(category: string): ParsedRate | null {
  const envKey = `FAXDROP_MCP_RATE_LIMIT_${category}`;
  const raw = process.env[envKey];
  if (raw) {
    const parsed = parseRate(raw);
    if (parsed) return parsed;
    console.error(
      `Invalid rate limit format for ${envKey}: "${raw}" — expected like "100/day". Using default.`
    );
  }
  const defaultCount = DEFAULT_LIMITS_PER_DAY[category];
  if (defaultCount === undefined) return null;
  return { count: defaultCount, windowMs: 86400_000 };
}

const callHistory = new Map<string, number[]>();

/** Reset in-memory call history. Useful for tests. */
export function resetRateLimitHistory(): void {
  callHistory.clear();
}

export class RateLimitError extends Error {
  constructor(
    public toolName: string,
    public category: string,
    public limit: number,
    public windowMs: number,
    public retryAfterMs: number
  ) {
    const win =
      windowMs === 86400_000
        ? "day"
        : windowMs === 3600_000
          ? "hour"
          : windowMs === 60_000
            ? "minute"
            : `${Math.round(windowMs / 1000)}s`;
    const retrySec = Math.ceil(retryAfterMs / 1000);
    super(
      `Rate limit exceeded for ${toolName} (category: ${category}, limit: ${limit}/${win}). Retry in ${retrySec}s. ` +
        `Override with FAXDROP_MCP_RATE_LIMIT_${category}=N/day if this is a legitimate batch.`
    );
    this.name = "RateLimitError";
  }
}

export function enforceRateLimit(toolName: string): void {
  if (process.env.FAXDROP_MCP_RATE_LIMIT_DISABLE === "true") return;

  const category = TOOL_CATEGORIES[toolName];
  if (!category) return;

  const rl = getRateLimit(category);
  if (!rl) return;

  const now = Date.now();
  const records = (callHistory.get(category) ?? []).filter(
    (ts) => now - ts < rl.windowMs
  );

  if (records.length >= rl.count) {
    const retryAfterMs = rl.windowMs - (now - records[0]);
    throw new RateLimitError(toolName, category, rl.count, rl.windowMs, retryAfterMs);
  }

  records.push(now);
  callHistory.set(category, records);
}

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

export function logAudit(toolName: string, args: unknown, result: "ok" | "dry-run" | "error"): void {
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
 * Wrap a tool handler with rate limit, dry-run, and audit middleware.
 * - Rate limit: throws RateLimitError if exceeded
 * - Dry-run: returns a mock response without calling FaxDrop
 * - Audit log: writes structured entry to FAXDROP_MCP_AUDIT_LOG if set
 */
export function wrapToolHandler<TArgs>(
  toolName: string,
  handler: (args: TArgs) => Promise<ToolResult>
): (args: TArgs) => Promise<ToolResult> {
  const isWriteOp = toolName in TOOL_CATEGORIES;

  return async (args: TArgs): Promise<ToolResult> => {
    if (isWriteOp) {
      try {
        enforceRateLimit(toolName);
      } catch (err) {
        if (err instanceof RateLimitError) {
          logAudit(toolName, args, "error");
          return {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          };
        }
        throw err;
      }
    }

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
