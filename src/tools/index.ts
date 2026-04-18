import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FaxDropClient } from "../client.js";
import { registerFaxTools } from "./fax.js";

/**
 * Register all FaxDrop MCP tools on the server.
 */
export function registerAllTools(server: McpServer, client: FaxDropClient): void {
  registerFaxTools(server, client);
}
