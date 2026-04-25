# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-04-26 — Layered SSRF defense + LOW/INFO security findings

A minor release closing the LOW/INFO findings raised by the
`docker/mcp-registry` security-reviewer audit on `0.5.0` and adding a
runtime SSRF defense layer (`assertSafeUrl`, `src/safe-url.ts`) that
re-classifies every outbound URL's resolved IPs before each `fetch`.

The `validateBaseUrl` startup gate is rebuilt on top of `ipaddr.js`
(RFC-based range classification: loopback / RFC 1918 / RFC 3927
link-local / RFC 6598 carrier-grade NAT / RFC 2544 benchmarking /
RFC 5737 documentation / multicast / IPv6 ULA / IPv6 link-local) and a
new exact-match FaxDrop hostname allowlist (`FAXDROP_HOSTS =
["www.faxdrop.com"]`) with an opt-out
(`FAXDROP_MCP_ALLOW_NON_FAXDROP_HOST=true`) for advanced operators
running a forward proxy or a self-hosted FaxDrop endpoint.

The audit-log path denylist, the `O_NOFOLLOW` mandatory load, the
`Atomics.wait`-backed `acquireLock` retry loop, and the outbox
file-content magic-byte verification ride along.

No breaking change for legacy users (the FaxDrop hostname allowlist is
opt-in via env var; the runtime SSRF gate is transparent for clients
already pointing at `www.faxdrop.com`). New runtime dependency:
`ipaddr.js` (BSD-3-Clause, ~10 KB minified, used by every major
SSRF-defense library in the Node ecosystem).

### Security

- **`FaxDropClient.request` passes `redirect: "manual"` to native `fetch`** (`src/client.ts`). The default `redirect: "follow"` would let undici chase a `Location` header transparently, bouncing the `X-API-Key` + every fax payload to whatever host the redirect points at — which `assertSafeUrl()` never re-classifies because the redirect is handled below the public fetch surface. The handler now throws an `unexpected_redirect` `FaxDropError` on any 30x, failing closed instead of leaking the API key. Mirrors the same gate landed on `klodr/mercury-invoicing-mcp` `src/client.ts`.
- **`FAXDROP_API_BASE_URL` is now strictly validated at server startup** (`src/server.ts:validateBaseUrl`). The bearer API key + every fax payload + every recipient number is sent to this URL, so a misconfigured (or env-tampered) override pointing at `http://attacker.example` would have exfiltrated the full trust radius in cleartext. The validator mirrors the strict outbound webhook URL gate in `klodr/mercury-invoicing-mcp` (`src/tools/webhooks.ts:HttpsWebhookUrl`): HTTPS-only, with loopback / RFC 1918 / link-local / cloud-metadata / IPv6 ULA / `*.localhost` rejected. Asymmetric posture vs the outbound-webhook check is now closed.
- **`O_NOFOLLOW` is now mandatory at module load** (`src/file-io.ts`). Previously `(fsConstants.O_NOFOLLOW || 0)` silently degraded to flag `0` on platforms that did not expose the constant (Windows), reducing the symlink TOCTOU guard to lstat+realpath alone. The server now refuses to start on Windows with a clear error pointing at WSL — no more silent platform-degradation of the TOCTOU barrier.
- **`acquireLock` retry loop no longer pins a CPU core** (`src/phone-gate.ts:acquireLock`). The previous busy-wait pinned 100% of one core for each ~25 ms quantum (≈120 retries over the 3 s timeout), which under multi-process contention on a shared `FAXDROP_MCP_STATE_DIR` blocked the Node event loop and any concurrent stdio JSON-RPC frames. Replaced with `Atomics.wait`-backed sleep (5–15 ms jittered), which parks the thread cheaply at the kernel level. Regression-guarded by a CPU-time-vs-wall-time ratio test (`test/phone-gate.test.ts`).
- **Audit-log path now rejects POSIX system-root prefixes** (`src/middleware.ts:logAudit`). `FAXDROP_MCP_AUDIT_LOG=/etc/foo.log` was accepted by `appendFileSync` if the process happened to have write permission, which would let a confused-deputy write poison `/etc/cron.daily/audit.log` or similar with attacker-influenced cover-page args. The denylist now rejects `/etc`, `/usr`, `/bin`, `/sbin`, `/sys`, `/proc`, `/boot`, `/dev` with a clear remediation hint pointing operators at `$HOME` or another user-owned writable directory.
- **Outbox file-content magic-byte verification** (`src/file-io.ts`). The extension allowlist (`.pdf`/`.docx`/`.jpeg`/`.jpg`/`.png`) was previously matched on filename suffix only, so an attacker (or a confused agent) with write access to the outbox could rename `id_rsa` to `id_rsa.pdf` and have it forwarded to FaxDrop. The bytes are already in memory after the chunked read, so the magic-byte check (`%PDF-`, `PK\x03\x04`/`PK\x05\x06`, `FFD8FF`, `89PNG`) is essentially free. Catches both attacker-placed misnamings AND operator typos (`.docx` that's actually a legacy `.doc`).

### Documentation

- **`src/middleware.ts`**: the `redactSensitive` deprecated alias gains a proper `@deprecated` JSDoc tag with explicit drift-risk notes, so TypeScript / VS Code / ESLint `no-deprecated` consumers flag any new production import. The alias remains exported for `test/fuzz.test.ts`; removal tracked for the next minor.
- **`src/phone-gate.ts:validateTypeAndCountry`**: catch block on `parsePhoneNumber` gains an inline comment documenting why the defensive paranoia is kept (libphonenumber-js's exact throw shape varies across 1.10.x → 1.12.x minor versions; collapsing to a single `layer: "parse"` GateFail keeps the gate contract stable across upgrades).
- **`.github/SECURITY.md`**: new "Transitive HTTP/OAuth dependencies — installed but not bundled" section explains why express/hono/jose/ajv/cors/etc. land in `node_modules/` despite the stdio-only transport (MCP SDK's other transports), pointing at tsup tree-shaking + Socket.dev rules + Dependabot + upstream `modelcontextprotocol/typescript-sdk#1924` as the install-time risk mitigations. New audit-log path / HTTPS-only base URL / POSIX-only platform notes added to the "What this MCP provides" section. Symlink hardening note expanded to include the new file-content magic-byte verification.

## [0.5.0] - 2026-04-25 — Tool descriptions polish

A documentation-quality release. The 3 tool definitions in `src/tools/fax.ts` are rewritten in a structured TDQS form (USE WHEN / DO NOT USE / SIDE EFFECTS / RETURNS), driven by an LLM-agent-orientation review and cross-validated against [Anthropic — Writing Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents), the [MCP Tools Specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), and [SEP-1382](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1382). Two small dependency-hygiene fixes ride along (`packageManager` and `pnpm.onlyBuiltDependencies` pinned for reproducibility on pnpm-based registries). No runtime change. No schema change.

### Changed

- **Tool descriptions adopt the TDQS pattern** — the 3 tool definitions (`faxdrop_send_fax`, `faxdrop_pair_number`, `faxdrop_get_fax_status`) are restructured into explicit USE WHEN / DO NOT USE / SIDE EFFECTS / RETURNS sections. `faxdrop_send_fax` keeps a strong `SIDE EFFECTS` block (charges FaxDrop balance, audit log entry, ALWAYS confirm with user). `faxdrop_pair_number` documents the persistence to `paired.json` and the gate-mode prerequisite. `faxdrop_get_fax_status` drops the trivial rate-limit-only `SIDE EFFECTS` line and folds the `_cached: true` cache nuance into `DO NOT USE` and `RETURNS` where it is actionable.
- **`packageManager` field pinned to `npm@10.9.7`** — matches the npm version bundled with Node 22.22.2 (our `engines.node` floor), so Corepack stays a no-op for default Node 22 installs and a no-cost pin elsewhere. Stops a contributor or CI runner with an older npm from regenerating a lockfileVersion 2 lockfile.
- **`pnpm.onlyBuiltDependencies: ["esbuild"]`** — pnpm-based registries (Glama, Smithery, etc.) can now build cleanly without operator-prompt for esbuild's post-install hook. Other transitive post-install scripts stay blocked.
- **README MIT badge dropped** — license is already surfaced by GitHub (sidebar, auto-detected from `LICENSE`) and npm (right rail, parsed from `package.json` `license`). The third copy in the README was noise without information.

### Added

- **`docs/ROADMAP.md` — MCP `outputSchema` per tool item** — extend `defineTool()` with an optional `outputSchema?: ZodRawShape` for the 3 tools so clients can validate `structuredContent` per MCP spec 2025-06-18+. Lets us drop the textual `RETURNS:` block from tool descriptions and rely on a machine-readable contract instead.

## [0.4.0] - 2026-04-25

### Added

- **Community-health files** — `.github/SUPPORT.md` (issue-redirection page surfaced by GitHub on issue creation, with best-effort response SLOs) and `CITATION.cff` (Citation File Format metadata enabling the GitHub "Cite this repository" button on the repo page).
- **`package.json` discoverability** — `funding` field now points at `https://github.com/sponsors/klodr` (renders as the ❤️ Sponsor button on `npmjs.com`). `CHANGELOG.md` added to the `files` allowlist so it stays in the published tarball — npm v11 dropped `CHANGELOG.md` from the always-included list, so consumers who read changelog from `node_modules/` would otherwise see it disappear silently.

### Changed

- **Dotfile alignment with sibling klodr/* repos** — adds `.npmrc` (`engine-strict=true`, with the same comment block as mercury explaining the rationale) and `.nvmrc` (`22`). The `.npmrc` flip makes `npm install` on Node < 22.22.2 a hard error instead of a warning, matching the engines field in `package.json`. The `.nvmrc` lets contributors `nvm use` to the right Node major.
- **Socket Security stricter posture (aligned with `klodr/gmail-mcp`)** — `socket.yml` no longer silences the three high-value supply-chain alerts `unstableOwnership`, `unmaintained`, and `manifestConfusion`. The original blanket-suppression (PR #28, 2026-04-19) was preventive against the `@modelcontextprotocol/sdk → express` transitive surface tracked in [modelcontextprotocol/typescript-sdk#1924](https://github.com/modelcontextprotocol/typescript-sdk/issues/1924), but in practice `express` is actively maintained with stable ownership, so the rules generate near-zero noise. They will now fire on transitive owner changes / abandonware / manifest mismatch — exactly the supply-chain attack surface that hit `event-stream`, `ua-parser-js`, `nx`. Per-package `@SocketSecurity ignore <pkg>@<version>` comments on the relevant PR remain available if a transitive dep generates a real false positive.
- **Repository structure cleanup** — community-health files (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`) moved to `.github/`, and general documentation (`ROADMAP.md`, `ASSURANCE_CASE.md`, `CONTINUITY.md`) moved to `docs/`. Internal links updated across `README.md`, `CHANGELOG.md`, `llms-install.md`, `docs/ASSURANCE_CASE.md`, `docs/CONTINUITY.md`, `src/sanitize.ts`, and `.github/workflows/verify-release.yml`. The repository root now keeps only `README.md`, `LICENSE`, `CHANGELOG.md`, `llms-install.md`, and project-config files. No behaviour change; GitHub still resolves the community files at their new canonical locations.

## [0.3.9] - 2026-04-23

### Changed

- **Node.js floor bumped to `>=22.22.2`** (was `>=22.11`). Pinned to the exact patch — not just `22.22.x` — because the seven CVEs landed in `22.22.2` specifically; `22.22.0` and `22.22.1` predate those fixes. The CVEs addressed: [CVE-2026-21637](https://nvd.nist.gov/vuln/detail/CVE-2026-21637) (High — SNICallback invocation error handling in TLS), [CVE-2026-21710](https://nvd.nist.gov/vuln/detail/CVE-2026-21710) (High — prototype pollution in HTTP header processing), [CVE-2026-21713](https://nvd.nist.gov/vuln/detail/CVE-2026-21713) (Medium — non-timing-safe comparison in WebCrypto HMAC), [CVE-2026-21714](https://nvd.nist.gov/vuln/detail/CVE-2026-21714) (Medium — NGHTTP2 flow-control error handling), [CVE-2026-21717](https://nvd.nist.gov/vuln/detail/CVE-2026-21717) (Medium — V8 array index hash collision), [CVE-2026-21715](https://nvd.nist.gov/vuln/detail/CVE-2026-21715) (Low — missing permission check in `realpath.native`), [CVE-2026-21716](https://nvd.nist.gov/vuln/detail/CVE-2026-21716) (Low — missing permission check in `fs/promises`). Aligned with the sibling repos `klodr/gmail-mcp`, `klodr/mercury-invoicing-mcp`, and the private `klodr/relayfi-mcp`. `.github/dependabot.yml` `@types/node` major-clamp comment updated to reflect the new floor.

### Fixed

- **Audit throws no longer mask handler errors** (Qodo finding backported from `klodr/gmail-mcp#48`). A `logAudit(...)` call in the `finally` or `catch` would override the handler's own exception per JS/TS semantics — `appendFileSync` failures (full disk / EACCES) are already swallowed inside `logAudit`, but the pre-write paths are not: `redactForAudit` walking an unexpected shape, `JSON.stringify` on a circular `args`/`response`, or a `new Date().toISOString()` throw can all bubble up and erase the handler's root cause from the caller. Introduces a local `safeLogAudit` wrapper that swallows any audit-side exception to stderr and applies it to all three terminal audit paths (`dry-run` early-return, `ok` success path, `error` in catch before the `FaxDropError` mapping).
- **Business errors returned via `isError: true` are now audited as "error"** (Qodo finding backported from `klodr/gmail-mcp#48`). Previously, handlers that surfaced a failure through the MCP `isError` channel (vs a thrown exception) were audited as `"ok"`, conflating successful calls with handler-side failures in the audit log. `wrapToolHandler` now inspects `result.isError` on the success path and picks the audit state accordingly.

## [0.3.8] - 2026-04-23

### Fixed

- **CI `Upload test results to Codecov` guard** — the step now reads `if: ${{ always() && matrix.node == '22' && !cancelled() }}`. The prior `if: matrix.node == '22' && !cancelled()` was ambiguous: `!cancelled()` alone does replace the implicit `success()` check in GitHub Actions expression semantics, but the ambiguity is enough that failed test runs were at risk of being filtered out of Test Analytics — defeating the entire point of the upload (seeing flaky-test patterns on red builds). Explicit `always()` makes the "upload on failure" behaviour load-bearing in the YAML itself. Mirrors the sibling-repo fix landing on `klodr/mercury-invoicing-mcp#78`.
- **README CodeRabbit badge URL** — dropped the `utm_source=oss&utm_medium=github&utm_campaign=klodr%2Ffaxdrop-mcp&` prefix from the `img.shields.io/coderabbit/prs/...` badge URL. Those params are what CodeRabbit's "embed this badge" snippet proposes by default, but shields.io doesn't interpret them — they only serve to give the URL a unique signature from the other sibling-repo badges, which means GitHub's camo image proxy caches each variant independently. When the upstream CodeRabbit endpoint returned a transient `provider or repo not found` at camo's initial fetch, that error SVG got cached and kept rendering while the sibling-repo badge (with a different URL) rendered fine. Dropping the utm params aligns the badge URL with the form used on `klodr/gmail-mcp` and invalidates the stale camo cache on the next README render.

## [0.3.7] - 2026-04-23

### Added

- **Codecov Test Analytics wiring** — vitest emits a `test-results.junit.xml` alongside its default human reporter, and CI uploads it via `codecov/codecov-action@v6.0.0` (pinned by full SHA) invoked with `report_type: test_results` — the standalone `codecov/test-results-action@v1.2.1` is deprecated in favour of the unified action. Gives us the "Tests" dashboard on codecov.io: per-suite flaky-test detection, slowest tests, per-test failure history. Upload runs only on the Node 22 matrix leg with `!cancelled()` so a test failure still surfaces the report. XML file is gitignored and absent from `package.json#files` — it never ships to npm.

### Changed (BREAKING)

- **Node.js floor: `>=22.11`** (was `>=20.11`). Node 20 reaches end of Active LTS on 2026-04-30; keeping the floor there would ship the package on an unmaintained runtime the day after. `22.11.0` is the LTS-tagged entry point for the Node 22 "Jod" line (released October 2024), which runs maintenance until 2027-04-30 — one year of headroom. Pinning to the LTS-tag floor rather than `>=22.0.0` skips the pre-LTS v22.0–v22.10 releases. Aligned with the sibling repos `klodr/gmail-mcp` and `klodr/mercury-invoicing-mcp`, all moving to the same floor.
- **Compile target: `ES2024`** (was `ES2023`). Node 22 implements the full ES2024 surface — `target` and `lib` now match.
- **Bundle target: `tsup target: node22`** (was `node20`) so the shipped `dist/index.js` actually takes advantage of the higher floor.

### Changed

- `@types/node` bumped from `^20.19.39` to `^22.19.17`.
- CI matrix dropped Node 20 — builds now run on Node 22 + 24. The coverage upload step (Codecov) moved from Node 20 to Node 22.
- Release and verify-release workflows set up Node 22. All CI/release workflow step names updated from "Setup Node 20" to "Setup Node 22".
- Dockerfile base image pinned to `node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f`.
- `llms-install.md` prerequisite updated to **Node.js ≥ 22**.
- `.github/dependabot.yml` `@types/node` major-version-clamp comment aligned to the new `>=22.11` floor.
- `.github/ISSUE_TEMPLATE/bug_report.yml` Node version placeholder updated from `20.10.0` to `22.12.0`.
- `ROADMAP.md` — the completed "Node.js 22 migration — deadline 2026-04-30" roadmap item is removed now that the migration has landed.

## [0.3.6] - 2026-04-22

### Fixed (supply-chain)

- **Signed SBOM bundles are now actually uploaded to each Release.** The two `actions/attest` steps that sign the SPDX and CycloneDX SBOMs lacked `id:` fields in 0.3.5, so their `bundle-path` outputs could not be referenced — only the unsigned `sbom.*.json` files ended up on the 0.3.5 Release. With 0.3.6: `id: attest_spdx` + `id: attest_cdx` are declared, their bundles are copied to `dist/sbom.spdx.sigstore` + `dist/sbom.cdx.sigstore`, and both are uploaded alongside the JSON SBOMs. The verification path documented in `SECURITY.md` (`gh attestation verify index.js --predicate-type https://spdx.dev/Document/v2.3 --repo klodr/faxdrop-mcp`) now works. **`dist/index.js` is byte-identical to 0.3.5**; this release exists only to correct the Release assets.

## [0.3.5] - 2026-04-22

### Added

- **Dockerfile + `.github/icon.png`** — container distribution path for the Docker MCP Registry submission. Multi-stage, `node:20-alpine` pinned by digest, non-root `mcp` user, OCI labels (`version` from build-arg), no EXPOSE, explicit `HEALTHCHECK NONE` to silence Checkov `CKV_DOCKER_2` on stdio images. Pre-creates `/app/outbox` (mode `0o700`) so the runtime jail policy is satisfied before the first fax is written.
- **`.github/workflows/docker.yml`** — buildx + GHA cache, asserts required OCI labels + non-root `USER=mcp`, strict smoke-test that accepts `exit 1` (fail-fast with explicit "required" marker in stderr) or `exit 124` (stdin wait).
- **Release workflow now ships SPDX 2.3 + CycloneDX 1.6 SBOMs** (`anchore/sbom-action`) alongside `dist/index.js`, each signed via `actions/attest@v4` (not the deprecated `actions/attest-sbom`). SBOM subject is `dist/index.js`; verification via `gh attestation verify index.js --predicate-type https://spdx.dev/Document/v2.3` (or `https://cyclonedx.org/bom`).
- **`npm prune --omit=dev`** before SBOM generation so SBOMs reflect the runtime dependency tree, not the build toolchain (`tsup`, `typescript`, `vitest`). `npm publish` runs with `--ignore-scripts` since the build is already done earlier in the job.
- **`CONTRIBUTING.md`** — one-line Developer Certificate of Origin reference (`Signed-off-by:` auto-added via global `prepare-commit-msg` hook certifies DCO 1.1).

### Changed

- **Roadmap extracted to `ROADMAP.md`** (no longer inlined in the README) and Silver-tier wording consolidated. Purely a docs reshuffle; the repo content covered by OpenSSF Best Practices is unchanged.
- **Dockerfile smoke-test `exit=1` branch** tightened — the grep now requires both `FAXDROP_API_KEY` and the word `required` on the same line, so a crash that incidentally mentions the env-var name doesn't pass as a healthy startup.
- `.github/dependabot.yml` — `@types/node` major-version-clamp comment aligned with `engines.node` floor.
- **`ROADMAP.md`** — Node.js 22 migration tracked with a hard deadline of 2026-04-30 (Node 20 security-support EOL).

### Security (author hygiene)

- **Full history rewrite on `main`** — every commit authored by the maintainer now carries `klodr@users.noreply.github.com` both as `Author` and in its `Signed-off-by:` trailer. Earlier commits (and `Co-authored-by:` lines inherited from merged dependabot PRs) had exposed the maintainer's primary and secondary personal emails. No functional change; purely a metadata privacy pass triggered by GitHub's "Keep my email addresses private" setting. SHAs on `main` have changed; the previously-tagged `v0.3.4` (never shipped under its own number after this cleanup) has been retired in favour of `v0.3.5` to keep the tag/npm histories coherent.

### Not released

- `v0.3.4` was cut, tagged, and published to npm earlier today. It is now **unpublished** from npm (within the 72h window) and its tag has been removed. Its content is superseded by this release.

## [0.3.3] - 2026-04-21

### Added

- Funding links in `.github/FUNDING.yml` (GitHub Sponsors, Patreon,
  Ko-fi) and matching badges at the top of the README. Monthly
  recurring funding helps cover the tooling (Claude Code, Socket
  Security, CI) behind steady security patches and issue triage.

### Changed

- `.coderabbit.yaml` now carries an explicit policy NOTE forbidding
  CodeRabbit-authored commits: on a solo-maintainer repo the branch
  protection rule "approval from someone other than the last pusher"
  deadlocks if the bot is both the last pusher and the approver. No
  functional change — `pre_merge_checks.override_requested_reviewers_only`
  already kept bot approval from substituting an explicitly-requested
  human reviewer; this commit documents the complementary human
  discipline (never click GitHub's "Commit suggestion" on a CodeRabbit
  inline suggestion, never run `@coderabbitai apply suggestions`).
- `dependabot.yml`: drop `include: "scope"` (was producing duplicated
  titles like `deps(deps): bump X` / `deps-dev(deps-dev): bump X`
  because the prefix already encodes prod vs dev). Reduce
  `open-pull-requests-limit` from 10 to 5 to keep the review queue
  manageable.

## [0.3.2] - 2026-04-19

### Security

- **Phone-gate hints no longer leak the policy** to the LLM-facing
  `content[0].text`. Previously a rejected number returned a `hint`
  like `"Allowed countries: US. Override via FAXDROP_MCP_ALLOWED_COUNTRIES."`,
  which exposed both the whitelist contents and the env-var name —
  useful for an operator debugging interactively, but a usable
  reconnaissance signal under prompt injection (an attacker LLM
  learns the gate shape and the exact knob to ask the user to
  loosen). The `reason` is now generic — `"Country not allowed"`,
  `"Phone number type not allowed"` — and the `hint` field is
  dropped entirely for layers TYPE and COUNTRY. Operators still see
  the policy via env vars; callers see only the gate decision.

## [0.3.1] - 2026-04-19

### Tests

- 5 new tests close coverage gaps left by the v0.3.0 hardening surface
  (PR #30, merged into main):
  - `isValidE164` — direct coverage of the public helper used by the
    `senderPhone` Zod refine.
  - `validateTypeAndCountry` parse paths — the `catch` branch (empty
    input throws inside libphonenumber) and the `!phone.isValid()`
    branch (`+10000000000` parses but `isValid()` returns false).
  - `acquireLock` stale recovery — manually plant a lock file with
    `mtime > 30s` and assert `pairNumber` reclaims it on the first
    retry, finishing well under the 3s timeout.
  - `acquireLock` timeout — hold a fresh lock from another fd;
    `pairNumber` must throw `pair-number lock timeout` after the
    full ~3s wait.
- Coverage delta:
  - statements 95.44 → **98.57**
  - branches 91.87 → **94.92**
  - functions 98.24 → **100**
  - lines 95.61 → **99.05**

## [0.3.0] - 2026-04-19

### Added

- **File-path jail (`FAXDROP_MCP_WORK_DIR`)**: every uploaded document
  must live inside an outbox directory (default `~/FaxOutbox/`,
  auto-created mode `0o700`). After realpath canonicalization, paths
  outside the outbox are rejected with `error_type: "bad_request"`.
  Replaces the would-be dotdir block + Keychains carve-out + ad-hoc
  blocklists with a single positive constraint. Override with an
  absolute path via `FAXDROP_MCP_WORK_DIR=/abs/path`.
- **Symlink hardening on `filePath`**: leaf symlinks are rejected at
  `lstat` (the actual attack vector — `safe.pdf → /etc/passwd`), the
  canonical path is resolved via `realpath` (parent-component symlinks
  tolerated for setups like macOS `/var → /private/var` or
  `~/work → /Volumes/External`), and the open passes `O_NOFOLLOW` as a
  TOCTOU barrier in case a leaf symlink sneaks in between the lstat
  and the open.
- **Output sanitization** (`src/sanitize.ts`): every tool response
  text is stripped of ASCII/Unicode control characters and zero-width
  formatters (BiDi overrides, ZWSP, ZWJ, BOM, …) and wrapped in
  `<untrusted-tool-output>…</untrusted-tool-output>` fences before
  reaching the LLM. Defense in depth against prompt injection through
  FaxDrop response fields the caller (or upstream) may have crafted.
- **`structuredContent` on every response** (per MCP spec 2025-06-18+):
  alongside the fenced text in `content[0].text`, tool results now
  carry the raw JSON payload as `structuredContent`. Programmatic
  consumers parse the structured field; the fenced text is for safe
  LLM display only.
- **Discard non-JSON responses from FaxDrop** (`src/client.ts`):
  FaxDrop's API always returns JSON; a non-JSON body (HTML 5xx page,
  proxy interception, incident page) is now thrown as
  `error_type: "invalid_response"` with the body discarded — never
  forwarded to the LLM. Closes a prompt-injection vector where an
  upstream HTML payload could re-enter the agent context.
- **Anti-poll-storm cache** (`src/status-cache.ts`): terminal statuses
  (`delivered`, `failed`, `partial`) are cached process-wide (LRU,
  100 entries max). Subsequent `faxdrop_get_fax_status` calls for the
  same `faxId` short-circuit and return the cached payload with a
  `_cached: true` marker, sparing FaxDrop quota when LLMs re-poll a
  finished fax. Tool description updated with the recommended polling
  cadence (every 5s for the first 2 min, then every 30s for up to
  10 min, stop on terminal status).
- **3-layer phone-number gate on `recipientNumber`** (new module
  `src/phone-gate.ts`). Every call to `faxdrop_send_fax` now passes
  three successive blocking layers before the fax is dispatched:
  1. **TYPE** — number must be one of `FIXED_LINE`,
     `FIXED_LINE_OR_MOBILE`, `VOIP`, `TOLL_FREE` (env override
     `FAXDROP_MCP_ALLOWED_TYPES`).
  2. **COUNTRY** — number's country must be in `US`, `CA`, `PR`, `GU`,
     `VI`, `AS`, `MP` (env override `FAXDROP_MCP_ALLOWED_COUNTRIES`).
  3. **GATE** — per-number policy via `FAXDROP_MCP_NUMBER_GATE`
     (default **`pairing`** — secure-with-HITL by default):
       - `open` — any number that passed 1+2 is allowed.
       - `pairing` — only numbers in `~/.faxdrop-mcp/paired.json` are
         allowed; new numbers can be added via the new
         `faxdrop_pair_number` tool (still subject to layers 1+2).
       - `closed` — only numbers in `paired.json`; runtime pairing is
         disabled (file edited out-of-band only).
  Layers 1 and 2 are immutable at runtime — no per-call approval can
  bypass them. Powered by `libphonenumber-js/max` for accurate type
  detection. State file: `~/.faxdrop-mcp/paired.json` (mode `0o600`,
  atomic write via rename), overridable via `FAXDROP_MCP_STATE_DIR`.
- **New tool** `faxdrop_pair_number` — adds a number to the paired
  whitelist when `FAXDROP_MCP_NUMBER_GATE=pairing`. Errors out with
  `pair_disabled` in `closed` and `open` modes.

### Changed

- `package.json`: add `libphonenumber-js@^1.12.41` as a runtime
  dependency.
- `codecov.yml`: revert `project.threshold` from `1.5%` to `0.5%` now that
  v0.2.0 has shipped and codecov has a clean v8-instrumented baseline.
  The 1.5% was a one-shot accommodation for the istanbul → v8
  instrumentation switch; PRs from here on compare like-for-like.
  Patch threshold (`95%` / `1.5%`) is unchanged.

## [0.2.0] - 2026-04-19

### BREAKING

- **Drop Node 18.** Minimum runtime is now **Node 20.11+** (Node 18 is past
  EOL; the 20.11 floor is required by `import.meta.dirname` in
  `eslint.config.js`). `engines.node` is `>=20.11`, the CI matrix is
  `[20, 22, 24]`, and tsup target is `node20`. Symmetric to
  klodr/mercury-invoicing-mcp v0.8.0.

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
- **Test runner: jest → vitest** (`vitest@4.1.4` + `@vitest/coverage-v8`).
  Drops `jest`, `@types/jest`, `ts-jest` and their deprecated `glob@10`
  / `inflight` / `babel-plugin-istanbul` transitives
  ([jestjs/jest#15173](https://github.com/jestjs/jest/issues/15173)).
  Native ESM/TS, no preset. v8 coverage instead of istanbul. API is
  drop-in: `jest.fn`/`jest.spyOn` → `vi.fn`/`vi.spyOn`.

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
release infrastructure. See [README](./README.md), [SECURITY.md](.github/SECURITY.md),
[ASSURANCE_CASE.md](docs/ASSURANCE_CASE.md), and [CONTINUITY.md](docs/CONTINUITY.md)
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
- **Verification paths** documented in [SECURITY.md → Verifying releases](.github/SECURITY.md#verifying-releases): npm CLI provenance, `gh attestation verify`, `cosign verify-blob-attestation`.
- **Best Practices** [project 12578](https://www.bestpractices.dev/projects/12578) — passing tier; Silver-tier criteria documented in CONTINUITY.md / ASSURANCE_CASE.md / SECURITY.md.

[Unreleased]: https://github.com/klodr/faxdrop-mcp/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/klodr/faxdrop-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/klodr/faxdrop-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/klodr/faxdrop-mcp/compare/v0.3.9...v0.4.0
[0.3.9]: https://github.com/klodr/faxdrop-mcp/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/klodr/faxdrop-mcp/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/klodr/faxdrop-mcp/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/klodr/faxdrop-mcp/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/klodr/faxdrop-mcp/compare/v0.3.3...v0.3.5
[0.3.3]: https://github.com/klodr/faxdrop-mcp/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/klodr/faxdrop-mcp/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/klodr/faxdrop-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/klodr/faxdrop-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/klodr/faxdrop-mcp/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/klodr/faxdrop-mcp/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/klodr/faxdrop-mcp/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/klodr/faxdrop-mcp/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/klodr/faxdrop-mcp/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/klodr/faxdrop-mcp/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/klodr/faxdrop-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/klodr/faxdrop-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/klodr/faxdrop-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/klodr/faxdrop-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/klodr/faxdrop-mcp/releases/tag/v0.1.0
