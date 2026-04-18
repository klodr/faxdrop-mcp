# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
