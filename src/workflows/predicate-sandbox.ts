/**
 * Evaluates workflow-author JavaScript predicates (code-match nodes, string
 * wait filters) in a fresh QuickJS runtime. The guest realm has no host
 * globals, so a predicate sees only JSON-copied input. The interrupt handler
 * stops CPU-bound code at the deadline, and the runtime has memory and stack
 * limits.
 */
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core";

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_STACK_BYTES = 1024 * 1024;

let modulePromise: Promise<QuickJSWASMModule> | undefined;

function loadQuickJS(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
}

export type PredicateResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * How the guest turns the predicate's return value into a host result. Both
 * reproduce the pre-QuickJS host evaluator:
 * - `filter`: `!!value`; a thenable return is an error (filters are sync).
 * - `port`: code-match's mapping. Booleans become "true"/"false", strings pass
 *   through, anything else goes through `String()` (custom `toString`, and
 *   "[object Promise]" for an async predicate). `raw` is the value after a JSON
 *   round trip, which is what the step output used to persist.
 */
export type PredicateMode = "filter" | "port";

export type PortValue = { port: string; raw?: unknown };

type EvalOptions = { timeoutMs: number; strict?: boolean };

async function withContext<T>(timeoutMs: number, fn: (ctx: QuickJSContext) => T): Promise<T> {
  const QuickJS = await loadQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
  const ctx = runtime.newContext();
  try {
    return fn(ctx);
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}

// Bun gave predicates a `console`; keep calls working as no-ops.
const PRELUDE = `globalThis.console = Object.freeze({ log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} });`;

const MAP_RESULT: Record<PredicateMode, string> = {
  filter: `if (__r !== null && typeof __r === "object" && typeof __r.then === "function") {
  return JSON.stringify({ ok: false, error: "predicate must be synchronous" });
}
return JSON.stringify({ ok: true, value: !!__r });`,
  port: `const __port = typeof __r === "boolean" ? (__r ? "true" : "false") : typeof __r === "string" ? __r : String(__r);
return JSON.stringify({ ok: true, value: { port: __port, raw: __r } });`,
};

/**
 * The guest returns one JSON string, so the host never dumps a guest object.
 * Dumping a Promise leaks a handle and aborts the WASM runtime on dispose.
 * Throws are caught in the guest and reported as the old host did:
 * `err instanceof Error ? err.message : String(err)`.
 */
function wrap(source: string, strict: boolean, mode: PredicateMode): string {
  // A plain function call, not an arrow, so a strict predicate sees
  // `this === undefined`, as it did under `new Function`.
  return `${strict ? '"use strict";' : ""}(function () {
try {
const __r = (${source})(__input === undefined ? undefined : JSON.parse(__input));
${MAP_RESULT[mode]}
} catch (__e) {
  let __m;
  try { __m = __e instanceof Error ? __e.message : String(__e); } catch (_) { __m = "unprintable error"; }
  return JSON.stringify({ ok: false, error: String(__m) });
}
})()`;
}

/** Throws with the guest's SyntaxError message when `source` does not parse. */
export async function checkPredicateSyntax(source: string): Promise<void> {
  await withContext(1_000, (ctx) => {
    const result = ctx.evalCode(wrap(source, false, "filter"), "predicate.js", {
      compileOnly: true,
    });
    if (result.error) {
      const err = ctx.dump(result.error);
      result.error.dispose();
      throw new Error(errorText(err));
    }
    result.value.dispose();
  });
}

/**
 * Calls `(source)(input)` in the sandbox. `input` crosses as JSON, so the
 * caller's objects are never shared with the predicate. Returns the mapped
 * result (see `PredicateMode`), or the guest error (throw, syntax error,
 * timeout, memory limit).
 */
export async function evaluatePredicate(
  source: string,
  input: unknown,
  mode: "filter",
  options: EvalOptions,
): Promise<PredicateResult<boolean>>;
export async function evaluatePredicate(
  source: string,
  input: unknown,
  mode: "port",
  options: EvalOptions,
): Promise<PredicateResult<PortValue>>;
export async function evaluatePredicate(
  source: string,
  input: unknown,
  mode: PredicateMode,
  { timeoutMs, strict = false }: EvalOptions,
): Promise<PredicateResult<unknown>> {
  let inputJson: string | undefined;
  try {
    inputJson = JSON.stringify(input);
  } catch (err) {
    return { ok: false, error: `input is not JSON-serializable: ${(err as Error).message}` };
  }
  return withContext(timeoutMs, (ctx): PredicateResult<unknown> => {
    if (inputJson !== undefined) {
      const handle = ctx.newString(inputJson);
      ctx.setProp(ctx.global, "__input", handle);
      handle.dispose();
    } else {
      ctx.setProp(ctx.global, "__input", ctx.undefined);
    }
    const prelude = ctx.evalCode(PRELUDE, "prelude.js");
    if (prelude.error) {
      prelude.error.dispose();
      return { ok: false, error: "predicate sandbox prelude failed" };
    }
    prelude.value.dispose();
    const result = ctx.evalCode(wrap(source, strict, mode), "predicate.js");
    if (result.error) {
      // Uncatchable guest errors: interrupt (timeout), out of memory.
      const err = ctx.dump(result.error);
      result.error.dispose();
      return { ok: false, error: errorText(err) };
    }
    const text = ctx.typeof(result.value) === "string" ? ctx.getString(result.value) : undefined;
    result.value.dispose();
    if (text === undefined) return { ok: false, error: "predicate wrapper returned no result" };
    return JSON.parse(text) as PredicateResult<unknown>;
  });
}

// A dumped guest Error is `{ name, message, stack }`.
function errorText(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}
