# faxdrop-mcp

> Send real faxes from any MCP-enabled AI assistant. Wraps the [FaxDrop](https://faxdrop.com) HTTP API.

[![CI](https://github.com/klodr/faxdrop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/klodr/faxdrop-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/klodr/faxdrop-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/klodr/faxdrop-mcp/actions/workflows/codeql.yml)
[![Tested with Vitest](https://img.shields.io/badge/tested%20with-vitest-yellow?logo=vitest&labelColor=black)](https://vitest.dev)
[![codecov](https://codecov.io/gh/klodr/faxdrop-mcp/branch/main/graph/badge.svg)](https://codecov.io/gh/klodr/faxdrop-mcp)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/klodr/faxdrop-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/klodr/faxdrop-mcp)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12578/badge)](https://www.bestpractices.dev/projects/12578)
[![Socket Security](https://socket.dev/api/badge/npm/package/faxdrop-mcp)](https://socket.dev/npm/package/faxdrop-mcp)
[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/klodr/faxdrop-mcp?utm_source=oss&utm_medium=github&utm_campaign=klodr%2Ffaxdrop-mcp&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)](https://coderabbit.ai)

[![npm version](https://img.shields.io/npm/v/faxdrop-mcp.svg)](https://www.npmjs.com/package/faxdrop-mcp)
[![npm downloads](https://img.shields.io/npm/dm/faxdrop-mcp.svg)](https://www.npmjs.com/package/faxdrop-mcp)
[![Node.js Version](https://img.shields.io/node/v/faxdrop-mcp.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-1.29-blue)](https://modelcontextprotocol.io)
[![MCP Server](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/klodr/faxdrop-mcp/pulls)

[![Sponsor on GitHub](https://img.shields.io/github/sponsors/klodr?logo=github-sponsors&label=GitHub%20Sponsors&color=EA4AAA)](https://github.com/sponsors/klodr)
[![Patreon](https://img.shields.io/badge/Patreon-F96854?logo=patreon&logoColor=white)](https://www.patreon.com/klodr)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/klodr)

A Model Context Protocol (MCP) server that lets AI assistants (Claude, Cursor, Continue, OpenClaw…) send real faxes through the [FaxDrop API](https://www.faxdrop.com/for-developers).

## Why this MCP?

Faxing is still required by US healthcare, government forms, and a long tail of legal/financial workflows. FaxDrop is a hosted fax service with a clean HTTP API and a free tier (2 faxes/month). This MCP exposes it to LLMs with the safeguards an agent platform actually needs.

### Why not just call the FaxDrop API directly?

You can. But every agent that does ends up re-implementing the same handful of guards. This MCP gives them to you for free:

- **Input validation** — absolute-path + extension + 10 MB cap on the upload (all before the file is opened); E.164 regex on the fax number; no SSRF, no path traversal.
- **TOCTOU-safe read** — file descriptor pinned with `fs.open()`, size enforced continuously while reading.
- **No secret leakage** — error objects strip the response body; audit log redacts `apiKey`/`authorization`/`password`/etc. (property-tested with fast-check).
- **Dry-run + audit log** — `FAXDROP_MCP_DRY_RUN=true` to test prompts without sending; `FAXDROP_MCP_AUDIT_LOG=/abs/path` for a JSONL trail (mode `0o600`).
- **Clean errors** — FaxDrop's 402 / 429 / 4xx surfaced as MCP `isError` with `error_type`, `hint`, `retry_after`.
- **Drop-in for any MCP client** — one `npx -y faxdrop-mcp` line in Claude Desktop / Code / Cursor / Continue / OpenClaw.
- **Verifiable releases** — Sigstore-signed + SLSA in-toto attestation + npm provenance ([verify](./SECURITY.md#verifying-releases)).

A ~12 KB wrapper that turns a one-week security review into a one-line config change.

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

## Tools (3)

### `faxdrop_send_fax`

Send a fax. Uploads a local document **from the outbox** (default `~/FaxOutbox/`) to a fax number in international (E.164) format.

**Required:**
- `filePath` (string, absolute) — PDF, DOCX, JPEG, or PNG, ≤10 MB. **Must live inside the outbox.**
- `recipientNumber` (string) — E.164, e.g. `+12125551234`. Subject to the 3-layer phone gate (TYPE → COUNTRY → per-number).
- `senderName` (string)
- `senderEmail` (string)

**Optional cover-page fields** (printed only when `includeCover` is true):
- `includeCover` (boolean) — free accounts always include a branded cover; paid accounts default to false
- `coverNote` (string, ≤500) — message body
- `recipientName` (≤50), `subject` (≤200), `senderCompany` (≤100), `senderPhone` (validated E.164)

**Returns:** `{ success, faxId, status, statusUrl }`

### `faxdrop_pair_number`

Add a fax number to the paired whitelist (`~/.faxdrop-mcp/paired.json`). Only effective when `FAXDROP_MCP_NUMBER_GATE=pairing` (default). The number must still pass the TYPE and COUNTRY checks (no bypass). **Always confirm with the user before pairing** — paired numbers can be faxed without further per-number approval.

**Required:**
- `recipientNumber` (string) — E.164

**Returns:** `{ paired, country, type }`

### `faxdrop_get_fax_status`

Check the delivery status of a previously sent fax. Terminal statuses (`delivered` / `failed` / `partial`) are cached process-wide (LRU 100 entries, whitelist-sliced) — re-polling a finished fax short-circuits with a `_cached: true` marker to spare your FaxDrop quota.

**Recommended polling cadence**: every ~5s for the first 2 min, then every ~30s for up to 10 min, **stop on terminal status**.

**Required:**
- `faxId` (string)

**Returns:** `{ id, status, recipientNumber?, pages?, completedAt?, _cached? }`

## Safeguards

| Knob | Env var | Default | Notes |
|---|---|---|---|
| Outbox jail | `FAXDROP_MCP_WORK_DIR=/abs/path` | `~/FaxOutbox/` (auto-created mode `0o700`) | Every `filePath` must live inside this directory after `realpath` canonicalization. Symlinks to outside the outbox are rejected. |
| Number gate | `FAXDROP_MCP_NUMBER_GATE=open\|pairing\|closed` | `pairing` | `pairing` requires HITL approval via `faxdrop_pair_number` before a new number can be faxed. `closed` disables runtime pairing (paired.json edited out-of-band). |
| Allowed types | `FAXDROP_MCP_ALLOWED_TYPES=...` | `FIXED_LINE,FIXED_LINE_OR_MOBILE,VOIP,TOLL_FREE` | libphonenumber `NumberType` allow-list. |
| Allowed countries | `FAXDROP_MCP_ALLOWED_COUNTRIES=...` | `US,CA,PR,GU,VI,AS,MP` | ISO-3166-1 alpha-2 allow-list (US/CA + US territories). |
| State directory | `FAXDROP_MCP_STATE_DIR=/abs/path` | `~/.faxdrop-mcp/` (mode `0o700`) | Where `paired.json` lives (mode `0o600`, atomic write). |
| Dry run | `FAXDROP_MCP_DRY_RUN=true` | off | Write tools (`faxdrop_send_fax`, `faxdrop_pair_number`) return the would-be payload (sensitive fields redacted) and never call FaxDrop or touch `paired.json`. |
| Audit log | `FAXDROP_MCP_AUDIT_LOG=/abs/path/audit.log` | off | Append-only JSON Lines (file mode `0o600`). Sensitive args are redacted. |

### Error catalog

Every failure is returned as `isError: true` with a structured `error_type`, `message`, and (when applicable) `hint` and `retry_after`. Programmatic consumers can match on `error_type` (in `structuredContent`) to drive retry logic.

| `error_type` | Layer | Trigger | Suggested action |
|---|---|---|---|
| `phone_parse` | input | Recipient number can't be parsed by libphonenumber. | Ask user for an E.164 number. |
| `phone_type` | policy | Phone type (e.g. MOBILE) not in `FAXDROP_MCP_ALLOWED_TYPES`. | Use a fax line, or extend the env var. |
| `phone_country` | policy | Country not in `FAXDROP_MCP_ALLOWED_COUNTRIES`. | Confirm with the user; extend the env var if intentional. |
| `phone_gate` | policy | Number not in `paired.json` and gate is `pairing` or `closed`. | In `pairing` mode: call `faxdrop_pair_number` first. In `closed`: edit `paired.json` out-of-band. |
| `pair_disabled` | policy | `faxdrop_pair_number` called outside `pairing` mode. | Set `FAXDROP_MCP_NUMBER_GATE=pairing`. |
| `bad_request` | filesystem | Path is relative, outside outbox, leaf-symlink, missing, oversized, or has an unsupported extension. | The accompanying `hint` describes the exact remedy. |
| `unauthorized` | upstream | FaxDrop returned 401. | Check `FAXDROP_API_KEY` in your MCP client config. |
| `payment_required` | upstream | FaxDrop returned 402 (out of credits). | Top up at the FaxDrop pricing page. |
| `rate_limited` | upstream | FaxDrop returned 429. | Wait `retry_after` seconds; the hint shows the bucket that was hit. |
| `invalid_response` | upstream | FaxDrop returned a non-JSON body (proxy interception, incident page). | Body is discarded for safety; check FaxDrop status page. |
| `fax_error` | upstream (fallback) | FaxDrop returned an error with no `error_type` field. | Read the message; treat as transient. |

### Rate limits & quotas

Two independent caps gate every fax send, both enforced by FaxDrop:

- **Per-key rate limits** (per-minute / per-hour / per-day buckets) — `429 rate_limited` with `retry_after` and `X-RateLimit-*` headers.
- **Account credit balance** — `402 payment_required` when you run out, with a top-up hint.

The MCP does **not** add its own limiter; it forwards FaxDrop's response as a clean `isError: true` with `error_type`, `hint`, and `retry_after`. See [FaxDrop's API docs](https://www.faxdrop.com/for-developers) for the current numbers.

## Security

- **Always confirm with the user** (recipient, file, cover-page) before invoking `faxdrop_send_fax`. This is also baked into the tool description.
- The MCP reads files from the user's local filesystem — only expose this server to agents you trust.
- Test prompts safely with `FAXDROP_MCP_DRY_RUN=true`.
- See [SECURITY.md](./SECURITY.md) for the vulnerability reporting process.

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the test/build/lint checklist and release process.

## License

MIT — see [LICENSE](./LICENSE).
