// biome-ignore-all lint/correctness/noUnusedVariables: the scripts that pack.ts appends to this file use these helpers.
// Stress pack prelude. pack.ts puts this file in front of every script it saves,
// so the script files in this directory hold no imports of their own.
// No LLM, no task, no agent: these scripts only call the swarm API.
import type { ScriptContext } from "swarm-sdk";

const NS = "stress";
/** Result records live this long (the scoreboard deletes them sooner). */
const RESULT_TTL_SEC = 6 * 3600;
/**
 * Requests one script keeps in flight. The sandbox allows 64 open files, so a
 * script that opens more sockets than that fails with EMFILE.
 */
const MAX_IN_FLIGHT = 20;
/** Every error this pack raises on purpose carries this marker. */
const EXPECTED = "STRESS_EXPECTED";

// biome-ignore lint/suspicious/noExplicitAny: SDK responses are untyped JSON.
type Any = any;
type Sdk = { success: boolean; status: number; data: Any };
type Check = { name: string; ok: boolean; error?: string };
type Tally = {
  checks: Check[];
  ok(name: string, cond: unknown, detail?: unknown): boolean;
};
type StressEnv = { level: number; id: string; startedAt: number };

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function tally(): Tally {
  const checks: Check[] = [];
  return {
    checks,
    ok(name, cond, detail) {
      const pass = Boolean(cond);
      const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? "check failed");
      checks.push(
        pass ? { name, ok: true } : { name, ok: false, error: String(text).slice(0, 400) },
      );
      return pass;
    },
  };
}

/** Read one key of the pack namespace. A missing key is `undefined`. */
async function kvValue(ctx: ScriptContext, key: string): Promise<Any> {
  const entry = await ctx.swarm.kv_getOrNull({ namespace: NS, key });
  return entry === null ? undefined : entry.value;
}

/** The kill switch and the intensity. Anything but `true` means off. */
async function gate(ctx: ScriptContext): Promise<{ enabled: boolean; level: number }> {
  const enabled = (await kvValue(ctx, "stress/enabled")) === true;
  if (!enabled) return { enabled, level: 1 };
  const raw = Number(await kvValue(ctx, "stress/level"));
  const level = Number.isInteger(raw) && raw >= 1 && raw <= 3 ? raw : 1;
  return { enabled, level };
}

/** Write the result record of one piece and count it in the running totals. */
async function record(
  ctx: ScriptContext,
  name: string,
  env: StressEnv,
  t: Tally,
  nums: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const failed = t.checks.filter((check) => !check.ok);
  const rec = {
    name,
    runId: env.id,
    ok: failed.length === 0,
    at: env.startedAt,
    ms: Date.now() - env.startedAt,
    level: env.level,
    checks: t.checks.length,
    failed: failed.slice(0, 20).map((check) => ({ check: check.name, error: check.error })),
    nums,
  };
  const saved = (await ctx.swarm.kv_set({
    namespace: NS,
    key: `stress/results/${name}/${env.id}`,
    value: rec,
    expiresInSec: RESULT_TTL_SEC,
  })) as Sdk;
  await ctx.swarm.kv_incr({
    namespace: NS,
    key: `stress/totals/${name}/${rec.ok ? "pass" : "fail"}`,
  });
  if (!saved.success) {
    throw new Error(`could not write the result record: HTTP ${saved.status}`);
  }
  return rec;
}

/**
 * Run one piece: read the kill switch first, run the checks, write the record.
 * A check that fails, or an error the body did not expect, is recorded as a
 * failed result. The run itself still completes, so a schedule never counts
 * consecutive errors and never disables itself.
 */
async function stressRun(
  ctx: ScriptContext,
  name: string,
  body: (t: Tally, env: StressEnv) => Promise<Record<string, unknown> | undefined>,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const g = await gate(ctx);
  if (!g.enabled) return { skipped: "stress/enabled is not true" };
  const env: StressEnv = { level: g.level, id: newId(), startedAt };
  const t = tally();
  let nums: Record<string, unknown> = {};
  try {
    nums = (await body(t, env)) ?? {};
  } catch (err) {
    t.ok("no-unexpected-error", false, errText(err));
  }
  // The record write must not fail the run: a failed run counts as a schedule
  // error, and five of them in a row disable the schedule.
  for (let attempt = 1; ; attempt++) {
    try {
      return await record(ctx, name, env, t, nums);
    } catch (err) {
      if (attempt >= 3) return { name, ok: false, recordError: errText(err) };
      await sleep(500 * attempt);
    }
  }
}

/** Zip db_query's positional rows into objects. */
function dbRows(res: Sdk): Record<string, Any>[] {
  const columns: string[] = res?.data?.columns ?? [];
  const rows: unknown[][] = res?.data?.rows ?? [];
  return rows.map((row) =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]])),
  );
}

/** Run `fn` over `items` with at most `width` calls in flight. */
async function pooled<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}
