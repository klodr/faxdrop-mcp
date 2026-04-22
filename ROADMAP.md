# Roadmap

**Maintenance mode.** Fax is a one-way business (outbound send + status polling) and this MCP already covers that surface end-to-end. There is no plan to add inbound-fax receive, complex workflow layers, or feature bloat. The long-term intent is **keep it stable, keep it secure, keep it small**.

## What that means in practice

- **Node.js 22 migration — deadline 2026-04-30** — Node 20 reaches security-support EOL on April 30, 2026. Bump `engines.node` to `>=22.0.0`, retarget `tsup.config.ts` to `node22`, pin the Dockerfile to `node:22-alpine@sha256:…`, drop Node 20 from the CI matrix (keep 22/24), bump `@types/node` to `^22.x`. Blocking for any release cut after 2026-04-30.
- **Track the FaxDrop API** — if FaxDrop evolves the send / status / numbers endpoints, the MCP is updated to match, without growing its own surface.
- **Track the MCP SDK** — follow the `@modelcontextprotocol/sdk` major-version train; migrate to Zod v4-only idioms once the SDK floor allows.
- **Security hygiene** — Dependabot, Socket, Scorecard, CodeQL, CodeRabbit runs on every PR; every release stays Sigstore-signed with npm provenance.
- **Discoverability** — publish to the public MCP indexes ([official MCP Registry](https://github.com/modelcontextprotocol/registry), [mcp.so](https://mcp.so), [glama.ai](https://glama.ai/mcp), [smithery.ai](https://smithery.ai)) so agent platforms can find it without a manual config line.

## Compliance / governance

- **Second maintainer → OpenSSF Gold** — actively welcome co-maintainership via `.github/CODEOWNERS` once a contributor has several merged PRs. Gold requires ≥2 active maintainers; that's the gating constraint.

