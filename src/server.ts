import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import ipaddr from "ipaddr.js";
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
 * operator) can exfiltrate the full trust radius in cleartext by pointing
 * this at `http://attacker.example`.
 *
 * Rules:
 *
 *   - HTTPS required (rejects http, file, data, ftp, etc.).
 *   - RFC 6761 `.localhost` namespace blocked (covers `localhost`,
 *     `localhost.`, `foo.localhost`, `foo.localhost.`).
 *   - IP-literal classification delegated to `ipaddr.js` — accept only
 *     the `unicast` range. Rejects loopback, RFC 1918 private,
 *     RFC 3927 link-local, RFC 6598 carrier-grade NAT,
 *     RFC 2544 benchmarking, RFC 5737 documentation, multicast,
 *     IPv6 ULA, IPv6 link-local, and any other reserved range
 *     without us having to maintain a hand-rolled CIDR list. This
 *     mirrors the same `ipaddr.js`-based validator used by
 *     `klodr/mercury-invoicing-mcp` for `MERCURY_API_BASE_URL`.
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
  // IPv6 ([::1], [fe80::1]); strip them before range checks. The brackets
  // are also our DNS-vs-IPv6-literal discriminator: an unbracketed hex-like
  // hostname (e.g. `fc00-proxy.example.com`) is DNS, not IPv6.
  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

  // RFC 6761 — `.localhost` is reserved for loopback by spec; reject the
  // whole namespace, including the bare hostname `localhost`, the trailing-
  // dot form `localhost.`, and subdomains like `foo.localhost` /
  // `api.staging.localhost.`.
  if (
    host === "localhost" ||
    host === "localhost." ||
    host.endsWith(".localhost") ||
    host.endsWith(".localhost.")
  ) {
    throw new Error(
      `FAXDROP_API_BASE_URL must not use the .localhost namespace (got host: ${host}). ` +
        `RFC 6761 reserves *.localhost for loopback — only public HTTPS endpoints are allowed.`,
    );
  }

  // If the host parses as an IP literal, classify it via `ipaddr.js` and
  // accept only the `unicast` range. Covers every IANA-tracked reserved
  // range (loopback, private, linkLocal, carrierGradeNat, benchmarking,
  // documentation, multicast, uniqueLocal, reserved, etc.). IPv4-mapped
  // IPv6 (`::ffff:a.b.c.d`, `::ffff:7f00:1`) is normalised by ipaddr.js
  // into the underlying IPv4 range.
  if (ipaddr.isValid(host)) {
    const range = ipaddr.process(host).range();
    if (range !== "unicast") {
      throw new Error(
        `FAXDROP_API_BASE_URL must be publicly reachable. Got ${host} which falls in the "${range}" range — ` +
          `the bearer API key + every fax payload would be sent to a non-public address.`,
      );
    }
  }
  // DNS hostnames that don't parse as an IP literal are accepted here.
  // The FaxDrop client will reject them at request time if they don't
  // resolve to a usable target.
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
