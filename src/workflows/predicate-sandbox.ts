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

export type PredicateResult = { ok: true; value: unknown } | { ok: false; error: string };

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

function wrap(source: string, strict: boolean): string {
  return `${strict ? '"use strict";' : ""}(() => {
const __r = (${source})(__input === undefined ? undefined : JSON.parse(__input));
if (__r !== null && typeof __r === "object" && typeof __r.then === "function") {
  throw new Error("predicate must be synchronous");
}
return __r;
})()`;
}

/** Throws with the guest's SyntaxError message when `source` does not parse. */
export async function checkPredicateSyntax(source: string): Promise<void> {
  await withContext(1_000, (ctx) => {
    const result = ctx.evalCode(wrap(source, false), "predicate.js", { compileOnly: true });
    if (result.error) {
      const err = ctx.dump(result.error);
      result.error.dispose();
      throw new Error(err?.message ?? String(err));
    }
    result.value.dispose();
  });
}

/**
 * Calls `(source)(input)` in the sandbox. `input` crosses as JSON, so the
 * caller's objects are never shared with the predicate. Returns the dumped
 * result, or the guest error (throw, syntax error, timeout, memory limit).
 */
export async function evaluatePredicate(
  source: string,
  input: unknown,
  { timeoutMs, strict = false }: EvalOptions,
): Promise<PredicateResult> {
  let inputJson: string | undefined;
  try {
    inputJson = JSON.stringify(input);
  } catch (err) {
    return { ok: false, error: `input is not JSON-serializable: ${(err as Error).message}` };
  }
  return withContext(timeoutMs, (ctx): PredicateResult => {
    if (inputJson !== undefined) {
      const handle = ctx.newString(inputJson);
      ctx.setProp(ctx.global, "__input", handle);
      handle.dispose();
    } else {
      ctx.setProp(ctx.global, "__input", ctx.undefined);
    }
    const result = ctx.evalCode(wrap(source, strict), "predicate.js");
    if (result.error) {
      const err = ctx.dump(result.error);
      result.error.dispose();
      return { ok: false, error: err?.message ?? String(err) };
    }
    const value = ctx.dump(result.value);
    result.value.dispose();
    return { ok: true, value };
  });
}
