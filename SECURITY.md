# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `faxdrop-mcp`, please report it **privately** so we can address it before any disclosure.

### Preferred channel: Private vulnerability reporting

Use GitHub's [Private vulnerability reporting](https://github.com/klodr/faxdrop-mcp/security/advisories/new) feature. Maintainers will receive your report directly.

### Alternative

If for any reason you cannot use GitHub's private reporting, open an issue with **only** the message "private security report — please contact me" and a maintainer will reach out.

**Do not** open a public issue with vulnerability details before a fix is released.

## What to include

- A clear description of the issue
- Steps to reproduce (proof of concept if possible)
- Affected versions
- Suggested mitigation if you have one

## Response targets

- **Acknowledgement**: within 72 hours
- **Initial assessment**: within 7 days
- **Fix or mitigation**: depends on severity, typically within 30 days for high/critical issues

## Scope

This policy covers vulnerabilities in this repository's code (the MCP server itself). Issues in upstream dependencies should be reported to those projects directly; we will track the CVE and update our pinned versions.

## Security best practices when using this MCP

- **Never** commit your `FAXDROP_API_KEY` to version control. Use environment variables or your MCP client's secret management.
- The `faxdrop_send_fax` tool reads files from the user's local filesystem — only expose this MCP to agents you trust to act on your behalf, or run with `FAXDROP_MCP_DRY_RUN=true` to test prompts safely.
- Be aware that exposing `faxdrop_send_fax` to an LLM that processes untrusted content opens a prompt injection vector (e.g. an email asking the agent to fax it elsewhere). Use human-in-the-loop confirmation in your client.
- Keep this package updated; vulnerable versions will trigger Dependabot alerts on your projects.

Thanks for helping keep `faxdrop-mcp` and its users safe.
