import { randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import type { SlackMock } from "@desplega.ai/slack-mock";
import { type SimulatedAgent, type SimulatedAgentOptions, startSimulatedAgent } from "./agent-sim";
import {
  type Coverage,
  computeCoverage,
  EMPTY_MANIFEST,
  loadManifest,
  strictFailures,
} from "./coverage";
import { openReadOnlyDb, type ReadOnlyDb } from "./db";
import { runHarnessLeg, stopHarnessChildren } from "./harness";
import {
  type ApiClient,
  createApiClient,
  pollUntil,
  recordedHttpCalls,
  recordHttpCall,
} from "./http";
import { calledMcpTools, createMcpConnector, listedMcpTools } from "./mcp";
import { type MockLlm, startMockLlm } from "./mocks/llm";
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
import { loadScenarios } from "./scenarios/registry";
import { type SlackHarness, startSlackMock, stopSlackMock } from "./slack";
import { repoRoot, restartSut, type Sut, startSut, stopSut, tailLog } from "./sut";

export type ScenarioContext = {
  api: ApiClient;
  connectMcp: ReturnType<typeof createMcpConnector>;
  baseUrl: string;
  apiKey: string;
  db: ReadOnlyDb;
  slack: SlackMock;
  /** Mock inference host: journal of what the server sent, scriptable answers. */
  llm: MockLlm;
  /**
   * Start a simulated agent that polls and settles tasks over the API. The runner stops
   * every agent a scenario started when the scenario ends, so a lingering poller cannot
   * steal the next scenario's pool tasks. Stop earlier yourself when the scenario needs it.
   */
  startAgent: (options?: SimulatedAgentOptions) => Promise<SimulatedAgent>;
  /** Count a request made outside `ctx.api` (raw fetch, WebSocket, SSE) toward coverage. */
  recordHttpCall: typeof recordHttpCall;
  log: (message: string) => void;
  markThread: (label: string, channel: string, ts: string) => void;
  restartSut: () => Promise<void>;
  nonce: string;
};
export type Scenario = {
  name: string;
  /**
   * Explicit run order. Scenarios execute in ascending `order`, never
   * filesystem/import order — several scenarios carry cross-scenario state
   * (see the slack-delegation-* files), so a directory-scan registry cannot
   * be allowed to reorder them implicitly. Leave gaps (10, 20, 30, ...) so a
   * new scenario can slot in without renumbering its neighbors.
   */
  order: number;
  /**
   * Tags a CI workflow can select on instead of a hardcoded scenario-name
   * list (see .github/workflows/slack-visuals.yml's `--group` usage). A new
   * scenario joins a workflow by declaring the group here, not by editing
   * the workflow file.
   */
  groups?: string[];
  run: (ctx: ScenarioContext) => Promise<void>;
};

type ThreadMark = { scenario: string; label: string; channel: string; ts: string };

const MANIFEST_PATH = `${import.meta.dir}/coverage-manifest.json`;

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
  const empty = { total: 0, covered: 0, excluded: 0, percent: 0, uncovered: [] };
  const latency = { count: 0, p50: 0, p95: 0, max: 0 };
  return {
    routes: { ...empty, byGroup: {}, unknown: [] },
    mcpTools: { ...empty },
    nodeTypes: { ...empty },
    flows: [],
    staleExclusions: [],
    deadExclusions: [],
    unknownFlowScenarios: [],
    latency: { byGroup: {}, overall: latency },
  };
}

/**
 * The MCP tool universe is what tools/list returns to a registered agent. Probing it
 * here, before any scenario, makes the denominator independent of which scenarios ran
 * (`--only` must not shrink the universe into a false 100%). The probe is a worker on
 * purpose: tool registration does not depend on role, and a lead would change task
 * routing (follow-up tasks, pool auto-assignment) for every later scenario.
 */
async function probeToolUniverse(
  api: ApiClient,
  connectMcp: ReturnType<typeof createMcpConnector>,
  nonce: string,
): Promise<void> {
  const registered = await api("POST", "/api/agents", {
    body: { name: `e2e-universe-probe-${nonce}`, role: "worker", status: "online" },
  });
  if (registered.status !== 201) {
    throw new Error(`Registering the universe probe failed: ${registered.status}`);
  }
  const id = (registered.json as { id?: unknown }).id;
  if (typeof id !== "string") throw new Error("Universe probe has no id");
  const connection = await connectMcp(id);
  try {
    await connection.listTools();
  } finally {
    await connection.close();
  }
}

let activeSut: Sut | undefined;
let activeSlack: SlackHarness | undefined;
let activeLlm: MockLlm | undefined;
let activeDb: ReadOnlyDb | undefined;
const activeAgents = new Set<SimulatedAgent>();
let cleaning = false;

async function stopActiveAgents(): Promise<void> {
  const agents = [...activeAgents];
  activeAgents.clear();
  await Promise.all(agents.map((agent) => agent.stop().catch(() => {})));
}

async function cleanup(keep: boolean): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  await stopActiveAgents();
  await stopHarnessChildren();
  // Close the read-only handle before stopSut deletes the database files.
  activeDb?.close();
  if (activeSut) await stopSut(activeSut, keep);
  if (activeSlack) await stopSlackMock(activeSlack, keep);
  if (activeLlm) await activeLlm.stop();
}

async function main(): Promise<number> {
  const scenarios = await loadScenarios();
  const options = parseOptions(
    process.argv.slice(2),
    scenarios.map((scenario) => scenario.name),
    [...new Set(scenarios.flatMap((scenario) => scenario.groups ?? []))],
  );
  if (options.help) {
    console.log(helpText);
    return 0;
  }
  if (options.list) {
    for (const scenario of scenarios) console.log(scenario.name);
    return 0;
  }
  // Fail before booting anything when the manifest itself is malformed.
  const manifest = options.strict ? await loadManifest(MANIFEST_PATH) : EMPTY_MANIFEST;

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
  activeLlm = await startMockLlm();
  activeSut = await startSut(
    options.keep,
    { ...activeSlack.mock.env, ...activeLlm.env },
    options.sutEnv,
  );
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
  const connectMcp = createMcpConnector(activeSut.baseUrl, activeSut.apiKey);
  const nonce = randomBytes(6).toString("hex");
  await probeToolUniverse(api, connectMcp, nonce);
  const llm = activeLlm;
  const ctx: Omit<ScenarioContext, "markThread"> = {
    api,
    connectMcp,
    baseUrl: activeSut.baseUrl,
    apiKey: activeSut.apiKey,
    db: activeDb,
    slack: activeSlack.mock,
    llm,
    async startAgent(agentOptions) {
      const agent = await startSimulatedAgent({ api, nonce }, agentOptions);
      activeAgents.add(agent);
      return agent;
    },
    recordHttpCall,
    async restartSut() {
      if (!activeSut || !activeSlack) throw new Error("E2E harness is not running");
      const connectionCalls = activeSlack.mock.apiCalls("apps.connections.open").length;
      activeDb?.close();
      await restartSut(activeSut);
      const reconnected = await pollUntil(
        () => activeSlack!.mock.apiCalls("apps.connections.open").length > connectionCalls,
        60_000,
      );
      if (!reconnected) {
        throw new Error("Restarted API did not request a new Slack socket-mode connection");
      }
      await activeSlack.mock.waitForConnection(60_000);
    },
    log: console.log,
    nonce,
  };
  const scenarioResults: ScenarioResult[] = [];
  const threadMarks: ThreadMark[] = [];
  for (const scenario of scenarios) {
    if (options.only && !options.only.has(scenario.name)) continue;
    if (options.skip.has(scenario.name)) continue;
    if (options.group && !scenario.groups?.includes(options.group)) continue;
    const result = await runScenario(scenario, {
      ...ctx,
      markThread(label, channel, ts) {
        if (!/^[a-z0-9-]+$/.test(label)) {
          throw new Error(`Invalid visual thread label: ${label}`);
        }
        threadMarks.push({ scenario: scenario.name, label, channel, ts });
      },
    });
    // Scenario hygiene: no poller and no scripted answer outlives its scenario.
    await stopActiveAgents();
    llm.reset();
    scenarioResults.push(result);
    printScenario(result);
  }
  if (scenarioResults.some((result) => result.status === "fail")) {
    activeSut.flushLog();
    const tails = await Promise.all(
      activeSut.logPaths.map(
        async (path) => `Last 40 lines of ${path}:\n${await tailLog(path, 40)}`,
      ),
    );
    console.error(tails.join("\n"));
  }

  const harnessResults = [];
  for (const provider of options.harness) {
    const result = await runHarnessLeg(
      provider,
      api,
      activeSut.baseUrl,
      activeSut.apiKey,
      ctx.nonce,
      options.harnessAttempts,
    );
    harnessResults.push(result);
    printHarness(result);
  }

  let coverage = emptyCoverage();
  let coverageError: string | undefined;
  try {
    const observedNodeTypes = new Set(
      activeDb
        .query<{ nodeType: string }>("SELECT DISTINCT nodeType FROM workflow_run_steps")
        .map((row) => row.nodeType),
    );
    coverage = await computeCoverage(api, {
      calls: recordedHttpCalls(),
      toolUniverse: listedMcpTools(),
      calledTools: calledMcpTools(),
      observedNodeTypes,
      scenarios: scenarioResults,
      knownScenarios: new Set(scenarios.map((scenario) => scenario.name)),
      manifest,
    });
  } catch (error) {
    coverageError = `Coverage calculation failed: ${errorMessage(error)}`;
    console.error(coverageError);
  }
  const failures = options.strict && !coverageError ? strictFailures(coverage) : [];
  const gatesPassed =
    !coverageError &&
    coverage.routes.percent >= options.minRouteCoverage &&
    coverage.mcpTools.percent >= options.minToolCoverage &&
    failures.length === 0;
  const scenarioFailures = scenarioResults.filter((result) => result.status === "fail").length;
  const skips = scenarioResults.filter((result) => result.status === "skip").length;
  const harnessFailures = harnessResults.filter((result) => result.status === "fail").length;
  const passes =
    scenarioResults.filter((result) => result.status === "pass").length +
    harnessResults.filter((result) => result.status === "pass").length;
  const ok = scenarioFailures === 0 && harnessFailures === 0 && gatesPassed;
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
      strict: options.strict,
      failures,
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
    `${ok ? "PASS" : "FAIL"}: ${passes} passed, ${scenarioFailures + harnessFailures} failed, ${skips} skipped`,
  );
  const surfaceLine = (label: string, surface: Coverage["mcpTools"]) =>
    `${label}: ${surface.covered}/${surface.total} (${surface.percent.toFixed(1)}%)` +
    (surface.excluded > 0 ? `, ${surface.excluded} excluded` : "");
  console.log(surfaceLine("routes", coverage.routes));
  console.log(surfaceLine("mcp tools", coverage.mcpTools));
  console.log(surfaceLine("workflow node types", coverage.nodeTypes));
  console.log(
    `latency: p50 ${coverage.latency.overall.p50} ms, p95 ${coverage.latency.overall.p95} ms over ${coverage.latency.overall.count} calls`,
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
    for (const failure of failures) console.error(`Strict coverage gate failed: ${failure}`);
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
