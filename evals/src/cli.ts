import { parseArgs } from "node:util";
import { DEFAULT_CONFIG_IDS } from "../configs/index.ts";
import { DEFAULT_SCENARIO_IDS } from "../scenarios/index.ts";
import { getDb, initDb } from "./db/client.ts";
import { createRun, getRun, listAttempts, listRuns, resetErrorAttempts } from "./db/queries.ts";
import { loadRegistry } from "./registry.ts";
import { summarizeRun } from "./results.ts";
import { executeRun, killAllActiveStacks } from "./runner/index.ts";

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
  bun src/cli.ts run [--name <n>] [--scenarios a,b] [--configs x,y] [--attempts 1] [--concurrency 2] [--max-retries 1] [--judge-model <openrouter-id>]
  bun src/cli.ts resume <runId>      # continue an interrupted/failed run (safe retry)
  bun src/cli.ts list                # list runs
  bun src/cli.ts show <runId>        # print result matrix
  bun src/cli.ts serve [--port 4801] # API + UI
  bun src/cli.ts registry            # list available scenarios + configs

Defaults: scenarios=${DEFAULT_SCENARIO_IDS.join(",")} configs=${DEFAULT_CONFIG_IDS.join(",")}

Env: E2B_API_KEY (required), OPENROUTER_API_KEY (judge + pi/opencode workers),
     CLAUDE_CODE_OAUTH_TOKEN (claude workers), OPENAI_API_KEY (codex workers),
     EVAL_JUDGE_MODEL, TURSO_DATABASE_URL/TURSO_AUTH_TOKEN (else local evals.db)`;

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
      attempts: { type: "string", default: "1" },
      concurrency: { type: "string", default: "2" },
      "max-retries": { type: "string", default: "1" },
      "judge-model": { type: "string" },
    },
  });
  const registry = loadRegistry();
  const scenarioIds = parseCsv(values.scenarios, DEFAULT_SCENARIO_IDS);
  const configIds = parseCsv(values.configs, DEFAULT_CONFIG_IDS);
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
      `${run.id}  ${run.status.padEnd(9)}  ${summary.totals.passedCells}/${summary.totals.totalCells} cells passed  best@${run.attemptsPerCell}  ${run.createdAt}${run.name ? `  (${run.name})` : ""}`,
    );
  }
}

async function cmdShow(argv: string[]): Promise<void> {
  const runId = argv[0];
  if (!runId) throw new Error("usage: show <runId>");
  const db = await initDb();
  const run = await getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const attempts = await listAttempts(db, runId);
  const summary = summarizeRun(run, attempts);

  console.log(`\n${run.id} [${run.status}] best@${run.attemptsPerCell}`);
  const colWidth = Math.max(...run.configIds.map((c) => c.length), 10) + 2;
  const rowHeader = Math.max(...run.scenarioIds.map((s) => s.length), 8) + 2;
  console.log(" ".repeat(rowHeader) + run.configIds.map((c) => c.padEnd(colWidth)).join(""));
  for (const scenarioId of run.scenarioIds) {
    const cells = run.configIds.map((configId) => {
      const cell = summary.cells.find(
        (c) => c.scenarioId === scenarioId && c.configId === configId,
      );
      if (!cell || cell.finished === 0) return "…".padEnd(colWidth);
      const mark = cell.passedAny ? "✓" : "✗";
      const score = cell.bestScore !== null ? cell.bestScore.toFixed(2) : "0.00";
      const err = cell.errors ? ` E${cell.errors}` : "";
      return `${mark} ${score}${err}`.padEnd(colWidth);
    });
    console.log(scenarioId.padEnd(rowHeader) + cells.join(""));
  }
  const cost = summary.totals.totalCostUsd;
  console.log(
    `\n${summary.totals.passedCells}/${summary.totals.totalCells} cells passed · ${summary.totals.finished}/${summary.totals.attempts} attempts finished${cost !== null ? ` · $${cost.toFixed(4)} total` : ""}`,
  );
  for (const attempt of attempts.filter((a) => a.status === "error")) {
    console.log(
      `  error ${attempt.scenarioId}×${attempt.configId}#${attempt.attemptIndex}: ${attempt.error?.split("\n")[0]}`,
    );
  }
}

function cmdRegistry(): void {
  const registry = loadRegistry();
  console.log("scenarios:");
  for (const s of registry.scenarios.values()) console.log(`  ${s.id.padEnd(20)} ${s.name}`);
  console.log("configs:");
  for (const c of registry.configs.values())
    console.log(`  ${c.id.padEnd(24)} ${c.provider}${c.model ? ` / ${c.model}` : ""}`);
}

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
