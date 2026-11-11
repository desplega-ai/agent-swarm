import { randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import type { SlackMock } from "@desplega.ai/slack-mock";
import { type SimulatedAgent, type SimulatedAgentOptions, startSimulatedAgent } from "./agent-sim";
import { calledCliCommands, cleanupCliTemp, setCliCoverageDir } from "./cli";
import {
  type CoverageManifest,
  coverageFrom,
  EMPTY_MANIFEST,
  emptyCoverage,
  fetchUniverse,
  loadManifest,
} from "./coverage";
import { openReadOnlyDb, type ReadOnlyDb } from "./db";
import { runHarnessLeg, stopHarnessChildren } from "./harness";
import {
  type ApiClient,
  createApiClient,
  pollUntil,
  recordedHttpCalls,
  recordHttpCall,
  truncateHttpCalls,
} from "./http";
import {
  calledMcpTools,
  createMcpConnector,
  listedMcpTools,
  mcpToolsMark,
  restoreMcpTools,
} from "./mcp";
import { type MockLlm, startMockLlm } from "./mocks/llm";
import { loadQuarantine, quarantineProblems } from "./quarantine";
import {
  type E2eResult,
  evaluateGates,
  failsRun,
  helpText,
  type Options,
  parseOptions,
  printHarness,
  printScenario,
  printTotals,
  type ScenarioResult,
  SkipError,
  writeReports,
} from "./report";
import { rerunPlan, settleRerun } from "./rerun";
import { loadScenarios } from "./scenarios/registry";
import { bandOf, bandProblems, coverageInputs, type Observations } from "./shard";
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
  /** The environment the SUT booted with (ports for stand-ins, feature flags). Read-only. */
  sutEnv: Readonly<Record<string, string>>;
  /** The SUT's stdout/stderr so far (current process only). Compare lengths to read what a step added. */
  sutLog: () => Promise<string>;
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
  /**
   * Scenarios whose state this one reads (lower `order` only). A failed scenario reruns
   * once on a fresh API and DB; these replay first, in order, so the rerun starts from the
   * same state. Leave it empty when the scenario passes alone (`--only <name>`).
   */
  needs?: string[];
  run: (ctx: ScenarioContext) => Promise<void>;
};

type BaseContext = Omit<ScenarioContext, "markThread">;

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

/** One isolated environment: Slack mock, inference mock, API process and its DB. */
type Stack = { slack?: SlackHarness; llm?: MockLlm; sut?: Sut; db?: ReadOnlyDb };

const stacks = new Set<Stack>();
const activeAgents = new Set<SimulatedAgent>();
let cleaning = false;

async function stopActiveAgents(): Promise<void> {
  const agents = [...activeAgents];
  activeAgents.clear();
  await Promise.all(agents.map((agent) => agent.stop().catch(() => {})));
}

async function stopStack(stack: Stack, keep: boolean): Promise<void> {
  stacks.delete(stack);
  // Close the read-only handle before stopSut deletes the database files.
  stack.db?.close();
  if (stack.sut) await stopSut(stack.sut, keep);
  if (stack.slack) await stopSlackMock(stack.slack, keep);
  if (stack.llm) await stack.llm.stop();
}

async function cleanup(keep: boolean): Promise<void> {
  if (cleaning) return;
  cleaning = true;
  await stopActiveAgents();
  await stopHarnessChildren();
  for (const stack of [...stacks]) await stopStack(stack, keep);
  await cleanupCliTemp(keep);
}

async function bootStack(
  options: Options,
  journalPath?: string,
): Promise<{ stack: Stack; sut: Sut; db: ReadOnlyDb; ctx: BaseContext }> {
  const stack: Stack = {};
  stacks.add(stack);
  try {
    const slack = await startSlackMock(options.keep, journalPath);
    stack.slack = slack;
    const llm = await startMockLlm();
    stack.llm = llm;
    const sut = await startSut(
      options.keep,
      { ...slack.mock.env, ...llm.env },
      options.sutEnv,
      options.coverageDir,
    );
    stack.sut = sut;
    try {
      await slack.mock.waitForConnection(60_000);
    } catch (error) {
      sut.flushLog();
      throw new Error(
        `Slack socket mode never connected: ${errorMessage(error)}\nLast 40 lines of ${sut.logPath}:\n${await tailLog(sut.logPath, 40)}`,
      );
    }
    const db = openReadOnlyDb(sut.dbPath);
    stack.db = db;
    const api = createApiClient(sut.baseUrl, sut.apiKey);
    const connectMcp = createMcpConnector(sut.baseUrl, sut.apiKey);
    const nonce = randomBytes(6).toString("hex");
    await probeToolUniverse(api, connectMcp, nonce);
    const ctx: BaseContext = {
      api,
      connectMcp,
      baseUrl: sut.baseUrl,
      apiKey: sut.apiKey,
      db,
      slack: slack.mock,
      llm,
      async startAgent(agentOptions) {
        const agent = await startSimulatedAgent({ api, nonce }, agentOptions);
        activeAgents.add(agent);
        return agent;
      },
      recordHttpCall,
      sutEnv: sut.env,
      async sutLog() {
        sut.flushLog();
        return Bun.file(sut.logPath).text();
      },
      async restartSut() {
        const connectionCalls = slack.mock.apiCalls("apps.connections.open").length;
        // A scenario that moved Slack to HTTP mode has no socket to come back.
        const hadSocket = slack.mock.connectionCount > 0;
        db.close();
        await restartSut(sut);
        if (!hadSocket) return;
        const reconnected = await pollUntil(
          () => slack.mock.apiCalls("apps.connections.open").length > connectionCalls,
          60_000,
        );
        if (!reconnected) {
          throw new Error("Restarted API did not request a new Slack socket-mode connection");
        }
        await slack.mock.waitForConnection(60_000);
      },
      log: console.log,
      nonce,
    };
    return { stack, sut, db, ctx };
  } catch (error) {
    await stopStack(stack, options.keep);
    throw error;
  }
}

/** Run one scenario, then stop its pollers and scripted answers so none outlive it. */
async function runInStack(
  scenario: Scenario,
  ctx: BaseContext,
  markThread: ScenarioContext["markThread"],
): Promise<ScenarioResult> {
  const result = await runScenario(scenario, { ...ctx, markThread });
  await stopActiveAgents();
  ctx.llm.reset();
  return result;
}

async function printLogTails(sut: Sut): Promise<void> {
  sut.flushLog();
  const tails = await Promise.all(
    sut.logPaths.map(async (path) => `Last 40 lines of ${path}:\n${await tailLog(path, 40)}`),
  );
  console.error(tails.join("\n"));
}

/** Coverage only the API process of a rerun saw: its DB is gone once the rerun stops. */
type RerunObservations = { nodeTypes: Set<string>; stateValues: Map<string, Set<string>> };

function observe(db: ReadOnlyDb, manifest: CoverageManifest): RerunObservations {
  const stateValues = new Map<string, Set<string>>();
  for (const spec of manifest.stateSurfaces) {
    stateValues.set(
      spec.query,
      new Set(db.query<{ value: unknown }>(spec.query).map((row) => String(row.value))),
    );
  }
  const nodeTypes = new Set(
    db
      .query<{ nodeType: string }>("SELECT DISTINCT nodeType FROM workflow_run_steps")
      .map((row) => row.nodeType),
  );
  return { nodeTypes, stateValues };
}

/**
 * Rerun a failed scenario once, alone, on a fresh API process and DB, after replaying the
 * scenarios it `needs`. Coverage the replay records is dropped (the first pass counted it);
 * the rerun's own calls join the run's sets, which are unions, so nothing counts twice.
 */
async function rerunScenario(
  first: ScenarioResult,
  scenario: Scenario,
  all: readonly Scenario[],
  options: Options,
  manifest: CoverageManifest,
  observed: RerunObservations,
): Promise<ScenarioResult> {
  const callMark = recordedHttpCalls().length;
  const toolMark = mcpToolsMark();
  const noThreads = () => {};
  let booted: Awaited<ReturnType<typeof bootStack>> | undefined;
  try {
    const plan = rerunPlan(scenario, all);
    const replay = plan.slice(0, -1).map((prerequisite) => prerequisite.name);
    console.log(
      `RERUN ${scenario.name} on a fresh API and DB${replay.length > 0 ? ` after ${replay.join(", ")}` : ""}`,
    );
    booted = await bootStack(options);
    for (const prerequisite of plan.slice(0, -1)) {
      const result = await runInStack(prerequisite, booted.ctx, noThreads);
      if (result.status !== "pass") {
        throw new Error(
          `prerequisite ${prerequisite.name} did not pass: ${result.error ?? result.status}`,
        );
      }
    }
    truncateHttpCalls(callMark);
    restoreMcpTools(toolMark);
    const before = observe(booted.db, manifest);
    const rerun = await runInStack(scenario, booted.ctx, noThreads);
    const after = observe(booted.db, manifest);
    // Only what the rerun itself added, never what the replay produced.
    for (const type of after.nodeTypes) {
      if (!before.nodeTypes.has(type)) observed.nodeTypes.add(type);
    }
    for (const [query, values] of after.stateValues) {
      const seen = observed.stateValues.get(query) ?? new Set<string>();
      for (const value of values) if (!before.stateValues.get(query)?.has(value)) seen.add(value);
      observed.stateValues.set(query, seen);
    }
    if (rerun.status === "fail") await printLogTails(booted.sut);
    return settleRerun(first, rerun);
  } catch (error) {
    truncateHttpCalls(callMark);
    restoreMcpTools(toolMark);
    return settleRerun(first, { error: errorMessage(error) });
  } finally {
    if (booted) await stopStack(booted.stack, options.keep);
  }
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
  if (options.shard) {
    const crossings = bandProblems(scenarios);
    if (crossings.length > 0) throw new Error(`Shard bands broken:\n${crossings.join("\n")}`);
  }
  // Fail before booting anything when the manifest itself is malformed. A shard loads it
  // so its state-surface values reach the merge job, which gates strict on the union.
  const manifest =
    options.strict || options.shard ? await loadManifest(MANIFEST_PATH) : EMPTY_MANIFEST;
  const quarantine = await loadQuarantine();
  const quarantineByName = new Map(quarantine.map((entry) => [entry.scenario, entry]));
  const quarantineIssues = quarantineProblems(
    quarantine,
    new Set(scenarios.map((scenario) => scenario.name)),
    new Date().toISOString().slice(0, 10),
  );

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
  // A fresh directory: the report unions every lcov in it, and stale ones would count.
  if (options.coverageDir) await Bun.$`rm -rf ${options.coverageDir}`.quiet();
  // CLI children write their lcov next to the API's, so rule 3 sees CLI lines too.
  setCliCoverageDir(options.coverageDir);
  const { sut, db, ctx } = await bootStack(options, journalPath);
  const api = ctx.api;
  const scenarioResults: ScenarioResult[] = [];
  const threadMarks: ThreadMark[] = [];
  for (const scenario of scenarios) {
    if (options.only && !options.only.has(scenario.name)) continue;
    if (options.skip.has(scenario.name)) continue;
    if (options.group && !scenario.groups?.includes(options.group)) continue;
    if (options.shard && bandOf(scenario.order) !== options.shard.index) continue;
    const result = await runInStack(scenario, ctx, (label, channel, ts) => {
      if (!/^[a-z0-9-]+$/.test(label)) {
        throw new Error(`Invalid visual thread label: ${label}`);
      }
      threadMarks.push({ scenario: scenario.name, label, channel, ts });
    });
    scenarioResults.push(result);
    printScenario(result);
  }
  if (scenarioResults.some((result) => result.status === "fail")) await printLogTails(sut);

  // A failure reruns once, alone, on a fresh API: a pass there is `flaky`, not a failure.
  const rerunObserved: RerunObservations = { nodeTypes: new Set(), stateValues: new Map() };
  const byName = new Map(scenarios.map((scenario) => [scenario.name, scenario]));
  for (const [index, first] of scenarioResults.entries()) {
    if (first.status !== "fail") continue;
    const settled = await rerunScenario(
      first,
      byName.get(first.name)!,
      scenarios,
      options,
      manifest,
      rerunObserved,
    );
    scenarioResults[index] = settled;
    printScenario(settled);
  }
  for (const result of scenarioResults) {
    const entry = quarantineByName.get(result.name);
    if (entry)
      result.quarantine = { owner: entry.owner, reason: entry.reason, expires: entry.expires };
  }

  const harnessResults = [];
  for (const provider of options.harness) {
    const result = await runHarnessLeg(
      provider,
      api,
      sut.baseUrl,
      sut.apiKey,
      ctx.nonce,
      options.harnessAttempts,
    );
    harnessResults.push(result);
    printHarness(result);
  }

  let coverage = emptyCoverage();
  let coverageError: string | undefined;
  let observations: Observations | undefined;
  try {
    observations = {
      universe: await fetchUniverse(api),
      knownScenarios: scenarios.map((scenario) => scenario.name),
      calls: [...recordedHttpCalls()],
      toolUniverse: [...listedMcpTools()],
      calledTools: [...calledMcpTools()],
      nodeTypes: [
        ...new Set([
          ...db
            .query<{ nodeType: string }>("SELECT DISTINCT nodeType FROM workflow_run_steps")
            .map((row) => row.nodeType),
          ...rerunObserved.nodeTypes,
        ]),
      ],
      // Process-wide, like the HTTP call journal. CLI scenarios declare no `needs`, so a
      // rerun replay never runs one.
      calledCommands: [...calledCliCommands()],
      stateValues: Object.fromEntries(
        manifest.stateSurfaces.map((spec) => [
          spec.query,
          [
            ...new Set([
              ...db.query<{ value: unknown }>(spec.query).map((row) => String(row.value)),
              ...(rerunObserved.stateValues.get(spec.query) ?? []),
            ]),
          ],
        ]),
      ),
    };
    coverage = coverageFrom(
      observations.universe,
      coverageInputs(observations, scenarioResults, manifest),
    );
  } catch (error) {
    coverageError = `Coverage calculation failed: ${errorMessage(error)}`;
    console.error(coverageError);
  }
  const gates = evaluateGates(coverage, coverageError, options);
  const ok =
    !scenarioResults.some(failsRun) &&
    !harnessResults.some((leg) => leg.status === "fail") &&
    gates.passed &&
    quarantineIssues.length === 0;
  const result: E2eResult = {
    startedAt,
    durationMs: Date.now() - started,
    sut: { port: sut.port, dbPath: sut.dbPath, logPath: sut.logPath },
    scenarios: scenarioResults,
    harness: harnessResults,
    coverage,
    quarantine: { entries: quarantine, problems: quarantineIssues },
    gates,
    ok,
  };
  if (options.shard && observations) result.shard = { ...options.shard, observations };
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
  printTotals(result);
  await cleanup(options.keep);
  // lcov lands when each API process stops, so count it after cleanup. Never fails the run.
  if (options.coverageDir) {
    const lcov = await Array.fromAsync(
      new Bun.Glob("*/lcov.info").scan({ cwd: options.coverageDir, onlyFiles: true }),
    ).catch(() => []);
    console.log(`Coverage: ${lcov.length} lcov file(s) in ${options.coverageDir}`);
  }
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
