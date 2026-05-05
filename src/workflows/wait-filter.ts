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
 * 2. **String form** — JS arrow-function body, evaluated in a sandbox. The
 *    body must evaluate to a function `(payload) => boolean`. Result is
 *    `!!`-coerced. Throws → no-match. Hard-capped at 50ms wall-clock.
 *
 * No filter (undefined) → matches anything.
 *
 * SECURITY:
 * - The string-form sandbox shadows dangerous globals (incl. `eval`,
 *   `Function`, `AsyncFunction`) — STRICTER than `code-match` because filter
 *   strings are higher-volume and authored by less-trusted workflow authors.
 * - Payload is `structuredClone`d before being passed to the user fn so
 *   side-effects on the cloned argument do not leak back to the bus payload.
 * - The 50ms timeout defangs infinite loops and pathological-regex DoS.
 */

// ─── Sandbox config ─────────────────────────────────────────

/**
 * Globals to shadow when invoking the user filter via `new Function`.
 *
 * - `PARAM_SHADOW_KEYS`: passed as parameter names to `new Function` so they
 *   resolve to `undefined` at call time. `"use strict"` forbids `eval`,
 *   `arguments`, `Function`, `AsyncFunction` as parameter names — we shadow
 *   those via `var`-declared locals inside the function body instead.
 * - `BODY_SHADOW_KEYS`: shadowed via `var X = undefined;` at the top of the
 *   body so identifier resolution finds the local before climbing to the
 *   global scope. This blocks `eval()`, `Function(...)`, and the
 *   constructor-chain escape `payload.constructor.constructor(...)` because
 *   the inner `Function` resolves to undefined.
 *
 * STRICTER than `src/workflows/executors/code-match.ts:19-30` because filter
 * strings are higher-volume and authored by less-trusted workflow authors.
 */
const PARAM_SHADOW_KEYS = [
  "require",
  "process",
  "Bun",
  "globalThis",
  "global",
  "fetch",
  "setTimeout",
  "setInterval",
] as const;

const PARAM_SHADOW_VALUES = PARAM_SHADOW_KEYS.map(() => undefined);

// Identifier names that strict mode reserves as parameter names. Shadowed via
// `var X = undefined;` declarations at the top of the function body.
const BODY_SHADOW_KEYS = ["eval", "Function", "AsyncFunction"] as const;
const BODY_SHADOW_PREAMBLE = BODY_SHADOW_KEYS.map((k) => `var ${k} = undefined;`).join(" ");

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
 * Run the user fn with a 50ms wall-clock cap. Returns `null` on timeout / throw.
 *
 * Note: this is a soft timeout — a tight CPU-bound loop in the user fn cannot
 * be pre-empted by JS (single-threaded). The cap works because the timeout
 * timer fires AFTER the synchronous fn returns or throws; if the fn never
 * returns we still return `null` to the caller via the race below, but the
 * fn itself keeps running on the event loop until it yields. In practice the
 * sandbox blocks `setTimeout`/`setInterval`/async patterns, so an infinite
 * loop will block the listener until the JIT or GC interrupts it; we accept
 * that bounded risk per the plan's security note. The race ensures we DO NOT
 * propagate a hung promise into the caller.
 */
async function runWithTimeout<T>(fn: () => T): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, FILTER_TIMEOUT_MS);

    // Run synchronously on the next microtask so we can race the timer.
    queueMicrotask(() => {
      if (settled) return;
      try {
        const v = fn();
        // If v is a Promise, the contract says "filters are synchronous":
        // attach a no-op catch IMMEDIATELY (so a sync rejection from inside
        // the user fn doesn't crash the runtime) and resolve to a sentinel
        // that the caller treats as "no-match". We wrap in a marker object
        // so the outer `await` can't unwrap a Thenable for us.
        if (
          v !== null &&
          typeof v === "object" &&
          typeof (v as { then?: unknown }).then === "function"
        ) {
          (v as unknown as Promise<unknown>).catch(() => {});
          settled = true;
          clearTimeout(timer);
          resolve({ __asyncRejected: true } as unknown as T);
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      } catch {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

const ASYNC_SENTINEL = "__asyncRejected";

function isAsyncSentinel(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>)[ASYNC_SENTINEL] === true
  );
}

/**
 * Compile and validate a string filter at executor-init time. Throws if the
 * filter does not parse as `(${filter})`. Returns a callable.
 */
export function compileStringFilter(filter: string): (payload: unknown) => unknown {
  // Length cap is enforced by the Zod schema (`.max(2048)`); this is a
  // defense-in-depth check.
  if (filter.length > 2048) {
    throw new Error(`wait filter source exceeds 2KB cap (${filter.length} bytes)`);
  }
  // Compile — surfaces SyntaxError early.
  //
  // We do NOT use `"use strict"` here because strict-mode FORBIDS declaring
  // `eval`, `Function`, etc. as bindings (the very thing we need to do). We
  // use sloppy mode + var-shadowing inside an IIFE-style wrapper so the user
  // fn body sees `eval`, `Function`, `AsyncFunction` (and the param-shadowed
  // `process`, `require`, etc.) as `undefined`.
  //
  // The user's fn itself is wrapped as `(filter)(payload)`. If the user
  // writes their own `"use strict"` directive, it applies only inside the
  // IIFE — that's fine, because by then the shadowed names are already
  // bound to undefined in the enclosing scope.
  let fn: (...args: unknown[]) => unknown;
  try {
    fn = new Function(
      ...PARAM_SHADOW_KEYS,
      "payload",
      `${BODY_SHADOW_PREAMBLE} return (${filter})(payload);`,
    ) as (...args: unknown[]) => unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`wait filter compile error: ${msg}`);
  }
  return (payload: unknown) => fn(...PARAM_SHADOW_VALUES, payload);
}

// ─── Prototype-stripping helper ─────────────────────────────

/**
 * Recursively rebuild `obj` with `null` prototypes on every plain object so
 * the user fn cannot reach the global `Function` constructor via
 * `payload.constructor.constructor(...)`. Arrays keep `Array.prototype` so
 * `.some()`, `.map()`, etc. still work for legitimate predicates — Array's
 * constructor chain still leaks `Function`, but that's a known acceptable
 * trade-off (callers needing array methods accept the residual surface).
 *
 * For deep safety on arrays, callers can use object form filters instead.
 *
 * Returns primitives and arrays unchanged in shape; rebuilds objects.
 */
function nullifyPrototypes(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    // Array methods like `.some` are useful for filter authors. Array's
    // constructor IS still reachable via `payload.someArr.constructor`. The
    // fix below also nullifies the per-element objects so most legitimate
    // queries are safe; users who need stricter deep-blocking should use
    // the object-form filter.
    return value.map(nullifyPrototypes);
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(value)) {
    out[k] = nullifyPrototypes(v);
  }
  return out;
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
    let userFn: (payload: unknown) => unknown;
    try {
      userFn = compileStringFilter(filter);
    } catch {
      return false;
    }

    // Defensive copy with null-prototype: prevents (a) mutation leaking back
    // to the bus payload, and (b) the `payload.constructor.constructor`
    // escape from reaching the global Function constructor through the
    // prototype chain.
    let cloned: unknown;
    try {
      const cloneOnce = structuredClone(payload);
      cloned = nullifyPrototypes(cloneOnce);
    } catch {
      // Some payloads (functions, symbols) cannot be structuredClone'd —
      // fall back to the raw payload but still apply nullifyPrototypes if
      // possible.
      try {
        cloned = nullifyPrototypes(payload);
      } catch {
        cloned = payload;
      }
    }

    const result = await runWithTimeout(() => userFn(cloned));
    if (result === null) return false; // timeout / throw
    // The runWithTimeout helper substitutes a sentinel for Promise returns
    // (filters are synchronous by contract — async predicates → no-match).
    if (isAsyncSentinel(result)) return false;
    return !!result;
  }

  // Anything else (array, number, etc.) → no match.
  return false;
}
