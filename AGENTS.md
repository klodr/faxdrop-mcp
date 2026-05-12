# AGENTS.md

This repository is **faxdrop-mcp** — a Model Context Protocol server that
wraps the [FaxDrop](https://faxdrop.com) HTTP API so AI assistants can
send real faxes (single tool: `fax_send`; one prompt template).

This file is the **canonical source of truth** for any AI agent that
edits the code in this repository. Read it before making changes. It
encodes the conventions the maintainers actually enforce — not
aspirations.

> If you are an installation agent (i.e. helping a user **install** the
> MCP server in their client config rather than **edit** the server
> code), stop reading this file and read `llms-install.md` instead. That
> file is for the install audience; this one is for code-editing
> agents.

## Audience boundary

| Audience                                           | Source of truth                                |
| -------------------------------------------------- | ---------------------------------------------- |
| Edits this repo's code                             | **`AGENTS.md`** (you are here)                 |
| Installs this MCP into a client config             | `llms-install.md`                              |
| Threat model / security argument                   | `docs/ASSURANCE_CASE.md`                       |
| Disaster recovery / continuity                     | `docs/CONTINUITY.md`                           |
| Forward-looking work                               | `docs/ROADMAP.md`                              |
| End-user features and install commands             | `README.md`                                    |
| Vulnerability reporting                            | `.github/SECURITY.md`                          |

Do not duplicate what those documents say. Reference them.

## Setup

Node `>=22.22.2` is **enforced** via `engines` + `engine-strict=true` in
`.npmrc`. CI runs the matrix on Node 22 and 24. `npm install` on Node
21 fails immediately — that is intentional.

```bash
npm install
```

This repo uses **npm**, not pnpm. Lockfile is `package-lock.json`.

Husky hooks install via the `prepare` script.

## Build, test, lint, typecheck

The exact npm scripts (see `package.json`):

| Command                     | What it does                              |
| --------------------------- | ----------------------------------------- |
| `npm run build`             | `tsup` bundle to `dist/`                  |
| `npm run dev`               | `tsup --watch`                            |
| `npm run start`             | `node dist/index.js` (stdio MCP server)   |
| `npm run lint`              | ESLint on `src/`                          |
| `npm run format`            | Prettier write on `src` + `test`          |
| `npm run format:check`      | Prettier check (CI gate)                  |
| `npm run test`              | `vitest run` (also emits JUnit XML)       |
| `npm run test:watch`        | `vitest`                                  |
| `npm run test:coverage`     | `vitest run --coverage`                   |
| `npm run typecheck`         | `tsc --noEmit`                            |

Run `npm run lint && npm run typecheck && npm test` before every push.
Husky's `pre-push` will do it for you, but failing locally before push
is faster than failing in CI.

## Code style

- TypeScript strict (`strictTypeChecked` preset of `typescript-eslint`).
- ESM (`"type": "module"`); use `.js` import specifiers in `src/`.
- ESLint flat config in `eslint.config.js`. Type-aware rules — must
  resolve via `parserOptions.projectService: true`.
- Prettier (no override file → defaults).
- `eqeqeq: error` (always strict equality).
- `no-console: warn` — only `console.error` / `console.warn` allowed.
- `import-x/no-unresolved: off` — TS / vitest already validate imports;
  the rule cannot follow `./*` exports maps from the MCP SDK.

If you add a new file, the strict-type-checked preset will require type
annotations on exported functions. Inferred returns are allowed for
internal helpers.

## Tests

- Framework: **vitest** with `globals: true`.
- Lives in `test/`, name pattern `*.test.ts`.
- Coverage provider: `v8`. Reporters: `text`, `lcov`, `json`. The JSON
  report carries per-branch hit counts so Codecov can compute accurate
  indirect-changes — do not remove it.
- `src/index.ts` is excluded from coverage (stdio entry point;
  testing it requires process/stdio mocking that adds complexity
  disproportionate to its coverage value). The actual logic lives in
  `src/server.ts` and is covered there.
- Use `InMemoryTransport` from `@modelcontextprotocol/sdk` for
  end-to-end handler tests. Existing tests in `test/` are the
  reference pattern.
- Property-based testing via `fast-check` — used for the audit-log
  redactor and other invariants. Prefer over hand-rolled fixtures
  when the surface is enumerable.

## Commits

- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`, `test:`, `ci:`, `build:`).
- **Signed commits required.** Pre-push hook verifies via `%G?` and
  rejects anything other than `G`/`U`/`X`/`Y`. Configure SSH commit
  signing or set `commit.gpgsign=true`.
- **Subject ≤72 characters.** Pre-push counts unicode code points
  (not bytes) so emoji and accented characters count correctly.
- **No `Co-Authored-By:` trailers.** This repo's maintainers do not
  use co-authorship attribution on AI-assisted commits.

## Pre-push gate (`.husky/pre-push`)

For every new commit being pushed:

1. Signature is `G`/`U`/`X`/`Y` (good / unknown-trust / expired-signature
   / expired-key — `B`/`R`/`E`/`N` are rejected).
2. Subject ≤72 chars (unicode-aware).

Then once per push:

1. `npm run format:check`
2. `npm run lint`
3. `npm run typecheck`
4. `npm run test`

`npm audit` runs server-side via the Dependabot / OSV-Scanner workflows
where intermittent advisory-state failures retry naturally — it is
intentionally not run locally on push.

Bypass with `git push --no-verify` only when the hook itself is wrong
(rare). The bypass is recorded in the local reflog.

## PR workflow

- Open the PR against `main`.
- Wait for CodeRabbit review (assertive profile). Drain every
  comment thread before re-pinging — never spam `@coderabbitai
  review` while threads are unresolved.
- CodeRabbit commands are posted **bare**, no surrounding prose
  (e.g. a comment whose entire body is `@coderabbitai review`).
- Do not let CodeRabbit push commits — this repo is solo-maintained
  and a bot commit would block merge under branch protection.
- Auto-merge: `gh pr merge --squash --auto`. Branch protection waits
  on CI + CodeRabbit + Scorecard.
- Maintainers do not self-approve their own PRs. Approvals only
  from external bots (release-please-app, dependabot).

## Source layout

```text
src/
  index.ts          stdio entry point (excluded from coverage)
  server.ts         MCP server wiring (registerTool / registerPrompt)
  client.ts         FaxDrop HTTP client (fetch + retry policy)
  tools/
    fax.ts          single fax_send tool
    _shared.ts      shared helpers
    index.ts        re-export
  prompts/
    fax.ts          prompt templates (declared via registerPrompt)
    index.ts        re-export
  schemas.ts        zod schemas for tool inputs
  middleware.ts     audit log + dry-run + redaction
  file-io.ts        TOCTOU-safe read with size enforcement
  file-jail.ts      absolute-path + extension allowlist
  phone-gate.ts     E.164 validation
  safe-url.ts       SSRF guard
  sanitize.ts       audit-log redaction (allowlist + length marker)
  status-cache.ts   poll cache for fax status
test/
  *.test.ts         vitest specs
docs/
  ASSURANCE_CASE.md security argument (threat model + mitigations)
  CONTINUITY.md     disaster recovery / continuity plan
  ROADMAP.md        forward-looking work
```

## Security guards encoded in the code

The security posture is described in full in `docs/ASSURANCE_CASE.md`.
What follows is the minimum an editor must know to avoid regressing it:

- File jail: `file-jail.ts` rejects relative paths, paths outside the
  configured outbox, and disallowed extensions. **Validate before
  opening the file**, not after.
- TOCTOU read: `file-io.ts` pins the file descriptor with `fs.open()`,
  enforces the 10 MB cap continuously while reading. Do not read into
  a buffer first and check size after.
- E.164 gate: `phone-gate.ts` is the only place the recipient number
  is validated. Tools must call it.
- Audit-log redaction: `sanitize.ts` keeps an explicit allowlist
  (`recipientNumber`, `faxId`, `id`) in clear, blocks credential
  fields, elides everything else with `[ELIDED:NNN]`. Property-tested.
  Adding a new tool that takes free-form input → extend the test, not
  the allowlist.
- Dry-run: `FAXDROP_MCP_DRY_RUN=true` short-circuits before the
  network call. Used for prompt smoke tests in CI.

## Before opening a PR — checklist

1. `npm run format && npm run lint && npm run typecheck && npm test`
2. New behaviour has a test. New error path has a test.
3. Commit subject ≤72 chars, signed, conventional, no Co-Authored-By.
4. If you touched a security guard listed above: also re-read the
   matching section in `docs/ASSURANCE_CASE.md` and update it if the
   threat model shifted.
5. If you changed user-facing behaviour: update `README.md` and the
   relevant section of `llms-install.md`.
