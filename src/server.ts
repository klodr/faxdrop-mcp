import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FaxDropClient } from "./client.js";
import { registerAllTools } from "./tools/index.js";

// Kept in sync with package.json by scripts/sync-version.mjs (called by the
// `npm version` lifecycle hook). Do not edit manually — bump via
// `npm version patch|minor|major`.
export const VERSION = "0.3.5";

export interface ServerOptions {
  apiKey: string;
  /** Override the FaxDrop API base URL (e.g. for a self-hosted proxy). */
  baseUrl?: string;
  /** Custom logger for startup messages. Defaults to console.error. */
  log?: (msg: string) => void;
}

/**
 * Build a fully wired MCP server: FaxDrop client + middleware-wrapped tools.
 * Does NOT connect to any transport — the caller decides (stdio for production,
 * InMemoryTransport for tests).
 */
export function createServer(opts: ServerOptions): McpServer {
  const log = opts.log ?? ((msg: string) => console.error(msg));

  const client = new FaxDropClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });

  const server = new McpServer({
    name: "faxdrop-mcp",
    version: VERSION,
  });

  registerAllTools(server, client);

  if (opts.baseUrl) log(`FaxDrop base URL overridden → ${opts.baseUrl}`);

  return server;
}
