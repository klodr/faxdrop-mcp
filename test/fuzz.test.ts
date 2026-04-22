/**
 * Property-based (fuzz) tests for security-sensitive helpers.
 * Uses fast-check, recognised by OpenSSF Scorecard's Fuzzing check
 * for the JS/TS ecosystem.
 */

import * as fc from "fast-check";
import { AUDIT_SAFE_KEYS, redactSensitive, SENSITIVE_KEYS } from "../src/middleware.js";
import { FaxDropError } from "../src/client.js";

// SENSITIVE_KEYS / AUDIT_SAFE_KEYS are imported from src/middleware.ts so
// the property tests stay in sync with the canonical lists — no drift.

// Mixed-case variants exercise the `.toLowerCase()` path inside
// redactSensitive. If a future refactor drops case-folding, the property
// will fail on any of the variants below.
const mixedCaseKeys = SENSITIVE_KEYS.flatMap((k) => [
  k.toUpperCase(),
  k.charAt(0).toUpperCase() + k.slice(1), // PascalCase
  [...k].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join(""), // alternating
]);

// Key pool for the fuzz: sensitive, audit-safe, and random unknown keys.
// We filter random keys so they never collide with a sensitive or safe
// key by accident (which would invalidate the property's expectation).
const randomNeutralKey = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter(
    (k) =>
      !(SENSITIVE_KEYS as readonly string[]).includes(k.toLowerCase()) &&
      !(AUDIT_SAFE_KEYS as readonly string[]).includes(k),
  );

describe("Fuzz: redactSensitive (allowlist: FaxDrop response fields only)", () => {
  it("never leaks any value stored under a sensitive key, at any depth", () => {
    fc.assert(
      fc.property(
        fc.letrec((tie) => ({
          value: fc.oneof(
            { maxDepth: 4 },
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.dictionary(
              fc.oneof(fc.constantFrom(...SENSITIVE_KEYS, ...mixedCaseKeys), randomNeutralKey),
              tie("value"),
              { maxKeys: 5 },
            ),
          ),
        })).value,
        (input) => {
          const out = redactSensitive(input);
          // Property: for any object reached BEFORE the redactor switches to
          // an elided string (via an array or a non-safe nested container),
          // every sensitive key maps to "[REDACTED]". We only walk matching
          // object/object pairs — elided strings end the descent.
          const stack: Array<{ a: unknown; b: unknown }> = [{ a: input, b: out }];
          while (stack.length > 0) {
            const { a, b } = stack.pop()!;
            if (a === null || typeof a !== "object") continue;
            if (Array.isArray(a)) continue; // elided → no descent
            // After the first level, non-safe keys turn into strings; their
            // sub-tree is not walked anyway. Only recurse when both sides
            // are plain objects.
            if (b === null || typeof b !== "object" || Array.isArray(b)) continue;
            const ao = a as Record<string, unknown>;
            const bo = b as Record<string, unknown>;
            for (const k of Object.keys(ao)) {
              if ((SENSITIVE_KEYS as readonly string[]).includes(k.toLowerCase())) {
                if (bo[k] !== "[REDACTED]") return false;
              } else if ((AUDIT_SAFE_KEYS as readonly string[]).includes(k)) {
                // Safe key: same-type descend when both are objects
                stack.push({ a: ao[k], b: bo[k] });
              }
            }
          }
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("preserves the FaxDrop response (AUDIT_SAFE) keys verbatim at the top level", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(...AUDIT_SAFE_KEYS),
          fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
          { maxKeys: AUDIT_SAFE_KEYS.length },
        ),
        (input) => {
          const out = redactSensitive(input) as Record<string, unknown>;
          for (const k of Object.keys(input)) {
            if (out[k] !== input[k]) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("elides any non-sensitive, non-safe string with an [ELIDED:N chars] marker", () => {
    fc.assert(
      fc.property(randomNeutralKey, fc.string({ minLength: 0, maxLength: 100 }), (key, val) => {
        const out = redactSensitive({ [key]: val }) as Record<string, unknown>;
        return out[key] === `[ELIDED:${val.length} chars]`;
      }),
      { numRuns: 200 },
    );
  });

  it("leaves primitives and null unchanged", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.float(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
        ),
        (v) => Object.is(redactSensitive(v), v),
      ),
    );
  });
});

describe("Fuzz: FaxDropError serialisation", () => {
  // Sentinel that fast-check's string arbitraries cannot reasonably produce,
  // AND filter `message` so it can never collide.
  const SENTINEL = "__LEAK_SENTINEL_4f9c2b__";
  const safeMessage = fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((m) => !m.includes(SENTINEL));

  it("toString never leaks the response body", () => {
    fc.assert(
      fc.property(
        safeMessage,
        fc.integer({ min: 100, max: 599 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string()),
        (message, status, body) => {
          const tagged: Record<string, string> = {};
          for (const [k, v] of Object.entries(body)) tagged[k] = `${SENTINEL}${v}`;
          const err = new FaxDropError(message, status, undefined, undefined, undefined, tagged);
          return !err.toString().includes(SENTINEL);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("toJSON never leaks the response body", () => {
    fc.assert(
      fc.property(
        safeMessage,
        fc.integer({ min: 100, max: 599 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string()),
        (message, status, body) => {
          const tagged: Record<string, string> = {};
          for (const [k, v] of Object.entries(body)) tagged[k] = `${SENTINEL}${v}`;
          const err = new FaxDropError(message, status, undefined, undefined, undefined, tagged);
          return !JSON.stringify(err.toJSON()).includes(SENTINEL);
        },
      ),
      { numRuns: 200 },
    );
  });
});
