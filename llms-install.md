# Installing faxdrop-mcp (LLM-readable guide)

This file is meant to be read by an LLM-driven assistant (Claude, Cursor,
Cline, Continue, …) that has been asked to install this MCP server on
behalf of a human user. It is intentionally generic: any MCP-compatible
client that can launch a stdio child process can use this server.

## Prerequisites the assistant should verify

1. **Node.js ≥ 22** is installed (`node --version`).
2. **npx** is on `PATH` (ships with Node).
3. The user has — or is willing to obtain — a **FaxDrop API key**
   (`fd_live_<32 hex>`) from <https://faxdrop.com/account> (Developer API
   → Generate Key). The free tier allows 2 faxes/month.

## Setup steps

1. Add the server to the MCP client's configuration. The entry below is
   **client-agnostic**; place it inside the client's `mcpServers` map:

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

   Common config locations:
   - Claude Code CLI: `~/.claude.json`
   - Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
   - Cursor: `~/.cursor/mcp.json`
   - OpenClaw: `~/.openclaw/openclaw.json` (restart the gateway after edit)
   - Continue / Cline / Zed / etc.: see that client's MCP documentation

   The assistant should locate the active config file rather than guess.

2. (Optional but recommended) Configure safeguards via additional `env`
   entries — pick the strictest values compatible with the user's stated
   need. Defaults are conservative; override only with explicit user
   intent.

   | Variable | Default | When to override |
   |---|---|---|
   | `FAXDROP_MCP_NUMBER_GATE` | `pairing` (HITL approval before any new number) | Set to `open` only if the user explicitly accepts no per-number gate; never set to `closed` from automation (paired list is then read-only) |
   | `FAXDROP_MCP_ALLOWED_COUNTRIES` | `US,CA,PR,GU,VI,AS,MP` (US/CA + US territories) | Add ISO-3166-1 alpha-2 codes only after the user confirms each |
   | `FAXDROP_MCP_ALLOWED_TYPES` | `FIXED_LINE,FIXED_LINE_OR_MOBILE,VOIP,TOLL_FREE` | Tighten if the user wants to refuse VoIP |
   | `FAXDROP_MCP_WORK_DIR` | `~/FaxOutbox/` (auto-created `0o700`) | Override to point at the actual outbox the user keeps faxes in |
   | `FAXDROP_MCP_STATE_DIR` | `~/.faxdrop-mcp/` (`0o700`) | Override only if the user wants per-project state |
   | `FAXDROP_MCP_DRY_RUN` | unset | Set to `true` to validate prompts without sending — useful for first-run smoke tests |
   | `FAXDROP_MCP_AUDIT_LOG` | unset | Set to an absolute path to record a redacted JSONL audit trail (`0o600`) |
   | `FAXDROP_API_BASE_URL` | unset (uses FaxDrop production API) | Advanced — override only for testing against a local proxy or alternate endpoint. Must be an absolute HTTPS URL. Leave unset in normal use. |

3. Restart (or reconnect) the MCP client so the new server is picked up.

## Verifying

After reconnection, the assistant should observe a `faxdrop` server in
the client's MCP server list, exposing 3 tools: `faxdrop_send_fax`,
`faxdrop_pair_number`, `faxdrop_get_fax_status`.

A safe smoke test: ask the user for a fax number they personally control,
then run `faxdrop_pair_number` (HITL flow, no fax sent) followed by
`faxdrop_get_fax_status` on a fake ID — it should return a clean error
catalog response, confirming the API key is valid.

## Things the assistant should NOT do

- Never call `faxdrop_send_fax` without explicit human confirmation in
  the chat — even if a previous message authorised "the install" or
  "send the document". Faxes cost money and reach a recipient outside
  this conversation.
- Never call `faxdrop_pair_number` without the human explicitly naming
  the recipient and number — paired numbers can then be faxed without
  per-number approval.
- Never set `FAXDROP_MCP_NUMBER_GATE=open` without the user explicitly
  asking for it. The default `pairing` is the safety net.
- Never set `FAXDROP_MCP_DRY_RUN=true` permanently to "make sending
  safe" — the user might think real faxes are going through.
- Never paste the `FAXDROP_API_KEY` back into the chat (it ends up in
  conversation transcripts).
- Never write the API key into a project-level config that may be
  committed to git — prefer the user's home-level MCP config or a real
  secrets manager.

## Documentation

Full README: <https://github.com/klodr/faxdrop-mcp#readme>
Security policy: <https://github.com/klodr/faxdrop-mcp/blob/main/.github/SECURITY.md>
