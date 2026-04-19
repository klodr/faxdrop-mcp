# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-19

### BREAKING

- **Drop Node 18.** Minimum runtime is now Node 20 (Node 18 is past EOL).
  `engines.node` is `>=20.11` (we use `import.meta.dirname` in
  `eslint.config.js`, native since 20.11), the CI matrix is `[20, 22, 24]`,
  and tsup target is `node20`. Symmetric to klodr/mercury-invoicing-mcp v0.8.0.

### Changed

- **Major dep bumps**:
  - `zod` 3.25 → **4.3.6** (`z.string().uuid()` is now strict v1-v8;
    no fake UUIDs in fax tests to migrate). MCP SDK 1.29 already supports
    `^3.25 || ^4.0`.
  - `typescript` 5.7 → **6.0.3**.
  - `eslint` 9.39 → **10.2.1** + `@eslint/js` 9.39 → **10.0.1**. The new
    `no-useless-assignment` rule flagged a redundant `let json: unknown =
    undefined` in `src/client.ts:182` (now `let json: unknown;`).
  - `@types/node` 22 → **20.19.0** (matches `engines.node >=20.11`).
- **Minor dep bumps**: `@modelcontextprotocol/sdk` 1.25 → **1.29.0**,
  `tsup` 8.3 → **8.5.1**.
- TypeScript target ES2022 → **ES2023** (Node 20 supports it natively).

## [0.1.9] - 2026-04-19

### Fixed

- `.github/workflows/verify-release.yml` — drop `--signer-workflow` from
  `gh attestation verify` (Path 2). The current `gh` CLI rejects the
  combination with `--cert-identity` (mutually exclusive flag group);
  `--cert-identity` is strictly more specific (encodes both the workflow
  path and the tag ref in the Fulcio SAN), so we keep it and drop
  `--signer-workflow`. Symmetric to klodr/mercury-invoicing-mcp PR #36.

### Changed

- `verify-release.yml` cleanup symmetric to klodr/mercury-invoicing-mcp PR #34:
  - **Drop `npm install` + `npm audit signatures` from Path 1** entirely.
    The 3 manual crypto checks already in Path 1 (SHA-1, SHA-512 SRI, ECDSA
    P-256 registry signature) are strictly stronger than what `npm audit
    signatures` does, and Scorecard's `Pinned-Dependencies` no longer flags
    a non-existent `npm install`.
  - **Wait loop also checks `.dist.signatures` length ≥ 1** before
    proceeding, mirroring the later `SIG_COUNT` guard.
  - **`echo -n` → `printf '%s'`** in the openssl dgst pipe (POSIX
    portability).

## [0.1.8] - 2026-04-18

### Changed

- `verify-release.yml` — `npm audit signatures` no-op pattern now
  also accepts the trailing `" in <duration>"` that npm 10+ emits
  on `audited 0 packages in 200ms`. Without it the anchored full-line
  match would never trigger and any non-zero exit would fail the job.

## [0.1.7] - 2026-04-18

### Changed

- `verify-release.yml` polish post-merge of #18:
  - Pass `KEYID` to `jq` via `--arg` instead of string interpolation
    (avoids breakage on quotes/backslashes in keyids).
  - Tighten the `npm audit signatures` no-op pattern to the exact
    phrases npm emits ("audited 0 packages", "verified registry
    signatures of 0 packages", "no packages with provenance to
    verify"); previously broad fragments (e.g. "no signatures",
    "0 packages") could mask real failures.

## [0.1.6] - 2026-04-18

### Changed

- `.github/workflows/verify-release.yml` — Path 1 `npm install` now downloads
  the tarball explicitly, verifies its SHA-1 against the registry-published
  `dist.shasum`, and installs the local file (instead of `npm install
  <pkg>@<version>`). Fixes Scorecard `Pinned-Dependencies` finding (alert #8).
  Functionally equivalent install (still `--ignore-scripts`), but every byte
  that hits `node_modules` is hash-verified against registry metadata.

## [0.1.5] - 2026-04-18

### Changed

- `.github/workflows/verify-release.yml` — `gh attestation verify` now also
  passes `--cert-identity` (in addition to `--signer-workflow` and
  `--source-ref`) to lock the exact Fulcio SAN encoded in the attestation
  certificate, matching what cosign verifies in Path 3. Symmetric to
  klodr/mercury-invoicing-mcp v0.7.6.

## [0.1.4] - 2026-04-18

### Added

- **Post-release verification workflow** (`.github/workflows/verify-release.yml`):
  re-exercises the three SECURITY.md verification paths (`npm audit signatures`,
  `gh attestation verify`, `cosign verify-blob-attestation`) on every published
  release. Runs on `workflow_run: completed` of `Release & npm publish` and
  fails fast if provenance, the Sigstore bundle, or the attached release assets
  drift. cosign installed via `sigstore/cosign-installer@v4.1.1` (SHA-pinned).

## [0.1.3] - 2026-04-18

### Documentation

- `SECURITY.md`: new entry under "What this MCP does NOT protect against"
  describing prompt injection through fax response data — cover-page fields
  (`coverNote`, `recipientName`, `subject`, `senderCompany`, `senderPhone`)
  can round-trip through `faxdrop_get_fax_status` and re-enter the LLM
  context as "trusted" tool output. Reminder that read-then-write chains
  require explicit user confirmation. No code changes.

## [0.1.2] - 2026-04-18

### Fixed

- `codeql.yml` + `scorecard.yml`: pinned `github/codeql-action` to the **commit SHA** of v4.35.2 (`95e58e9a…`) instead of the SHA of the annotated tag object (`7fc6561…`). OpenSSF Scorecard's "imposter commit" verification rejected the tag-object SHA with HTTP 400. Same fix on `klodr/mercury-invoicing-mcp`.
- `README.md`: CodeQL badge now points at our explicit Advanced workflow (`actions/workflows/codeql.yml/badge.svg`) instead of the unused GitHub Default Setup URL — badge now shows passing/failing instead of just the wordmark.

## [0.1.1] - 2026-04-18

Republish of 0.1.0. The original v0.1.0 release workflow created the
GitHub Release and pushed the npm provenance attestation, but the
`npm publish` step itself failed with HTTP 403 because the
`NPM_TOKEN` lacked the "Create new packages" permission required to
register a new package name. The token has been re-provisioned;
0.1.1 is the same code republished with the corrected token.

## [0.1.0] - 2026-04-18

First release. Two MCP tools wrapping the FaxDrop API
(`faxdrop_send_fax`, `faxdrop_get_fax_status`), with security and
release infrastructure. See [README](./README.md), [SECURITY.md](./SECURITY.md),
[ASSURANCE_CASE.md](./ASSURANCE_CASE.md), and [CONTINUITY.md](./CONTINUITY.md)
for the full story.

### Added

- **Tools**:
  - `faxdrop_send_fax` — upload a local PDF/DOCX/JPEG/PNG (≤10 MB) and send to a fax number in E.164 format. Supports cover-page fields (`coverNote`, `recipientName`, `subject`, `senderCompany`, `senderPhone`, `includeCover`).
  - `faxdrop_get_fax_status` — poll delivery status (`queued | sending | delivered | failed | partial`).
- **Input validation**: auto-detection of FaxDrop API key (`fd_live_…`); E.164 regex on recipient number, extension allow-list (PDF/DOCX/JPEG/PNG), 10 MB ceiling, absolute-path requirement on the upload — all before the file is opened. 60 s `AbortSignal.timeout` on every fetch.
- **TOCTOU-safe upload**: file descriptor pinned with `fs.open()`, chunked read enforces the 10 MB cap continuously (allocates at most cap + one chunk even if the file grows during read).
- **Middleware**:
  - Dry-run mode (`FAXDROP_MCP_DRY_RUN=true`) — write tools return the would-be call payload (sensitive fields redacted) without calling FaxDrop. Reads pass through.
  - Opt-in audit log (`FAXDROP_MCP_AUDIT_LOG=/abs/path/audit.log`, file mode `0o600`, sensitive args redacted).
  - `FaxDropError` mapped to clean `isError:true` responses with `error_type`, `hint`, and `retry_after` surfaced to the caller.
  - Rate limiting deliberately delegated to FaxDrop (10/min, 100/h, 500/day per key server-side, with `retry_after` on 429).
- **Property-based fuzz tests** (`test/fuzz.test.ts`, `fast-check`): `redactSensitive` cannot leak through any sensitive key at any depth (mixed-case variants exercise the case-folding path); `FaxDropError` serialisation never exposes the response body.
- **CI / quality**: matrix on Node 18/20/22; ~96% coverage to Codecov; ESLint v9 flat config with `typescript-eslint` type-aware rules + Prettier (gated by a `Lint & Format` job); TypeScript strict + `noUnusedLocals/noUnusedParameters/noImplicitReturns/noFallthroughCasesInSwitch`.
- **Security tooling**: CodeQL Advanced (security-extended + security-and-quality, both `javascript-typescript` and `actions` languages); OpenSSF Scorecard; Socket Security; Snyk; Dependabot security + version updates; secret scanning + push protection; all GitHub Actions pinned by SHA.
- **Release pipeline**: tag push → extract CHANGELOG section → create (or update) GitHub Release → Sigstore attestation via `actions/attest-build-provenance@v4.1.0` → upload `dist/index.js`, `dist/index.js.sigstore` and the SLSA in-toto attestation `dist/index.js.intoto.jsonl` → `npm publish --access public --provenance`. Sanity check that the pushed tag matches `package.json`'s `version`.
- **Verification paths** documented in [SECURITY.md → Verifying releases](./SECURITY.md#verifying-releases): npm CLI provenance, `gh attestation verify`, `cosign verify-blob-attestation`.
- **Best Practices** [project 12578](https://www.bestpractices.dev/projects/12578) — passing tier; Silver-tier criteria documented in CONTINUITY.md / ASSURANCE_CASE.md / SECURITY.md.
