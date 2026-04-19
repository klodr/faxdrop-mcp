/**
 * File-path jail for `faxdrop_send_fax`.
 *
 * Constrains every uploaded file to a single working directory ("the
 * outbox"). The LLM agent — even if prompt-injected — cannot fax
 * /Users/<you>/.ssh/id_rsa.pdf, /etc/passwd, or anything outside the
 * outbox. Replaces the would-be dotdir block + Keychains carve-out + ad
 * hoc blocklists with a single positive constraint.
 *
 * Default: `~/FaxOutbox/` (auto-created mode 0o700 on first call).
 * Override: `FAXDROP_MCP_WORK_DIR=/abs/path` (must be absolute, must exist
 * or be creatable).
 *
 * Symlink hardening lives in src/file-io.ts (lstat + realpath +
 * O_NOFOLLOW); this module just enforces the in-jail constraint on the
 * canonical path.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

const DEFAULT_OUTBOX = "FaxOutbox";

let outboxEnsured: { requested: string; canonical: string } | null = null;

/**
 * Resolve the outbox path. Auto-creates `~/FaxOutbox/` (mode 0o700) if
 * the env var is unset and the directory doesn't exist yet. Throws on a
 * non-absolute env override.
 */
export function getOutboxDir(): string {
  const requested = process.env.FAXDROP_MCP_WORK_DIR ?? join(homedir(), DEFAULT_OUTBOX);
  if (process.env.FAXDROP_MCP_WORK_DIR && !isAbsolute(requested)) {
    throw new Error(`FAXDROP_MCP_WORK_DIR must be an absolute path; got: ${requested}`);
  }
  if (outboxEnsured?.requested === requested) return outboxEnsured.canonical;
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  // Canonicalize after the mkdir — on macOS `tmpdir()` and `/tmp` resolve to
  // `/private/...`; the prefix check in assertInsideOutbox compares against
  // the canonical path of the file, so the outbox itself must be canonical
  // too or every accept turns into a reject.
  const canonical = realpathSync(requested);
  outboxEnsured = { requested, canonical };
  return canonical;
}

/**
 * Throws if `canonicalPath` is not inside the outbox. Caller must pass
 * the realpath-resolved canonical path so symlinks-out-of-jail are
 * caught (a symlink target outside the outbox is rejected).
 */
export function assertInsideOutbox(canonicalPath: string): void {
  const outbox = getOutboxDir();
  // Normalize trailing separator for the prefix test: an outbox of
  // `/Users/me/FaxOutbox` must NOT match `/Users/me/FaxOutbox-other/x`.
  const prefix = outbox.endsWith(sep) ? outbox : outbox + sep;
  if (canonicalPath !== outbox && !canonicalPath.startsWith(prefix)) {
    throw new Error(
      `filePath is outside the outbox (${outbox}): ${canonicalPath}. ` +
        `Move the file into the outbox or override FAXDROP_MCP_WORK_DIR.`,
    );
  }
}

/** Test-only: reset the "we already ensured this dir" cache. */
export function _resetOutboxCache(): void {
  outboxEnsured = null;
}
