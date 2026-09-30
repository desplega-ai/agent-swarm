/**
 * Writes a FIXTURE benchmark snapshot (synthetic numbers, no DB, no run) through
 * the real publish pipeline, for page screenshots and local UI work:
 *
 *   bun scripts/benchmark-fixture.ts /tmp/benchmark-fixture
 *   EVALS_BENCHMARK_DIR=/tmp/benchmark-fixture EVALS_DB_PATH=:memory: bun src/cli.ts serve
 *   open http://localhost:4801/benchmark
 *
 * Never point EVALS_BENCHMARK_DIR at apps/evals/benchmark/ with this: the
 * numbers are made up and the run id says so.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  publicSuiteScenarioIds,
  SUITE_SCENARIO_VERSIONS,
  SUITE_VERSION,
} from "../scenarios/suite.ts";
import type { AnalyticsSourceRow } from "../src/api/analytics.ts";
import { baselinePairs } from "../src/baseline.ts";
import {
  type BenchmarkAttempt,
  buildSnapshot,
  bundleFiles,
  MIN_ATTEMPTS_PER_CELL,
} from "../src/benchmark.ts";
import { METHODOLOGY_PATH } from "../src/benchmark-publish.ts";
import { loadRegistry } from "../src/registry.ts";
import type { EvalRunRow } from "../src/types.ts";

const RUN_ID = "fixture-not-a-real-run";
/** [configId, base score, $ per attempt, agent seconds, resolved model]. */
const CONFIGS: [string, number, number, number, string][] = [
  ["claude-opus-5.5", 0.86, 0.42, 310, "claude-opus-5-5"],
  ["codex-6-astra", 0.83, 1.04, 380, "gpt-6-astra"],
  ["codex-6-luna", 0.74, 0.21, 250, "gpt-6-luna"],
  ["pi-deepseek-v4.1-flash", 0.58, 0.04, 420, "deepseek/deepseek-v4.1-flash"],
];

// Deterministic jitter so the fixture is stable across runs.
let seed = 7;
function rand(): number {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}

const registry = loadRegistry();
const scenarioIds = Object.keys(SUITE_SCENARIO_VERSIONS);
const pairs = baselinePairs([...registry.scenarios.values()]);
const rows: AnalyticsSourceRow[] = [];
const attempts: BenchmarkAttempt[] = [];

for (const [configId, base, cost, seconds, model] of CONFIGS) {
  for (const scenarioId of scenarioIds) {
    const solo = scenarioId.endsWith("-solo");
    // Swarms help on the parallel fan-out and hurt on the sequential review handoff.
    const bias = scenarioId.startsWith("fanout")
      ? solo
        ? -0.12
        : 0.05
      : scenarioId.startsWith("implement-review")
        ? solo
          ? 0.04
          : -0.05
        : 0;
    for (let i = 0; i < MIN_ATTEMPTS_PER_CELL; i++) {
      const score = Math.max(0, Math.min(1, base + bias + (rand() - 0.5) * 0.24));
      const agentMs = Math.round(seconds * 1000 * (solo ? 0.7 : 1) * (0.8 + rand() * 0.4));
      const status = score >= 0.75 ? "passed" : "failed";
      rows.push({
        runId: RUN_ID,
        scenarioId,
        configId,
        status,
        exclusion: null,
        score,
        costUsd: cost * (0.8 + rand() * 0.4),
        costSource: "pricing",
        judgeCostUsd: 0.012,
        durationMs: agentMs + 40_000,
        agentMs,
        resolvedModel: model,
        pinnedModel: null,
        reasoningEffort: null,
        tokenModel: model,
        tokenInput: 40_000,
        tokenOutput: 6_000,
        tokenCacheRead: 0,
        tokenCacheWrite: 0,
        suiteVersion: SUITE_VERSION,
        apiVersion: "1.90.0",
        workerVersion: "1.90.0",
        runName: "fixture",
        runCreatedAt: "2026-10-05T02:00:00.000Z",
      });
      const pair = pairs.find((p) => p.swarmId === scenarioId || p.soloId === scenarioId);
      if (!pair) continue;
      attempts.push({
        attempt: {
          id: `${RUN_ID}_${scenarioId}_${configId}_${i}`,
          runId: RUN_ID,
          scenarioId,
          configId,
          attemptIndex: i,
          status,
          suiteVersion: SUITE_VERSION,
          retries: 0,
          sandboxId: null,
          apiUrl: null,
          taskIds: [],
          score,
          passed: status === "passed",
          error: null,
          costUsd: cost,
          costSource: null,
          judgeCostUsd: 0.012,
          tokens: {
            model,
            inputTokens: solo ? 30_000 : 90_000,
            outputTokens: solo ? 4_000 : 11_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          sandbox: null,
          timings: {
            bootMs: 20_000,
            seedMs: 5_000,
            tasksMs: agentMs,
            perTask: [],
            logCaptureMs: null,
            costMs: null,
            checksMs: null,
            llmJudgeMs: null,
            agenticJudgeMs: null,
            artifactsMs: null,
          },
          durationMs: agentMs + 40_000,
          startedAt: null,
          finishedAt: null,
        },
        judgments: pair.dimensions.map((dimension) => ({ dimension, weight: 1, score })),
      });
    }
  }
}

const run: EvalRunRow = {
  id: RUN_ID,
  name: "FIXTURE",
  status: "done",
  scenarioIds,
  configIds: CONFIGS.map(([id]) => id),
  attemptsPerCell: MIN_ATTEMPTS_PER_CELL,
  concurrency: 4,
  judgeModel: null,
  efforts: {},
  createdAt: "2026-10-05T02:00:00.000Z",
  finishedAt: "2026-10-05T09:40:00.000Z",
};

const outRoot = process.argv[2];
if (!outRoot) throw new Error("usage: bun scripts/benchmark-fixture.ts <outDir>");
const snapshot = buildSnapshot({
  suiteVersion: SUITE_VERSION,
  run,
  rows,
  attempts,
  registry,
  graderFailures: [],
  methodology: await Bun.file(METHODOLOGY_PATH).text(),
  harnessCommit: null,
  publishedAt: "2026-10-05T10:00:00.000Z",
});
for (const [path, content] of Object.entries(bundleFiles(snapshot))) {
  const target = join(outRoot, SUITE_VERSION, path);
  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, content);
}
console.log(
  `fixture ${SUITE_VERSION}: ${publicSuiteScenarioIds().length} public scenarios x ${CONFIGS.length} configs -> ${join(outRoot, SUITE_VERSION)}`,
);
