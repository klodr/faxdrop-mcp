/**
 * Phone-number gate: 3 successive blocking layers
 *
 *   1. TYPE     — number must be one of ALLOWED_TYPES (env override).
 *   2. COUNTRY  — number's country must be in ALLOWED_COUNTRIES (env override).
 *   3. GATE     — per-number policy:
 *        open    — every number that passed 1+2 is allowed.
 *        pairing — only numbers in paired.json are allowed; new numbers can
 *                  be added at runtime via faxdrop_pair_number (still
 *                  subject to layers 1+2 — no bypass).
 *        closed  — only numbers in paired.json are allowed; runtime pairing
 *                  is disabled (paired.json is edited out-of-band only).
 *
 * Layers 1 and 2 are immutable at runtime — no approval mechanism, no
 * environment override per call. The set of acceptable types/countries
 * is fixed at process start by env vars.
 *
 * Default values match the typical US/CA fax use case (the only Mercury
 * customers FaxDrop currently serves) plus US territories.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isValidPhoneNumber, parsePhoneNumber } from "libphonenumber-js/max";
import type { CountryCode, NumberType } from "libphonenumber-js/max";

/**
 * Cheap format-only check (no type/country/gate). Useful for fields like
 * senderPhone that are printed on the cover page but not subject to the
 * 3-layer recipient gate. libphonenumber's per-country plan tables make
 * this stricter than a generic E.164 regex (which would accept e.g.
 * +12000000000, structurally valid but not a real number).
 */
export function isValidE164(input: string): boolean {
  return isValidPhoneNumber(input);
}

// --- defaults (overridable by env) ---

const DEFAULT_ALLOWED_TYPES: readonly NumberType[] = Object.freeze([
  "FIXED_LINE",
  "FIXED_LINE_OR_MOBILE",
  "VOIP",
  "TOLL_FREE",
] as const);

const DEFAULT_ALLOWED_COUNTRIES: readonly CountryCode[] = Object.freeze([
  "US",
  "CA",
  "PR", // Puerto Rico
  "GU", // Guam
  "VI", // U.S. Virgin Islands
  "AS", // American Samoa
  "MP", // Northern Mariana Islands
] as const);

const GATE_MODES = ["open", "pairing", "closed"] as const;
export type GateMode = (typeof GATE_MODES)[number];

export function getMode(): GateMode {
  // Default 'pairing': any new recipient triggers an explicit user-approval
  // step (via faxdrop_pair_number) before the first fax. Once paired, the
  // number is allowed without further per-call approval. 'closed' is
  // strictly stricter (no runtime pairing) and 'open' is permissive — both
  // are opt-in via the env var.
  const raw = (process.env.FAXDROP_MCP_NUMBER_GATE ?? "pairing").toLowerCase();
  if ((GATE_MODES as readonly string[]).includes(raw)) return raw as GateMode;
  // Unknown value → fail-safe to closed (the strictest) and warn — don't
  // silently fall back to the permissive 'open'.
  console.error(`[phone-gate] Unknown FAXDROP_MCP_NUMBER_GATE='${raw}'; falling back to 'closed'.`);
  return "closed";
}

function parseList<T extends string>(
  env: string | undefined,
  fallback: readonly T[],
): readonly T[] {
  if (!env) return fallback;
  const items = env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? (items as T[]) : fallback;
}

export function getAllowedTypes(): readonly NumberType[] {
  return parseList<NumberType>(process.env.FAXDROP_MCP_ALLOWED_TYPES, DEFAULT_ALLOWED_TYPES);
}

export function getAllowedCountries(): readonly CountryCode[] {
  const raw = process.env.FAXDROP_MCP_ALLOWED_COUNTRIES;
  if (!raw) return DEFAULT_ALLOWED_COUNTRIES;
  const upper = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  return upper.length > 0 ? (upper as CountryCode[]) : DEFAULT_ALLOWED_COUNTRIES;
}

// --- validation result ---

export interface GateOk {
  ok: true;
  e164: string;
  country: CountryCode;
  type: NumberType;
}

export type GateLayer = "parse" | "type" | "country" | "gate";

export interface GateFail {
  ok: false;
  layer: GateLayer;
  reason: string;
  hint?: string;
}

export type GateResult = GateOk | GateFail;

/**
 * Run layers 1 (TYPE) and 2 (COUNTRY) on the input number. Does NOT consult
 * paired.json — caller must call checkGate() separately for layer 3.
 */
export function validateTypeAndCountry(input: string): GateResult {
  let phone;
  try {
    phone = parsePhoneNumber(input);
  } catch {
    return { ok: false, layer: "parse", reason: "Cannot parse phone number" };
  }
  if (!phone.isValid()) {
    return { ok: false, layer: "parse", reason: `Invalid phone number: ${input}` };
  }
  if (!phone.country) {
    return {
      ok: false,
      layer: "country",
      reason: "Cannot determine country from number",
    };
  }
  const type = phone.getType();
  const allowedTypes = getAllowedTypes();
  if (!type || !allowedTypes.includes(type)) {
    return {
      ok: false,
      layer: "type",
      reason: `Phone type '${type ?? "unknown"}' is not allowed`,
      hint: `Allowed types: ${allowedTypes.join(", ")}. Override via FAXDROP_MCP_ALLOWED_TYPES.`,
    };
  }
  const allowedCountries = getAllowedCountries();
  if (!allowedCountries.includes(phone.country)) {
    return {
      ok: false,
      layer: "country",
      reason: `Country '${phone.country}' is not allowed`,
      hint: `Allowed countries: ${allowedCountries.join(", ")}. Override via FAXDROP_MCP_ALLOWED_COUNTRIES.`,
    };
  }
  return {
    ok: true,
    e164: phone.number,
    country: phone.country,
    type,
  };
}

// --- paired.json storage (mode 0o600) ---

function getStateDir(): string {
  const dir = process.env.FAXDROP_MCP_STATE_DIR || join(homedir(), ".faxdrop-mcp");
  if (!isAbsolute(dir)) {
    throw new Error(`FAXDROP_MCP_STATE_DIR must be an absolute path; got: ${dir}`);
  }
  return dir;
}

function getPairedFile(): string {
  return join(getStateDir(), "paired.json");
}

let pairedCache: Set<string> | null = null;
// Distinguishes "loaded as empty" from "load failed" (EACCES/EIO). When the
// load failed we MUST refuse to write — otherwise pairNumber would persist
// just the in-process additions and silently wipe any prior content on disk.
let pairedLoaded = false;

function loadPaired(): Set<string> {
  if (pairedCache) return pairedCache;
  const file = getPairedFile();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      pairedCache = new Set(parsed);
      pairedLoaded = true;
      return pairedCache;
    }
    console.error(`[phone-gate] paired.json has unexpected shape; ignoring.`);
    // Treat malformed-but-readable file as empty + loaded — re-writing it is
    // the recovery path (the user can inspect the prior file via .tmp/backup
    // if they care).
    pairedLoaded = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No file yet — empty, loaded, safe to write.
      pairedLoaded = true;
    } else {
      console.error(`[phone-gate] failed to read ${file}: ${(err as Error).message}`);
      pairedLoaded = false;
    }
  }
  pairedCache = new Set<string>();
  return pairedCache;
}

export function isPaired(e164: string): boolean {
  return loadPaired().has(e164);
}

/**
 * Add a number to paired.json (mode 0o600, atomic via rename).
 * Caller must have already passed validateTypeAndCountry — this function
 * does NOT re-validate (no bypass-by-pair).
 */
export function pairNumber(e164: string): void {
  const set = loadPaired();
  if (!pairedLoaded) {
    // Load failed (e.g. EACCES) — refuse to write, otherwise we'd clobber
    // prior content with just `[e164]`. Surface the failure to the caller.
    throw new Error(
      `Cannot pair ${e164}: paired.json could not be read (see earlier error). Refusing to overwrite.`,
    );
  }
  if (set.has(e164)) return;
  set.add(e164);
  const file = getPairedFile();
  // mkdir mode 0o700 so the dir itself is owner-only. Concurrent writers get
  // unique tmp names (pid + uuid) — fixed `${file}.tmp` would let two
  // pairNumber calls clobber each other's tmp before the rename.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify([...set].sort()), { mode: 0o600 });
  renameSync(tmp, file);
}

export interface GatePass {
  ok: true;
}
export type GateCheck = GatePass | GateFail;

/**
 * Layer 3: per-number gate. Caller must have already passed
 * validateTypeAndCountry(); this only checks the per-number policy.
 */
export function checkGate(e164: string): GateCheck {
  const mode = getMode();
  if (mode === "open") return { ok: true };
  if (isPaired(e164)) return { ok: true };
  if (mode === "pairing") {
    return {
      ok: false,
      layer: "gate",
      reason: `Number ${e164} is not paired`,
      hint:
        `Pairing required (FAXDROP_MCP_NUMBER_GATE=pairing). ` +
        `Call faxdrop_pair_number with this recipientNumber to add it, then retry.`,
    };
  }
  // closed
  return {
    ok: false,
    layer: "gate",
    reason: `Number ${e164} is not paired`,
    hint:
      `Runtime pairing is disabled (FAXDROP_MCP_NUMBER_GATE=closed). ` +
      `Add the number manually to ${getPairedFile()} (or set FAXDROP_MCP_NUMBER_GATE=pairing) and retry.`,
  };
}

/**
 * Run all 3 layers (TYPE, COUNTRY, GATE) in order. Returns the first
 * failure or, on full pass, the parsed metadata. Convenience wrapper
 * around validateTypeAndCountry + checkGate.
 */
export function validateAll(input: string): GateResult {
  const tac = validateTypeAndCountry(input);
  if (!tac.ok) return tac;
  const gate = checkGate(tac.e164);
  if (!gate.ok) return gate;
  return tac;
}

/** Test-only: reset the in-memory cache. */
export function _resetPairedCache(): void {
  pairedCache = null;
  pairedLoaded = false;
}
