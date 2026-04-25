import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FaxDropClient } from "./client.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllPrompts } from "./prompts/index.js";

// Kept in sync with package.json by scripts/sync-version.mjs (called by the
// `npm version` lifecycle hook). Do not edit manually — bump via
// `npm version patch|minor|major`.
export const VERSION = "0.5.0";

export interface ServerOptions {
  apiKey: string;
  /** Override the FaxDrop API base URL (e.g. for a self-hosted proxy). */
  baseUrl?: string;
  /** Custom logger for startup messages. Defaults to console.error. */
  log?: (msg: string) => void;
}

/**
 * Validate an operator-supplied `FAXDROP_API_BASE_URL` (or the
 * `baseUrl` createServer option). The bearer API key + every fax payload
 * + every recipient number is sent to this URL — bypassing the validation
 * means an attacker who tampered with the launcher env (or a misconfigured
 * operator) can exfiltrate the full Mercury-style trust radius in cleartext
 * by pointing this at `http://attacker.example`.
 *
 * Mirrors the strict outbound webhook URL validator in
 * `klodr/mercury-invoicing-mcp` (`src/tools/webhooks.ts:HttpsWebhookUrl`):
 *
 *   - Reject anything other than `https:` (no http, file, data, ftp, …).
 *   - Reject loopback (`localhost`, `127.0.0.0/8`, `::1`).
 *   - Reject the RFC 6761 `.localhost` namespace and `*.localhost` subdomains.
 *   - Reject IPv4 RFC 1918 (`10/8`, `172.16/12`, `192.168/16`).
 *   - Reject link-local + cloud-metadata (`169.254/16`).
 *   - Reject the unspecified address (`0.0.0.0/8`).
 *   - Reject IPv6 ULA (`fc00::/7`) and IPv6 link-local (`fe80::/10`).
 *
 * Throws on rejection — the server fails fast at startup rather than
 * silently routing to an attacker-controlled host.
 */
export function validateBaseUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `FAXDROP_API_BASE_URL is not a valid URL: ${raw}. Use an https:// URL like https://www.faxdrop.com.`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `FAXDROP_API_BASE_URL must use https:// (got ${parsed.protocol}//). ` +
        `http, file, data, ftp, etc. are rejected to prevent cleartext exfiltration of the API key + fax payloads.`,
    );
  }
  // Unwrap bracketed IPv6 literals — `URL().hostname` keeps the brackets for
  // IPv6 ([::1], [fe80::1]); strip them before range checks.
  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

  if (host === "::1") {
    throw new Error(
      `FAXDROP_API_BASE_URL must not point at IPv6 loopback (got host: ${host}). ` +
        `The bearer API key + every fax payload would be sent to this address — only public HTTPS endpoints are allowed.`,
    );
  }
  // RFC 6761 — `.localhost` is reserved for loopback by spec; reject the
  // whole namespace, including the bare hostname `localhost` and subdomains
  // like `foo.localhost` / `api.staging.localhost`.
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(
      `FAXDROP_API_BASE_URL must not use the .localhost namespace (got host: ${host}). ` +
        `RFC 6761 reserves *.localhost for loopback — only public HTTPS endpoints are allowed.`,
    );
  }

  // IPv4 numeric CIDR matching — `startsWith()`-based prefix checks would
  // miss e.g. `127.0.0.2` if the gate were `127.0.0.1`.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (
      a === 0 || //                              0.0.0.0/8      "this host"/unspecified
      a === 127 || //                            127.0.0.0/8    loopback
      a === 10 || //                             10.0.0.0/8     RFC 1918
      (a === 169 && b === 254) || //             169.254.0.0/16 link-local + cloud metadata
      (a === 192 && b === 168) || //             192.168.0.0/16 RFC 1918
      (a === 172 && b >= 16 && b <= 31) //       172.16.0.0/12  RFC 1918
    ) {
      throw new Error(
        `FAXDROP_API_BASE_URL must not point at a private/loopback/link-local IPv4 address (got host: ${host}). ` +
          `Loopback, RFC 1918, link-local, and cloud-metadata ranges are rejected to prevent SSRF and exfiltration.`,
      );
    }
  }

  // IPv6 CIDR bitmask check on the first hextet:
  //   fc00::/7  → first 7 bits = 0b1111110 → mask 0xfe00, match 0xfc00
  //   fe80::/10 → first 10 bits = 0b1111111010 → mask 0xffc0, match 0xfe80
  const firstHextet = Number.parseInt(host.split(":")[0], 16);
  if (!Number.isNaN(firstHextet)) {
    if ((firstHextet & 0xfe00) === 0xfc00) {
      throw new Error(
        `FAXDROP_API_BASE_URL must not point at an IPv6 ULA address (got host: ${host}). ` +
          `fc00::/7 is rejected to prevent SSRF and exfiltration.`,
      );
    }
    if ((firstHextet & 0xffc0) === 0xfe80) {
      throw new Error(
        `FAXDROP_API_BASE_URL must not point at an IPv6 link-local address (got host: ${host}). ` +
          `fe80::/10 is rejected to prevent SSRF and exfiltration.`,
      );
    }
  }
}

/**
 * Build a fully wired MCP server: FaxDrop client + middleware-wrapped tools.
 * Does NOT connect to any transport — the caller decides (stdio for production,
 * InMemoryTransport for tests).
 */
export function createServer(opts: ServerOptions): McpServer {
  const log = opts.log ?? ((msg: string) => console.error(msg));

  // Validate the operator-supplied base URL BEFORE constructing the client —
  // an invalid override fails the server startup, never silently routes to
  // http:// or a private host.
  if (opts.baseUrl) validateBaseUrl(opts.baseUrl);

  const client = new FaxDropClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });

  const server = new McpServer({
    name: "faxdrop-mcp",
    version: VERSION,
  });

  registerAllTools(server, client);
  registerAllPrompts(server);

  if (opts.baseUrl) log(`FaxDrop base URL overridden → ${opts.baseUrl}`);

  return server;
}
