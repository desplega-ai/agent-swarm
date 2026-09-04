import { randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import type { SlackMock } from "@desplega.ai/slack-mock";
import { type Coverage, computeCoverage } from "./coverage";
import { openReadOnlyDb, type ReadOnlyDb } from "./db";
import { runHarnessLeg, stopHarnessChildren } from "./harness";
import { type ApiClient, createApiClient, recordedHttpCalls } from "./http";
import { calledMcpTools, createMcpConnector, listedMcpTools } from "./mcp";
import {
  type E2eResult,
  helpText,
  parseOptions,
  printHarness,
  printScenario,
  type ScenarioResult,
  SkipError,
  writeReports,
} from "./report";
import { auth } from "./scenarios/auth";
import { configRoundtrip } from "./scenarios/config-roundtrip";
import { health } from "./scenarios/health";
import { mcpSurface } from "./scenarios/mcp-surface";
import { slackFailedTask } from "./scenarios/slack-failed-task";
import { slackFollowUp } from "./scenarios/slack-follow-up";
import { slackMention } from "./scenarios/slack-mention";
import { taskLifecycle } from "./scenarios/task-lifecycle";
import { workflowScriptNode } from "./scenarios/workflow-script-node";
import { type SlackHarness, startSlackMock, stopSlackMock } from "./slack";
import { repoRoot, type Sut, startSut, stopSut, tailLog } from "./sut";

export type ScenarioContext = {
  api: ApiClient;
  connectMcp: ReturnType<typeof createMcpConnector>;
  baseUrl: string;
  apiKey: string;
  db: ReadOnlyDb;
  slack: SlackMock;
  log: (message: string) => void;
  markThread: (label: string, channel: string, ts: string) => void;
  nonce: string;
};
export type Scenario = { name: string; run: (ctx: ScenarioContext) => Promise<void> };

const scenarios: Scenario[] = [
  health,
  auth,
  taskLifecycle,
  mcpSurface,
  workflowScriptNode,
  configRoundtrip,
  slackMention,
  slackFollowUp,
  slackFailedTask,
];

type ThreadMark = { scenario: string; label: string; channel: string; ts: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runScenario(scenario: Scenario, ctx: ScenarioContext): Promise<ScenarioResult> {
  const started = Date.now();
  try {
    await scenario.run(ctx);
    return { name: scenario.name, status: "pass", durationMs: Date.now() - started };
  } catch (error) {
    return {
      name: scenario.name,
      status: error instanceof SkipError ? "skip" : "fail",
      durationMs: Date.now() - started,
      error: errorMessage(error),
    };
  }
}

function emptyCoverage(): Coverage {
  return {
    routes: { total: 0, covered: 0, percent: 0, byGroup: {}, uncovered: [], unknown: [] },
    mcpTools: { total: 0, covered: 0, percent: 0, uncovered: [] },
  };
}

let activeSut: Sut | undefined;
let activeSlack: SlackHarness | undefined;
let activeDb: ReadOnlyDb | undefined;
let cleaning = false;

async function cleanup(keep: boolean): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  await stopHarnessChildren();
  // Close the read-only handle before stopSut deletes the database files.
  activeDb?.close();
  if (activeSut) await stopSut(activeSut, keep);
  if (activeSlack) await stopSlackMock(activeSlack, keep);
}

async function main(): Promise<number> {
  const options = parseOptions(
    process.argv.slice(2),
    scenarios.map((scenario) => scenario.name),
  );
  if (options.help) {
    console.log(helpText);
    return 0;
  }
  if (options.list) {
    for (const scenario of scenarios) console.log(scenario.name);
    return 0;
  }

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const visualsDir = options.visualsDir ? resolve(options.visualsDir) : undefined;
  const journalPath = visualsDir ? `${visualsDir}/slack-journal.jsonl` : undefined;
  if (visualsDir && journalPath) {
    await Bun.$`mkdir -p ${visualsDir}`.quiet();
    await Bun.file(journalPath)
      .delete()
      .catch(() => {});
  }
  activeSlack = await startSlackMock(options.keep, journalPath);
  activeSut = await startSut(options.keep, activeSlack.mock.env, options.sutEnv);
  try {
    await activeSlack.mock.waitForConnection(60_000);
  } catch (error) {
    activeSut.flushLog();
    throw new Error(
      `Slack socket mode never connected: ${errorMessage(error)}\nLast 40 lines of ${activeSut.logPath}:\n${await tailLog(activeSut.logPath, 40)}`,
    );
  }
  activeDb = openReadOnlyDb(activeSut.dbPath);
  const api = createApiClient(activeSut.baseUrl, activeSut.apiKey);
  const ctx: Omit<ScenarioContext, "markThread"> = {
    api,
    connectMcp: createMcpConnector(activeSut.baseUrl, activeSut.apiKey),
    baseUrl: activeSut.baseUrl,
    apiKey: activeSut.apiKey,
    db: activeDb,
    slack: activeSlack.mock,
    log: console.log,
    nonce: randomBytes(6).toString("hex"),
  };
  const scenarioResults: ScenarioResult[] = [];
  const threadMarks: ThreadMark[] = [];
  for (const scenario of scenarios) {
    if (options.only && !options.only.has(scenario.name)) continue;
    if (options.skip.has(scenario.name)) continue;
    const result = await runScenario(scenario, {
      ...ctx,
      markThread(label, channel, ts) {
        if (!/^[a-z0-9-]+$/.test(label)) {
          throw new Error(`Invalid visual thread label: ${label}`);
        }
        threadMarks.push({ scenario: scenario.name, label, channel, ts });
      },
    });
    scenarioResults.push(result);
    printScenario(result);
  }
  if (scenarioResults.some((result) => result.status === "fail")) {
    activeSut.flushLog();
    console.error(
      `Last 40 lines of ${activeSut.logPath}:\n${await tailLog(activeSut.logPath, 40)}`,
    );
  }

  const harnessResults = [];
  for (const provider of options.harness) {
    const result = await runHarnessLeg(
      provider,
      api,
      activeSut.baseUrl,
      activeSut.apiKey,
      ctx.nonce,
    );
    harnessResults.push(result);
    printHarness(result);
  }

  let coverage = emptyCoverage();
  let coverageError: string | undefined;
  try {
    coverage = await computeCoverage(api, recordedHttpCalls(), listedMcpTools(), calledMcpTools());
  } catch (error) {
    coverageError = `Coverage calculation failed: ${errorMessage(error)}`;
    console.error(coverageError);
  }
  const gatesPassed =
    !coverageError &&
    coverage.routes.percent >= options.minRouteCoverage &&
    coverage.mcpTools.percent >= options.minToolCoverage;
  const failures = scenarioResults.filter((result) => result.status === "fail").length;
  const skips = scenarioResults.filter((result) => result.status === "skip").length;
  const harnessFailures = harnessResults.filter((result) => result.status === "fail").length;
  const passes =
    scenarioResults.filter((result) => result.status === "pass").length +
    harnessResults.filter((result) => result.status === "pass").length;
  const ok = failures === 0 && harnessFailures === 0 && gatesPassed;
  const result: E2eResult = {
    startedAt,
    durationMs: Date.now() - started,
    sut: { port: activeSut.port, dbPath: activeSut.dbPath, logPath: activeSut.logPath },
    scenarios: scenarioResults,
    harness: harnessResults,
    coverage,
    gates: {
      minRouteCoverage: options.minRouteCoverage,
      minToolCoverage: options.minToolCoverage,
      passed: gatesPassed,
    },
    ok,
  };
  await writeReports(result, options.jsonPath, options.summaryPath);
  if (visualsDir) {
    await Bun.write(
      `${visualsDir}/manifest.json`,
      `${JSON.stringify(
        {
          profile: basename(visualsDir),
          sutEnv: options.sutEnv,
          journal: "slack-journal.jsonl",
          slackManifest: resolve(repoRoot, "slack-manifest.json"),
          scenarios: scenarioResults.map((scenario) => ({
            name: scenario.name,
            status: scenario.status,
            durationMs: scenario.durationMs,
            error: scenario.error ?? null,
            threads: threadMarks
              .filter((thread) => thread.scenario === scenario.name)
              .map(({ label, channel, ts }) => ({ label, channel, ts })),
          })),
        },
        null,
        2,
      )}\n`,
    );
  }
  console.log(
    `${ok ? "PASS" : "FAIL"}: ${passes} passed, ${failures + harnessFailures} failed, ${skips} skipped`,
  );
  console.log(
    `routes: ${coverage.routes.covered}/${coverage.routes.total} (${coverage.routes.percent.toFixed(1)}%)`,
  );
  console.log(
    `mcp tools: ${coverage.mcpTools.covered}/${coverage.mcpTools.total} (${coverage.mcpTools.percent.toFixed(1)}%)`,
  );
  if (!gatesPassed) {
    if (coverage.routes.percent < options.minRouteCoverage)
      console.error(
        `Route coverage gate failed: ${coverage.routes.percent.toFixed(1)}% < ${options.minRouteCoverage}%`,
      );
    if (coverage.mcpTools.percent < options.minToolCoverage)
      console.error(
        `MCP tool coverage gate failed: ${coverage.mcpTools.percent.toFixed(1)}% < ${options.minToolCoverage}%`,
      );
  }
  await cleanup(options.keep);
  return ok ? 0 : 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup(false).finally(() => process.exit(1));
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(errorMessage(error));
  await cleanup(false);
  process.exitCode = 1;
}
