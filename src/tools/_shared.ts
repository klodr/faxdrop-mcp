import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodRawShape } from "zod";
import { wrapToolHandler, type ToolResult } from "../middleware.js";
import { sanitizeForLlm } from "../sanitize.js";

export type { ToolResult };
export type { ToolAnnotations };

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
  annotations?: ToolAnnotations,
): void {
  const wrapped = wrapToolHandler(name, handler);
  // MCP behavioral annotations (readOnlyHint / destructiveHint /
  // idempotentHint / openWorldHint) — declared machine-readable so
  // hosts and rubrics (TDQS / Glama Behavior dimension) can detect
  // tool semantics without scraping the prose description.
  server.registerTool(
    name,
    annotations ? { description, inputSchema, annotations } : { description, inputSchema },
    wrapped as never,
  );
}
