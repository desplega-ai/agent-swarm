/**
 * Report the contract e2e run to the results tracker (`ui-e2e-ingest`, payload v2).
 *
 * Usage: bun scripts/e2e/tracker-ingest.ts [--shards dir] [--lcov-dir dir] [--diff file]
 *          [--out dir] [--dry-run]
 *
 * One payload per shard (`suite: "contract"`), posted in order. The first carries the
 * `coverage` block: whole-run lines from the union of every lcov file, and on a PR the
 * rule 3 result read from `diff-coverage.ts --json`.
 *
 * The tracker is informational. Nothing here exits non-zero: a missing secret, an
 * unreadable shard, a tracker outage and a bad response each log a warning and end
 * the script. Imports no package, so CI runs it without `bun install`.
 *
 * Environment: UI_E2E_INGEST_URL and UI_E2E_INGEST_BEARER (as ui-e2e.yml), and
 * TRACKER_TRIGGER (`pr` or `main`), TRACKER_SHA, TRACKER_REF, TRACKER_PR from the workflow.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inScope, type LineHits, lineRanges, parseExemptions, parseLcov } from "./diff-coverage";
import type { E2eResult, ScenarioResult } from "./report";

export type TrackerRun = {
  repo: string;
  ref: string;
  sha: string;
  prNumber: number | null;
  trigger: "pr" | "main";
  ciUrl?: string;
};

export type CoverageBlock = {
  total: { covered: number; total: number };
  files: Array<{ path: string; covered: number; total: number }>;
  pr?: { changed: number; covered: number; uncovered: Array<{ path: string; ranges: string }> };
};

/** The slice of `diff-coverage.ts --json` this script reads. */
export type DiffResult = {
  report?: {
    changed?: number;
    covered?: number;
    files?: Array<{ path: string; uncovered: number[] }>;
    error?: string;
  };
};

export type IngestPayload = {
  schemaVersion: 2;
  run: {
    repo: string;
    ref: string;
    sha: string;
    prNumber: number | null;
    isFork: false;
    trigger: "pr" | "main";
    runner: "ci";
    suite: "contract";
    shardIndex: number;
    shardTotal: number;
    startedAt: string;
    finishedAt: string;
    ciUrl?: string;
  };
  results: Array<{
    specId: string;
    title: string;
    status: ScenarioResult["status"];
    durationMs: number;
    retries: number;
    error?: string;
  }>;
  coverage?: CoverageBlock;
};

/** `<file>:<title>`, the tracker's stable spec identity. The scenario name is its file name. */
export function scenarioResult(scenario: ScenarioResult): IngestPayload["results"][number] {
  return {
    specId: `scripts/e2e/scenarios/${scenario.name}.ts:${scenario.name}`,
    title: scenario.name,
    status: scenario.status,
    durationMs: Math.max(0, Math.round(scenario.durationMs)),
    retries: Math.max(0, (scenario.attempts?.length ?? 1) - 1),
    // The tracker wants an error on a failure.
    ...(scenario.status === "fail" ? { error: scenario.error ?? "failed" } : {}),
  };
}

export function coverageBlock(
  lcov: LineHits,
  exemptions: readonly string[],
  diff?: DiffResult,
): CoverageBlock | undefined {
  const files = [...lcov]
    .filter(([path]) => inScope(path, exemptions))
    .map(([path, hits]) => ({
      path,
      covered: [...hits.values()].filter((count) => count > 0).length,
      total: hits.size,
    }))
    .filter((file) => file.total > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) return undefined;
  const block: CoverageBlock = {
    total: {
      covered: files.reduce((sum, file) => sum + file.covered, 0),
      total: files.reduce((sum, file) => sum + file.total, 0),
    },
    files,
  };
  const report = diff?.report;
  if (report && !report.error && typeof report.changed === "number") {
    block.pr = {
      changed: report.changed,
      covered: report.covered ?? 0,
      uncovered: (report.files ?? [])
        .filter((file) => file.uncovered.length > 0)
        .map((file) => ({ path: file.path, ranges: lineRanges(file.uncovered) })),
    };
  }
  return block;
}

export function buildPayloads(
  shards: readonly E2eResult[],
  run: TrackerRun,
  coverage?: CoverageBlock,
): IngestPayload[] {
  return shards
    .filter((shard) => shard.shard)
    .sort((a, b) => a.shard!.index - b.shard!.index)
    .map((shard, position) => ({
      schemaVersion: 2,
      run: {
        repo: run.repo,
        ref: run.ref,
        sha: run.sha,
        prNumber: run.prNumber,
        isFork: false,
        trigger: run.trigger,
        runner: "ci",
        suite: "contract",
        shardIndex: shard.shard!.index,
        shardTotal: shard.shard!.total,
        startedAt: shard.startedAt,
        finishedAt: new Date(Date.parse(shard.startedAt) + shard.durationMs).toISOString(),
        ...(run.ciUrl ? { ciUrl: run.ciUrl } : {}),
      },
      results: shard.scenarios.map(scenarioResult),
      // One block per run group. The first payload carries it.
      ...(position === 0 && coverage ? { coverage } : {}),
    }));
}

const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 60_000;
/** Stop starting new work past this; the workflow step has its own, larger, timeout. */
const DEADLINE_MS = 150_000;

/** shortcut: fixed short backoff, no jitter. Upgrade if the tracker needs a real retry policy. */
const BACKOFF_MS = [5_000, 15_000];

async function post(payload: IngestPayload, url: string, bearer: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        "X-Swarm-Timeout-Ms": "180000",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    const text = await response.text();
    const body = (() => {
      try {
        return JSON.parse(text) as { ok?: boolean; error?: { message?: string } };
      } catch {
        return undefined;
      }
    })();
    if (response.status === 200 && body?.ok === true) return null;
    return `HTTP ${response.status} ${body?.error?.message ?? text.slice(0, 200)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Returns the number of payloads the tracker accepted. Never throws. */
export async function postPayloads(
  payloads: readonly IngestPayload[],
  url: string,
  bearer: string,
  options: { deadlineMs?: number; backoffMs?: readonly number[] } = {},
): Promise<number> {
  const deadline = Date.now() + (options.deadlineMs ?? DEADLINE_MS);
  const backoff = options.backoffMs ?? BACKOFF_MS;
  let accepted = 0;
  for (const payload of payloads) {
    const label = `shard ${payload.run.shardIndex}/${payload.run.shardTotal}`;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (Date.now() > deadline) {
        console.log(`::warning::tracker ingest: deadline passed before ${label}`);
        return accepted;
      }
      const problem = await post(payload, url, bearer);
      if (!problem) {
        accepted++;
        console.log(`tracker ingest: ${label} accepted`);
        break;
      }
      console.log(`tracker ingest: ${label} attempt ${attempt}/${ATTEMPTS}: ${problem}`);
      if (attempt === ATTEMPTS) {
        console.log(`::warning::tracker ingest: ${label} not accepted: ${problem}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, backoff[attempt - 1] ?? 0));
      }
    }
  }
  return accepted;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function parseArgs(args: string[]) {
  const options = {
    shards: "e2e-shards",
    lcovDir: "e2e-coverage",
    diff: "e2e-coverage-result.json",
    out: "",
    dryRun: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const next = args[++index];
    if (next === undefined || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--shards") options.shards = next;
    else if (arg === "--lcov-dir") options.lcovDir = next;
    else if (arg === "--diff") options.diff = next;
    else if (arg === "--out") options.out = next;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function lcovFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".info")) {
      found.push(join(entry.parentPath, entry.name));
    }
  }
  return found;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = process.env;
  const trigger = env.TRACKER_TRIGGER === "pr" ? "pr" : "main";
  const run: TrackerRun = {
    repo: env.GITHUB_REPOSITORY ?? "",
    ref: env.TRACKER_REF ?? "",
    sha: env.TRACKER_SHA ?? "",
    prNumber: trigger === "pr" && env.TRACKER_PR ? Number(env.TRACKER_PR) : null,
    trigger,
    ...(env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
      ? {
          ciUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
        }
      : {}),
  };
  if (!run.repo || !run.sha || !run.ref) {
    console.log("tracker ingest skipped: GITHUB_REPOSITORY, TRACKER_SHA or TRACKER_REF is not set");
    return;
  }

  const shards = (existsSync(options.shards) ? readdirSync(options.shards) : [])
    .filter((name) => /^e2e-shard-\d+\.json$/.test(name))
    .map((name) => readJson<E2eResult>(join(options.shards, name)))
    .filter((shard): shard is E2eResult => Boolean(shard?.shard));
  if (shards.length === 0) {
    console.log("tracker ingest skipped: no shard result to report");
    return;
  }

  const lcov: LineHits = new Map();
  for (const path of lcovFiles(options.lcovDir)) parseLcov(readFileSync(path, "utf8"), lcov);
  const exemptionsPath = `${import.meta.dir}/coverage-exemptions.txt`;
  const exemptions = existsSync(exemptionsPath)
    ? parseExemptions(readFileSync(exemptionsPath, "utf8"))
    : [];
  const coverage = coverageBlock(lcov, exemptions, readJson<DiffResult>(options.diff));
  if (!coverage) console.log("tracker ingest: no coverage to report");

  const payloads = buildPayloads(shards, run, coverage);
  if (options.out) {
    mkdirSync(options.out, { recursive: true });
    for (const payload of payloads) {
      writeFileSync(
        join(options.out, `shard-${payload.run.shardIndex}.json`),
        `${JSON.stringify(payload, null, 2)}\n`,
      );
    }
  }
  if (options.dryRun) return;

  const url = env.UI_E2E_INGEST_URL;
  const bearer = env.UI_E2E_INGEST_BEARER;
  if (!url || !bearer) {
    console.log("tracker ingest skipped: UI_E2E_INGEST_URL or UI_E2E_INGEST_BEARER is not set");
    return;
  }
  await postPayloads(payloads, url, bearer);
}

if (import.meta.main) {
  // The tracker never fails the gate: any error ends here as a warning.
  await main().catch((error) => {
    console.log(
      `::warning::tracker ingest failed: ${error instanceof Error ? error.message : error}`,
    );
  });
}
