# Roadmap

**Maintenance mode.** Fax is a one-way business (outbound send + status polling) and this MCP already covers that surface end-to-end. There is no plan to add inbound-fax receive, complex workflow layers, or feature bloat. The long-term intent is **keep it stable, keep it secure, keep it small**.

## What that means in practice

- **Track the FaxDrop API** — if FaxDrop evolves the send / status / numbers endpoints, the MCP is updated to match, without growing its own surface.
- **Track the MCP SDK** — follow the `@modelcontextprotocol/sdk` major-version train; migrate to Zod v4-only idioms once the SDK floor allows.
- **Security hygiene** — Dependabot, Socket, Scorecard, CodeQL, CodeRabbit runs on every PR; every release stays Sigstore-signed with npm provenance.
- **Discoverability** — publish to the public MCP indexes ([official MCP Registry](https://github.com/modelcontextprotocol/registry), [Docker MCP Registry](https://github.com/docker/mcp-registry), [mcp.so](https://mcp.so), [glama.ai](https://glama.ai/mcp), [smithery.ai](https://smithery.ai)) so agent platforms can find it without a manual config line. The Docker MCP Registry submission `server.yaml` is drafted (validates against the registry's `task validate`); the open dependency is a sandbox API key to share with the registry maintainer via the secure submission form.

## Safety guards

- **Duplicate-send confirmation** — guard against re-sending the *same* document to the *same* recipient number within a short time window. When a `send_fax` matches a recent send — same `recipientNumber` + same document content (hash of the source file), **regardless of whether a cover page is included or not** — within a few seconds, the tool should refuse to dispatch silently and instead require an explicit second confirmation. Rationale: real incidents where a quick re-send to add or remove the cover page produced a duplicate fax at the recipient. Each send has a monetary cost, and recipients such as the IRS disfavour duplicate submissions (duplicate authorizations / conflicting filings). Cover-on vs cover-off is **not** a meaningful document change for this check.

## Compliance / governance

- **Second maintainer → OpenSSF Gold** — actively welcome co-maintainership via `.github/CODEOWNERS` once a contributor has several merged PRs. Gold requires ≥2 active maintainers; that's the gating constraint.
