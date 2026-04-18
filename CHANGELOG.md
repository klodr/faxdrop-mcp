# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-18

First release.

Two MCP tools wrapping the FaxDrop API: `faxdrop_send_fax` and
`faxdrop_get_fax_status`. Sigstore-signed releases with SLSA in-toto
attestation + npm provenance. CI on Node 18/20/22 with ESLint v9 +
Prettier + 96%+ coverage. See [README](./README.md), [SECURITY.md](./SECURITY.md),
[ASSURANCE_CASE.md](./ASSURANCE_CASE.md), and [CONTINUITY.md](./CONTINUITY.md)
for the full feature, security, threat-model, and continuity story.

### Added

- `test/fuzz.test.ts`: property-based tests using `fast-check`. Covers `redactSensitive` (no leak through any sensitive key at any depth, mixed-case variants exercise the case-folding path) and `FaxDropError` (toString / toJSON never expose the response body). Recognised by OpenSSF Scorecard as a fuzz testing tool.
- `release.yml`: now also emits `dist/index.js.intoto.jsonl` (SLSA in-toto attestation extracted from the Sigstore bundle's DSSE envelope, with non-null guard) alongside `dist/index.js.sigstore`. Lifts Scorecard's `Signed-Releases` check from 8/10 to 10/10.
- `CONTINUITY.md`: project continuity plan with a fork-and-continue checklist (Best Practices Silver: `access_continuity`).
- `ASSURANCE_CASE.md`: threat model, trust boundaries, secure-design principles, and CWE/OWASP weakness mapping (Best Practices Silver: `assurance_case`).
- `SECURITY.md`: explicit "Security model" section documenting what the MCP guarantees and what it does NOT protect against; "Verifying releases" section with three independent verification paths (npm CLI, `gh attestation`, `cosign verify-blob-attestation`).

### Changed

- `src/middleware.ts`: `SENSITIVE_KEYS` is now exported and `Object.freeze`d so the fuzz tests can reuse the canonical list and external code cannot mutate it at runtime.

## [0.1.0] - 2026-04-18

### Added

- Initial release. Two MCP tools wrapping the [FaxDrop API](https://www.faxdrop.com/for-developers):
  - `faxdrop_send_fax` — upload a local PDF/DOCX/JPEG/PNG (≤10 MB) and send to a fax number in E.164 format. Supports cover-page fields (`coverNote`, `recipientName`, `subject`, `senderCompany`, `senderPhone`, `includeCover`).
  - `faxdrop_get_fax_status` — poll delivery status (`queued | sending | delivered | failed | partial`).
- Auto-detection of FaxDrop API key (`fd_live_…`) and 60s request timeout.
- File validation upfront: extension allowlist (PDF/DOCX/JPEG/PNG), 10 MB ceiling, absolute-path requirement.
- Recipient number validated as E.164 (`+CC...`) at the Zod layer before any API call.
- Middleware:
  - Dry-run mode (`FAXDROP_MCP_DRY_RUN=true`) — write tools return the would-be call payload (sensitive fields redacted) without calling FaxDrop. Reads pass through.
  - Opt-in audit log (`FAXDROP_MCP_AUDIT_LOG=/abs/path/audit.log`, file mode `0o600`, sensitive args redacted).
  - `FaxDropError` mapped to clean `isError:true` responses with `error_type`, `hint`, and `retry_after` surfaced to the caller.
  - Rate limiting deliberately left to FaxDrop itself (already enforced server-side with 10/min, 100/h, 500/day per key, plus `retry_after` on 429).
- CI matrix on Node 18/20/22, CodeQL Advanced (security-extended + security-and-quality), OpenSSF Scorecard, Socket Security, Dependabot, secret scanning, SHA-pinned actions.
- Release pipeline: tag push → auto-extract CHANGELOG section → create GitHub Release → Sigstore attestation (`actions/attest-build-provenance`) → npm publish with provenance.
