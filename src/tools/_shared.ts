import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodRawShape } from "zod";
import { wrapToolHandler, type ToolResult } from "../middleware.js";
import { sanitizeForLlm } from "../sanitize.js";

function asStructured(data: unknown): Record<string, unknown> {
  // structuredContent must be a JSON object (per MCP spec). Wrap primitives
  // and arrays in `{ value: ... }` so the field is always present and the
  // shape is consistent.
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { value: data };
}

// JSON.stringify(undefined) returns undefined (not a string) — sanitizeForLlm
// would then crash on .replace(). Coerce to a JSON-valid representation.
function jsonText(data: unknown): string {
  // TS types `JSON.stringify` as `string` but `JSON.stringify(undefined)`
  // is actually `undefined` at runtime. The `??` is the real coercion.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return JSON.stringify(data, null, 2) ?? "null";
}

export function textResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: sanitizeForLlm(jsonText(data)) }],
    structuredContent: asStructured(data),
  };
}

export function errorResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: sanitizeForLlm(jsonText(data)) }],
    structuredContent: asStructured(data),
    isError: true,
  };
}

export function defineTool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  annotations: ToolAnnotations,
): void {
  const wrapped = wrapToolHandler(name, handler);
  // MCP behavioral annotations (readOnlyHint / destructiveHint /
  // idempotentHint / openWorldHint) — declared machine-readable so
  // hosts and rubrics (TDQS / Glama Behavior dimension) can detect
  // tool semantics without scraping the prose description. Required
  // (not optional) so every new tool ships with explicit semantics —
  // forgetting the annotation now fails typecheck instead of
  // silently shipping a tool with no hint set.
  server.registerTool(name, { description, inputSchema, annotations }, wrapped as never);
}

export { type ToolResult } from "../middleware.js";
export { type ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
