# faxdrop-mcp

> Send real faxes from any MCP-enabled AI assistant. Wraps the [FaxDrop](https://faxdrop.com) HTTP API.

[![CI](https://github.com/klodr/faxdrop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/klodr/faxdrop-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/klodr/faxdrop-mcp/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/klodr/faxdrop-mcp/security/code-scanning)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/klodr/faxdrop-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/klodr/faxdrop-mcp)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12578/badge)](https://www.bestpractices.dev/projects/12578)
[![Socket Security](https://socket.dev/api/badge/npm/package/faxdrop-mcp)](https://socket.dev/npm/package/faxdrop-mcp)

[![npm version](https://img.shields.io/npm/v/faxdrop-mcp.svg)](https://www.npmjs.com/package/faxdrop-mcp)
[![Node.js Version](https://img.shields.io/node/v/faxdrop-mcp.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-1.25-blue)](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/klodr/faxdrop-mcp/pulls)

A Model Context Protocol (MCP) server that lets AI assistants (Claude, Cursor, Continue, OpenClaw…) send real faxes through the [FaxDrop API](https://www.faxdrop.com/for-developers).

## Why this MCP?

Faxing is still required by US healthcare, government forms, and a long tail of legal/financial workflows. FaxDrop is a hosted fax service with a clean HTTP API and a free tier (2 faxes/month). This MCP exposes it to LLMs with the safeguards an agent platform actually needs.

### MCP wrapper vs calling the FaxDrop HTTP API directly

You *can* curl the FaxDrop API yourself or write a tiny `fetch` wrapper. What this MCP adds — and what you'd otherwise have to re-implement in every project that needs to send a fax from an agent:

| Concern | Raw HTTP call | This MCP |
|---|---|---|
| **Path-traversal safety** on the upload | up to you | Absolute-path check + extension allowlist + 10 MB cap, all enforced before the file is opened |
| **TOCTOU race** between size-check and read | up to you | File descriptor pinned with `fs.open()`, chunked read enforces the cap continuously |
| **Recipient number sanity** | up to you (FaxDrop returns 400 late) | E.164 regex validation at the Zod layer, before any network call |
| **Secret leakage** in logs / errors | up to you | `FaxDropError.toString/toJSON` strip the response body; audit log redacts `apiKey` / `authorization` / `password` / etc. (property-tested with fast-check) |
| **Dry-run mode** to test prompts | none — you'd have to fork your agent code | `FAXDROP_MCP_DRY_RUN=true` returns the would-be payload without calling FaxDrop |
| **Audit trail** | none | Opt-in `FAXDROP_MCP_AUDIT_LOG` — append-only JSON Lines, file mode `0o600`, sensitive fields redacted |
| **Error mapping** | raw 4xx/5xx body | Clean `isError: true` MCP response with `error_type`, `hint`, `retry_after` surfaced; explicit hints for HTTP 402 (no credits) and 429 (rate-limited) |
| **Plug-and-play with LLM clients** | write & maintain your own tool definitions | One `npx -y faxdrop-mcp` line in Claude Desktop, Claude Code, Cursor, Continue, or OpenClaw |
| **Supply-chain integrity** | n/a | Sigstore signing + SLSA in-toto attestation + npm provenance on every release ([verify](./SECURITY.md#verifying-releases)) |

Net: the MCP is a thin (~12 KB) wrapper that turns "expose a fax-sending capability to an agent" from a one-week security review into a one-line config change.

## Installation

```bash
npm install -g faxdrop-mcp
```

Or use directly with `npx`:

```bash
npx faxdrop-mcp
```

## Configuration

The server reads `FAXDROP_API_KEY` from the environment. Get your key at [faxdrop.com/account](https://faxdrop.com/account) (Developer API → Generate Key). Keys look like `fd_live_<32 hex>`.

### Claude Desktop / Claude Code

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (or `~/.claude.json` for Claude Code):

```json
{
  "mcpServers": {
    "faxdrop": {
      "command": "npx",
      "args": ["-y", "faxdrop-mcp"],
      "env": {
        "FAXDROP_API_KEY": "fd_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "faxdrop": {
      "command": "npx",
      "args": ["-y", "faxdrop-mcp"],
      "env": {
        "FAXDROP_API_KEY": "fd_live_..."
      }
    }
  }
}
```

### OpenClaw

Add to `~/.openclaw/openclaw.json`, then restart the gateway (`docker restart openclaw-openclaw-gateway-1` or your equivalent).

## Tools (2)

### `faxdrop_send_fax`

Send a fax. Uploads a local document to a fax number in international (E.164) format.

**Required:**
- `filePath` (string, absolute) — PDF, DOCX, JPEG, or PNG, ≤10 MB
- `recipientNumber` (string) — E.164, e.g. `+12125551234`
- `senderName` (string)
- `senderEmail` (string)

**Optional cover-page fields:**
- `includeCover` (boolean) — free accounts default to true; paid accounts default to false
- `coverNote` (string, ≤500) — message body
- `recipientName`, `subject`, `senderCompany`, `senderPhone`

**Returns:** `{ success, faxId, status, statusUrl }`

### `faxdrop_get_fax_status`

Check the delivery status of a previously sent fax.

**Required:**
- `faxId` (string) — the ID returned by `faxdrop_send_fax`

**Returns:** `{ id, status, recipientNumber, pages, completedAt, error? }`

Status values: `queued` | `sending` | `delivered` | `failed` | `partial`. Most US faxes complete in under 90 seconds.

## Safeguards

| Knob | Env var | Default | Notes |
|---|---|---|---|
| Dry run | `FAXDROP_MCP_DRY_RUN=true` | off | Write tools (`faxdrop_send_fax`) return the would-be payload (sensitive fields redacted) and never call FaxDrop. Reads still pass through. |
| Audit log | `FAXDROP_MCP_AUDIT_LOG=/abs/path/audit.log` | off | Append-only JSON Lines (file mode `0o600`). Sensitive args are redacted. |

Rate limiting is left to FaxDrop itself (10/min, 100/h, 500/day per key). 429 responses get `error_type: "rate_limited"` and a `retry_after` value, both surfaced to the caller.

`FaxDropError` responses are mapped to clean `isError: true` MCP responses with `error_type`, `hint`, and `retry_after`. HTTP 402 (no credits) and 429 (rate-limited) get explicit hints.

## Security

- **Always confirm with the user** (recipient, file, cover-page) before invoking `faxdrop_send_fax`. This is also baked into the tool description.
- The MCP reads files from the user's local filesystem — only expose this server to agents you trust.
- Test prompts safely with `FAXDROP_MCP_DRY_RUN=true`.
- See [SECURITY.md](./SECURITY.md) for the vulnerability reporting process.

## Contributing

PRs welcome. Before submitting:

- `npm test` (must stay green)
- `npm run build` (must succeed)
- `npm run lint` (must succeed)
- `CHANGELOG.md` updated under `[Unreleased]`

Releases are automated: bump `package.json` → merge release PR → `git tag -s vX.Y.Z && git push origin vX.Y.Z`. The release workflow extracts the matching CHANGELOG section, creates the GitHub Release, signs `dist/index.js` with Sigstore, and publishes to npm with provenance.

## License

MIT — see [LICENSE](./LICENSE).
