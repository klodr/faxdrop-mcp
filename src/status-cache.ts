/**
 * Anti-poll-storm cache for `faxdrop_get_fax_status`.
 *
 * FaxDrop's status response moves through `queued → sending → delivered |
 * failed | partial`. The first three are intermediate (subject to change);
 * the last three are TERMINAL — FaxDrop will never change them. Yet LLMs
 * sometimes re-poll a delivered fax because the previous response has fallen
 * out of their context.
 *
 * This module caches terminal statuses in-memory and short-circuits
 * subsequent get_fax_status calls for the same faxId, returning the cached
 * payload + a `_cached: true` marker so the LLM knows further polling is
 * pointless. Quota saved on FaxDrop's side.
 *
 * Bounded LRU at 100 entries (~50 KB worst case). Process-lifetime: terminal
 * statuses are immutable on FaxDrop's side, no TTL needed. Eviction by Map
 * insertion order (Map preserves order; we delete + set on hit to bump).
 */

const MAX_ENTRIES = 100;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["delivered", "failed", "partial"]);

// Only these fields from a FaxDrop status response are kept in the cache and
// re-served on a hit. Anything else (extra fields invented by a malicious
// upstream, prompt-injection payloads in unexpected keys) is dropped. Keeps
// the cached payload shape stable and bounded.
const CACHED_FIELDS = ["id", "status", "pages", "completedAt", "recipientNumber"] as const;

interface CachedStatus {
  id?: unknown;
  status?: unknown;
  pages?: unknown;
  completedAt?: unknown;
  recipientNumber?: unknown;
}

const cache = new Map<string, CachedStatus>();

export function isTerminalStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

export function getCachedStatus(faxId: string): CachedStatus | undefined {
  const value = cache.get(faxId);
  if (value === undefined) return undefined;
  // Bump to most-recent in the insertion order (LRU touch).
  cache.delete(faxId);
  cache.set(faxId, value);
  // Return a shallow clone so the caller can't mutate the cached entry.
  return { ...value };
}

/**
 * Cache the payload only if the status is terminal. No-op for intermediate
 * statuses so subsequent calls re-fetch and observe progress. Only the
 * whitelisted CACHED_FIELDS are stored — extra keys (potential injection
 * vectors) are dropped before persistence.
 */
export function maybeCacheStatus(faxId: string, payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const obj = payload as Record<string, unknown>;
  if (!isTerminalStatus(obj.status)) return;
  const sliced: CachedStatus = {};
  for (const k of CACHED_FIELDS) {
    if (k in obj) sliced[k] = obj[k];
  }
  if (cache.has(faxId)) cache.delete(faxId);
  cache.set(faxId, sliced);
  // LRU evict the oldest if we're over capacity.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test-only: empty the cache. */
export function _resetStatusCache(): void {
  cache.clear();
}

/** Test-only: introspect the cache. */
export function _statusCacheSize(): number {
  return cache.size;
}
