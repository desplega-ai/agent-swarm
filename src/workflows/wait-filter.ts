/**
 * Wait-node event filter matcher.
 *
 * Filter shapes (discriminated by `typeof`):
 *
 * 1. **Object form** — flat key/dot-path equality. Each filter key may use
 *    dot-path segments (e.g. `"pr.number"`) and each value is compared by
 *    deep-equal (numbers/strings/booleans/arrays/objects). Missing keys or
 *    type mismatches → no-match. ALL keys must match.
 *
 * 2. **String form** — JS arrow-function source `(payload) => boolean`,
 *    evaluated in a QuickJS sandbox (`./predicate-sandbox`). The payload
 *    crosses as a JSON copy. Result is `!!`-coerced. Throws, Promise
 *    returns, and runs past 50ms → no-match.
 *
 * No filter (undefined) → matches anything.
 */

import { checkPredicateSyntax, evaluatePredicate } from "./predicate-sandbox";

const FILTER_TIMEOUT_MS = 50;

// ─── Object-form helpers ────────────────────────────────────

function getByDotPath(obj: unknown, path: string): { found: boolean; value: unknown } {
  if (obj === null || typeof obj !== "object") {
    return { found: false, value: undefined };
  }
  const segments = path.split(".");
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object") {
      return { found: false, value: undefined };
    }
    const rec = cursor as Record<string, unknown>;
    if (!(seg in rec)) {
      return { found: false, value: undefined };
    }
    cursor = rec[seg];
  }
  return { found: true, value: cursor };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function matchObjectFilter(payload: unknown, filter: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    const { found, value } = getByDotPath(payload, key);
    if (!found) return false;
    if (!deepEqual(value, expected)) return false;
  }
  return true;
}

// ─── String-form helpers ────────────────────────────────────

/**
 * Validate a string filter at executor-init time. Throws if the filter source
 * is too long or does not parse.
 */
export async function compileStringFilter(filter: string): Promise<void> {
  // Length cap is enforced by the Zod schema (`.max(2048)`); this is a
  // defense-in-depth check.
  if (filter.length > 2048) {
    throw new Error(`wait filter source exceeds 2KB cap (${filter.length} bytes)`);
  }
  try {
    await checkPredicateSyntax(filter);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`wait filter compile error: ${msg}`);
  }
}

// ─── Public matcher ─────────────────────────────────────────

/**
 * Returns true iff `payload` satisfies `filter`. See module-level docstring
 * for filter shape semantics.
 *
 * NEVER throws — sandbox errors / timeouts are coerced to false.
 */
export async function matchesFilter(payload: unknown, filter: unknown): Promise<boolean> {
  // No filter → match everything.
  if (filter === undefined || filter === null) return true;

  // Object form.
  if (typeof filter === "object" && !Array.isArray(filter)) {
    return matchObjectFilter(payload, filter as Record<string, unknown>);
  }

  // String form.
  if (typeof filter === "string") {
    if (filter.length > 2048) return false;
    try {
      const result = await evaluatePredicate(filter, payload, "filter", {
        timeoutMs: FILTER_TIMEOUT_MS,
      });
      return result.ok && result.value;
    } catch {
      return false;
    }
  }

  // Anything else (array, number, etc.) → no match.
  return false;
}
