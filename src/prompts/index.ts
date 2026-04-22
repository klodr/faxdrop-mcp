import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFaxPrompts } from "./fax.js";

/**
 * Register all user-facing prompts (slash commands) on the server.
 * Declaring any prompt via `server.registerPrompt` automatically enables
 * the `prompts` capability on the init handshake.
 */
export function registerAllPrompts(server: McpServer): void {
  registerFaxPrompts(server);
}
