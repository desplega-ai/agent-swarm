import { parseArgs } from "node:util";
import { DEFAULT_CONFIG_IDS } from "../configs/index.ts";
import { CONFIG_PRESETS, expandPresetSelection } from "../configs/presets.ts";
import { DEFAULT_SCENARIO_IDS } from "../scenarios/index.ts";
import { getDb, initDb } from "./db/client.ts";
import { createRun, getRun, listAttempts, listRuns, resetErrorAttempts } from "./db/queries.ts";
import { loadRegistry } from "./registry.ts";
import { type CellSummary, summarizeRun } from "./results.ts";
import { executeRun, killAllActiveStacks } from "./runner/index.ts";
import { DEFAULT_PASS_THRESHOLD } from "./scoring.ts";

/**
 * Graceful Ctrl-C: stop starting new attempts, tear down live sandboxes, and
 * leave interrupted attempts in a resumable state (`resume <runId>`).
 */
function installSignalHandlers(): AbortController {
  const controller = new AbortController();
  let interrupted = false;
  const handler = (sig: string) => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log(`\n${sig}: aborting — tearing down live sandboxes (press again to force quit)…`);
    controller.abort();
    void killAllActiveStacks()
      .then(() => Bun.sleep(500))
      .finally(() => process.exit(130));
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
  return controller;
}

const HELP = `swarm evals — scenario x harness-config evaluation matrix on E2B

Usage:
  bun src/cli.ts run [--name <n>] [--scenarios a,b] [--configs x,y] [--preset <id>]… [--attempts 1] [--concurrency 2] [--max-retries 1] [--judge-model <openrouter-id>]
  bun src/cli.ts resume <runId>      # continue an interrupted/failed run (safe retry)
  bun src/cli.ts list                # list runs
  bun src/cli.ts show <runId> [--detail]  # print result matrix (mean±CI; --detail adds best@n/pass@1)
  bun src/cli.ts serve [--port 4801] # API + UI
  bun src/cli.ts registry            # list available scenarios + configs

Defaults: scenarios=${DEFAULT_SCENARIO_IDS.join(",")} configs=${DEFAULT_CONFIG_IDS.join(",")}
Presets (--preset, repeatable; see run --help): ${CONFIG_PRESETS.map((p) => p.id).join(", ")}

Env: E2B_API_KEY (required), OPENROUTER_API_KEY (judge + pi/opencode workers),
     CLAUDE_CODE_OAUTH_TOKEN (claude workers), OPENAI_API_KEY (codex + ai-sdk-agent workers),
     EVAL_JUDGE_MODEL, EVALS_DB_SYNC_URL + EVALS_DB_AUTH_TOKEN (Turso embedded
     replica — required unless EVALS_DB_PATH names a plain local file)`;

const RUN_HELP = `Usage: bun src/cli.ts run [options]

Options:
  --name <n>             optional display name for the run
  --scenarios a,b        scenario ids (default: ${DEFAULT_SCENARIO_IDS.join(",")})
  --configs x,y          config ids (default: ${DEFAULT_CONFIG_IDS.join(",")})
  --preset <id>          named config set, repeatable; presets expand in flag
                         order ahead of --configs ids, deduped keeping the
                         first occurrence (neither flag → the default configs)
  --attempts <n>         attempts per scenario × config cell (default 1)
  --concurrency <n>      parallel attempts, one sandbox stack each (default 2)
  --max-retries <n>      retries per errored attempt (default 1)
  --judge-model <id>     OpenRouter judge model override
  --help                 show this help

Presets:
${CONFIG_PRESETS.map(
  (p) => `  ${p.id.padEnd(15)}${p.description}\n${" ".repeat(17)}→ ${p.configIds.join(", ")}`,
).join("\n")}`;

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function cmdRun(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      scenarios: { type: "string" },
      configs: { type: "string" },
      preset: { type: "string", multiple: true },
      help: { type: "boolean" },
      attempts: { type: "string", default: "1" },
      concurrency: { type: "string", default: "2" },
      "max-retries": { type: "string", default: "1" },
      "judge-model": { type: "string" },
    },
  });
  if (values.help) {
    console.log(RUN_HELP);
    return;
  }
  const registry = loadRegistry();
  const scenarioIds = parseCsv(values.scenarios, DEFAULT_SCENARIO_IDS);
  // v7.7 item 1: presets expand in flag order ahead of explicit --configs ids,
  // deduped keeping the first occurrence. Unknown presets throw here — before
  // any DB write. Neither flag → the unchanged DEFAULT_CONFIG_IDS fallback.
  const presetIds = values.preset ?? [];
  const configIds =
    presetIds.length === 0
      ? parseCsv(values.configs, DEFAULT_CONFIG_IDS)
      : expandPresetSelection(presetIds, parseCsv(values.configs, []));
  for (const id of scenarioIds) {
    if (!registry.scenarios.has(id))
      throw new Error(`unknown scenario "${id}" (see: bun src/cli.ts registry)`);
  }
  for (const id of configIds) {
    if (!registry.configs.has(id))
      throw new Error(`unknown config "${id}" (see: bun src/cli.ts registry)`);
  }

  const db = await initDb();
  const runId = `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "").replace("-", "").replace("-", "")}-${crypto.randomUUID().slice(0, 6)}`;
  await createRun(db, {
    id: runId,
    name: values.name,
    scenarioIds,
    configIds,
    attemptsPerCell: Math.max(1, Number(values.attempts)),
    concurrency: Math.max(1, Number(values.concurrency)),
    judgeModel: values["judge-model"],
  });
  console.log(
    `created ${runId}: ${scenarioIds.length} scenario(s) x ${configIds.length} config(s) x ${values.attempts} attempt(s)`,
  );
  const controller = installSignalHandlers();
  await executeRun({
    db,
    runId,
    registry,
    maxRetries: Number(values["max-retries"]),
    signal: controller.signal,
  });
  await cmdShow([runId]);
}

async function cmdResume(argv: string[]): Promise<void> {
  const runId = argv[0];
  if (!runId) throw new Error("usage: resume <runId>");
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { "max-retries": { type: "string", default: "1" } },
  });
  const db = await initDb();
  const reset = await resetErrorAttempts(db, runId);
  if (reset > 0) console.log(`reset ${reset} errored attempt(s) to pending`);
  const controller = installSignalHandlers();
  await executeRun({
    db,
    runId,
    registry: loadRegistry(),
    maxRetries: Number(values["max-retries"]),
    signal: controller.signal,
  });
  await cmdShow([runId]);
}

async function cmdList(): Promise<void> {
  const db = await initDb();
  const runs = await listRuns(db);
  if (runs.length === 0) {
    console.log("no runs yet");
    return;
  }
  for (const run of runs) {
    const summary = summarizeRun(run, await listAttempts(getDb(), run.id));
    console.log(
      `${run.id}  ${run.status.padEnd(9)}  ${summary.totals.passedCells}/${summary.totals.totalCells} cells passed  @n=${run.attemptsPerCell}  ${run.createdAt}${run.name ? `  (${run.name})` : ""}`,
    );
  }
}

async function cmdShow(argv: string[]): Promise<void> {
  const runId = argv[0];
  if (!runId) throw new Error("usage: show <runId>");
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { detail: { type: "boolean", default: false } },
  });
  const detail = Boolean(values.detail);
  const db = await initDb();
  const run = await getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const attempts = await listAttempts(db, runId);
  const summary = summarizeRun(run, attempts);

  console.log(`\n${run.id} [${run.status}] mean±CI @n=${run.attemptsPerCell}`);
  const colWidth = Math.max(...run.configIds.map((c) => c.length), 16) + 2;
  const rowHeader = Math.max(...run.scenarioIds.map((s) => s.length), 8) + 2;
  console.log(" ".repeat(rowHeader) + run.configIds.map((c) => c.padEnd(colWidth)).join(""));
  for (const scenarioId of run.scenarioIds) {
    const cells = run.configIds.map((configId) => {
      const cell = summary.cells.find(
        (c) => c.scenarioId === scenarioId && c.configId === configId,
      );
      if (!cell || cell.finished === 0) return "…".padEnd(colWidth);
      return formatShowCell(cell, DEFAULT_PASS_THRESHOLD, detail).padEnd(colWidth);
    });
    console.log(scenarioId.padEnd(rowHeader) + cells.join(""));
  }
  console.log(
    `\nlegend: «mean ±halfCI · pass-rate» · ✓ CI≥${DEFAULT_PASS_THRESHOLD} · ~ CI straddles · ✗ CI<${DEFAULT_PASS_THRESHOLD}${detail ? " · (detail: best@n / pass@1)" : " · pass --detail for best@n/pass@1"}`,
  );
  const cost = summary.totals.totalCostUsd;
  console.log(
    `${summary.totals.passedCells}/${summary.totals.totalCells} cells passed · ${summary.totals.finished}/${summary.totals.attempts} attempts finished${cost !== null ? ` · $${cost.toFixed(4)} total` : ""}`,
  );
  for (const attempt of attempts.filter((a) => a.status === "error")) {
    console.log(
      `  error ${attempt.scenarioId}×${attempt.configId}#${attempt.attemptIndex}: ${attempt.error?.split("\n")[0]}`,
    );
  }
}

/**
 * Render one matrix cell for `show`: the convergent headline `mean ±halfCI` with
 * a threshold-vs-CI indicator and the pass-rate companion.
 *   ✓  scoreCI.lo ≥ passThreshold  (confidently clears the bar)
 *   ~  CI straddles passThreshold  (more attempts needed to call it)
 *   ✗  scoreCI.hi < passThreshold  (confidently below the bar)
 * best@n / pass@1 stay available behind `--detail`.
 */
export function formatShowCell(cell: CellSummary, passThreshold: number, detail: boolean): string {
  if (cell.meanScore === null || cell.scoreCI === null) {
    const err = cell.errors ? ` E${cell.errors}` : "";
    return `· n/a${err}`;
  }
  const { lo, hi } = cell.scoreCI;
  const mark = lo >= passThreshold ? "✓" : hi < passThreshold ? "✗" : "~";
  const halfCI = (hi - lo) / 2;
  const passRate = cell.passRate !== null ? `${Math.round(cell.passRate * 100)}%` : "—";
  const err = cell.errors ? ` E${cell.errors}` : "";
  const head = `${mark} ${cell.meanScore.toFixed(2)} ±${halfCI.toFixed(2)} · ${passRate}${err}`;
  if (!detail) return head;
  const best = cell.bestScore !== null ? cell.bestScore.toFixed(2) : "—";
  const at1 = cell.passedFirst === null ? "—" : cell.passedFirst ? "✓" : "✗";
  return `${head} [best ${best} · @1 ${at1}]`;
}

function cmdRegistry(): void {
  const registry = loadRegistry();
  console.log("scenarios:");
  for (const s of registry.scenarios.values()) console.log(`  ${s.id.padEnd(20)} ${s.name}`);
  console.log("configs:");
  for (const c of registry.configs.values())
    console.log(`  ${c.id.padEnd(24)} ${c.provider}${c.model ? ` / ${c.model}` : ""}`);
}

// Only run the CLI dispatch when invoked directly (`bun src/cli.ts …`); importing
// this module (e.g. from a unit test for formatShowCell) must NOT execute it.
if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case "run":
        await cmdRun(rest);
        break;
      case "resume":
        await cmdResume(rest);
        break;
      case "list":
        await cmdList();
        break;
      case "show":
        await cmdShow(rest);
        break;
      case "serve": {
        const { values } = parseArgs({ args: rest, options: { port: { type: "string" } } });
        const { startServer } = await import("./api/server.ts");
        await startServer(values.port ? Number(values.port) : undefined);
        break;
      }
      case "registry":
        cmdRegistry();
        break;
      default:
        console.log(HELP);
        if (command && command !== "help") process.exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
