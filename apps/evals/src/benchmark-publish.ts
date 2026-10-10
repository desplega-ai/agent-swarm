/**
 * `bun src/cli.ts publish --suite 1.0 --run <matrixRunId>`: the IO around the
 * pure snapshot builder in benchmark.ts. Reads the run from the evals DB, runs
 * grader validation, refuses or writes the bundle to `apps/evals/benchmark/<suite>/`.
 *
 * The written directory is what `/benchmark` serves. Commit it in its own PR:
 * merging that PR is the moment the numbers go public.
 */

import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { GRADER_FIXTURES } from "../scenarios/grader-fixtures/index.ts";
import { gradeOffline, nullContext } from "../scenarios/grader-validation-support.ts";
import { mapAnalyticsRow, SUITE_ANALYTICS_SQL } from "./api/analytics-source.ts";
import { benchmarkDir } from "./api/benchmark-routes.ts";
import {
  type BenchmarkSnapshot,
  buildSnapshot,
  bundleFiles,
  heldOutLeaks,
  publishRefusals,
} from "./benchmark.ts";
import { getClaudeAliasMap } from "./cost/pricing.ts";
import { getRun, listAttempts, listJudgments } from "./db/queries.ts";
import { loadRegistry } from "./registry.ts";
import type { Registry } from "./runner/index.ts";
import { DEFAULT_PASS_THRESHOLD } from "./scoring.ts";
import type { Scenario } from "./types.ts";

export const METHODOLOGY_PATH = join(import.meta.dir, "../docs/methodology.md");

/**
 * The same three properties grader-validation.test.ts asserts, as data: the
 * reference solution passes with every gate green, a null agent fails a gate and
 * lands below the pass line, and a null agent cannot pass on full judge marks.
 * One line per broken property; empty = every scenario's grader holds.
 */
export async function graderValidationFailures(scenarios: Scenario[]): Promise<string[]> {
  const failures: string[] = [];
  for (const scenario of scenarios) {
    const fixture = GRADER_FIXTURES[scenario.id];
    if (!fixture) {
      failures.push(`${scenario.id}: no grader fixture`);
      continue;
    }
    try {
      const reference = await gradeOffline({
        scenario,
        ctx: fixture.reference(),
        upfrontTasks: fixture.referenceUpfrontTasks?.(),
        judgeScore: 1,
      });
      const failedGates = reference.gates.filter((g) => !g.pass).map((g) => g.name);
      if (!reference.passed || failedGates.length > 0 || reference.score < DEFAULT_PASS_THRESHOLD) {
        failures.push(
          `${scenario.id}: reference solution does not pass (score ${reference.score.toFixed(3)}${failedGates.length ? `, failed gates ${failedGates.join(", ")}` : ""})`,
        );
      }
      const nullCtx = () => fixture.nullContext?.() ?? nullContext(scenario);
      const honest = await gradeOffline({ scenario, ctx: nullCtx(), judgeScore: 0 });
      if (
        honest.passed ||
        honest.score >= DEFAULT_PASS_THRESHOLD ||
        honest.failedScenarioGates.length === 0
      ) {
        failures.push(`${scenario.id}: a null agent is not held below the pass line by a gate`);
      }
      const generous = await gradeOffline({ scenario, ctx: nullCtx(), judgeScore: 1 });
      if (generous.passed) {
        failures.push(`${scenario.id}: a null agent passes when the judge gives full marks`);
      }
    } catch (err) {
      failures.push(`${scenario.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failures;
}

export const COMMIT_RE = /^[0-9a-f]{40}$/;

async function gitCommit(): Promise<string | null> {
  // The evals image has no .git; a deploy can name its commit instead.
  const fromEnv = process.env.EVALS_HARNESS_COMMIT?.trim();
  if (fromEnv && COMMIT_RE.test(fromEnv)) return fromEnv;
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && COMMIT_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

export type PublishBundle =
  | { ok: true; snapshot: BenchmarkSnapshot; files: Record<string, string> }
  | { ok: false; refusals: string[] };

export type PublishResult =
  | { ok: true; snapshot: BenchmarkSnapshot; outDir: string; files: string[] }
  | { ok: false; refusals: string[] };

export interface PublishOptions {
  suiteVersion: string;
  runId: string;
  /** Default: `<benchmarkDir()>/<suiteVersion>`. */
  outDir?: string;
  registry?: Registry;
  now?: () => Date;
  /** Commit recorded as `run.harnessCommit`; default EVALS_HARNESS_COMMIT, then `git rev-parse HEAD`. */
  harnessCommit?: string | null;
}

/**
 * The bundle `publish` would write, or why it refuses, without touching disk.
 * `GET /api/runs/:id/publish-bundle` serves this so the scheduled weekly run can
 * open the snapshot PR without a local copy of the evals DB.
 */
export async function buildPublishBundle(
  db: Client,
  opts: Omit<PublishOptions, "outDir">,
): Promise<PublishBundle> {
  const run = await getRun(db, opts.runId);
  if (!run) return { ok: false, refusals: [`run ${opts.runId} not found`] };
  const registry = opts.registry ?? loadRegistry();

  const suiteScenarios = [...registry.scenarios.values()];
  const [rowsRes, attemptRows, graderFailures, methodology, harnessCommit, aliasMap] =
    await Promise.all([
      db.execute({ sql: SUITE_ANALYTICS_SQL, args: [opts.suiteVersion] }),
      listAttempts(db, run.id),
      graderValidationFailures(suiteScenarios),
      Bun.file(METHODOLOGY_PATH).text(),
      opts.harnessCommit !== undefined ? Promise.resolve(opts.harnessCommit) : gitCommit(),
      getClaudeAliasMap(),
    ]);
  const attempts = await Promise.all(
    attemptRows.map(async (attempt) => ({
      attempt,
      judgments: await listJudgments(db, attempt.id),
    })),
  );

  const input = {
    suiteVersion: opts.suiteVersion,
    run,
    rows: rowsRes.rows.map((r) => mapAnalyticsRow(r as Record<string, unknown>)),
    attempts,
    registry,
    aliasMap,
    graderFailures,
    methodology,
    harnessCommit,
    publishedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  const refusals = publishRefusals(input);
  if (refusals.length > 0) return { ok: false, refusals };

  const snapshot = buildSnapshot(input);
  const files = bundleFiles(snapshot);
  // Belt and braces: the builder filters held-out rows first, this catches a leak through text.
  const leaks = Object.entries(files).flatMap(([path, content]) =>
    heldOutLeaks(content).map((id) => `${path} mentions held-out scenario ${id}`),
  );
  if (leaks.length > 0) return { ok: false, refusals: leaks };
  return { ok: true, snapshot, files };
}

export async function publishBenchmark(db: Client, opts: PublishOptions): Promise<PublishResult> {
  const bundle = await buildPublishBundle(db, opts);
  if (!bundle.ok) return bundle;
  const outDir = opts.outDir ?? join(benchmarkDir(), opts.suiteVersion);
  // A re-publish replaces the whole version: no stale scenario or config file survives.
  await rm(outDir, { recursive: true, force: true });
  for (const [path, content] of Object.entries(bundle.files)) {
    const target = join(outDir, path);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, content);
  }
  return { ok: true, snapshot: bundle.snapshot, outDir, files: Object.keys(bundle.files) };
}
