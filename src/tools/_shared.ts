import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodRawShape } from "zod";
import { wrapToolHandler, type ToolResult } from "../middleware.js";
import { sanitizeForLlm } from "../sanitize.js";

export type { ToolResult };

function asStructured(data: unknown): Record<string, unknown> {
  // structuredContent must be a JSON object (per MCP spec). Wrap primitives
  // and arrays in `{ value: ... }` so the field is always present and the
  // shape is consistent.
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { value: data };
}

export function textResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: sanitizeForLlm(JSON.stringify(data, null, 2)) }],
    structuredContent: asStructured(data),
  };
}

export function errorResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: sanitizeForLlm(JSON.stringify(data, null, 2)) }],
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
): void {
  const wrapped = wrapToolHandler(name, handler);
  server.registerTool(name, { description, inputSchema }, wrapped as never);
}
