# Security Policy

## Security model — what you can and cannot expect

This section documents the project's **security requirements**: guarantees
the maintainer commits to, and limits that callers must account for.

### What this MCP provides

- **Authenticated transport**: every FaxDrop API call goes over HTTPS with
  the user-supplied `X-API-Key`. No fallback to HTTP, no key in URL params.
- **Input validation**: all tool inputs are validated by Zod schemas before
  reaching `FaxDropClient`. The fax recipient number must match E.164
  (`/^\+[1-9]\d{6,14}$/`); the `faxId` is URL-encoded; the upload `filePath`
  must be absolute and the file must have an allowed extension (PDF, DOCX,
  JPEG, PNG) and be ≤10 MB — all enforced before any network call.
- **No secret leakage**: `FaxDropError.toString()` and `toJSON()` never
  include the raw API response body. The audit log redacts `apiKey`,
  `authorization`, `password`, `token`, `secret`, `x-api-key` at any depth
  (see `redactSensitive` in `src/middleware.ts`, covered by property-based
  tests in `test/fuzz.test.ts`).
- **Supply-chain integrity**: every release artifact is signed with Sigstore
  (`*.sigstore`) and ships an SLSA in-toto attestation (`*.intoto.jsonl`).
  npm publishes carry [provenance](https://docs.npmjs.com/generating-provenance-statements).
  All GitHub Actions in `.github/workflows/` are pinned by full commit SHA.
- **Least-privilege CI**: the release workflow is split into a read-only
  build job and a publish job (release-only) that holds `NPM_TOKEN`.
- **Defense against runaway agents**: dry-run mode (`FAXDROP_MCP_DRY_RUN=true`)
  exercises a write tool without actually sending a fax. FaxDrop itself
  enforces 10/min, 100/h, 500/day per key and returns 429 with `retry_after`
  which is surfaced to the caller.
- **Optional audit trail**: `FAXDROP_MCP_AUDIT_LOG=/abs/path/audit.log`
  writes an append-only JSON Lines record (file mode `0o600`, sensitive
  fields redacted) of every write call.
- **Fail closed**: 60 s `AbortSignal.timeout` on every fetch; missing
  `FAXDROP_API_KEY` exits at startup.

### What this MCP does NOT protect against

- **Compromise of the host environment**: if your shell, terminal, or MCP
  client is compromised, your `FAXDROP_API_KEY` and the documents you have
  on disk can be stolen by the attacker. This MCP cannot detect or prevent
  that.
- **Malicious LLM prompts (prompt injection)**: an LLM that exposes
  `faxdrop_send_fax` to untrusted content (an email, a fetched web page)
  can be tricked into sending an arbitrary file to an attacker-controlled
  number. The tool description requires user confirmation, but enforcement
  is up to the MCP client. Mitigations: enable `FAXDROP_MCP_DRY_RUN`,
  require human-in-the-loop confirmation, or do not expose this MCP to
  channels carrying untrusted content.
- **Account-level FaxDrop security**: 2FA, billing, fraud detection, key
  rotation are FaxDrop's responsibility, not this MCP's.
- **Network-level attackers** beyond what TLS provides: this MCP relies on
  Node's built-in `fetch` and the system trust store. No certificate pinning.
- **Logging downstream of this MCP**: the audit log redacts sensitive fields,
  but if the MCP client (Claude Desktop, Cursor, etc.) records tool inputs
  to its own log, that is outside this project's control.

## Verifying releases

Every published release of `faxdrop-mcp` is cryptographically signed.
There is **no private signing key** to manage: signing is keyless via
[Sigstore](https://www.sigstore.dev/) using GitHub's OIDC identity
through the [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance)
workflow. The trust chain is: GitHub OIDC → Fulcio (short-lived cert) →
Rekor (transparency log).

Three independent ways to verify:

### 1. npm package — npm CLI

```bash
npm view faxdrop-mcp@<version> --json | jq .dist.attestations
npm install --foreground-scripts --ignore-scripts faxdrop-mcp@<version>
# or, for the strict provenance check across the dependency tree:
npm audit signatures
```

### 2. GitHub Release artifacts — `gh attestation`

```bash
gh release download v<version> --repo klodr/faxdrop-mcp --pattern 'index.js*'
gh attestation verify index.js --repo klodr/faxdrop-mcp
```

### 3. Sigstore bundle (with embedded SLSA in-toto attestation) — `cosign`

The `index.js.sigstore` bundle is what `actions/attest-build-provenance`
emits: a Sigstore-format bundle containing the DSSE-wrapped SLSA in-toto
attestation plus the Fulcio certificate and the Rekor inclusion proof.
That's the file `cosign` wants for keyless verification:

```bash
cosign verify-blob-attestation \
  --bundle index.js.sigstore \
  --certificate-identity-regexp '^https://github\.com/klodr/faxdrop-mcp/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  index.js
```

The companion `index.js.intoto.jsonl` shipped in the same release is the
DSSE envelope on its own, exposed for tools (like OpenSSF Scorecard's
`Signed-Releases` check) that scan release assets by file extension.

Any verification failure means the artifact was not built by the official
release pipeline — do not install it.

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
