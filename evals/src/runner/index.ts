import type { Client } from "@libsql/client";
import { recomputeCost, recomputeCostMulti } from "../cost/recompute.ts";
import {
  clearAttemptResults,
  getRun,
  insertArtifact,
  insertAttempt,
  insertJudgment,
  listAttempts,
  listUnfinishedAttempts,
  setRunStatus,
  updateAttempt,
} from "../db/queries.ts";
import { AgenticJudgeError, judgeAgentic } from "../judge/agentic.ts";
import { runChecks } from "../judge/deterministic.ts";
import { beginJudging, clearJudging, endJudging } from "../judge/live-registry.ts";
import { judgeWithLlm } from "../judge/llm.ts";
import {
  beginAttemptProgress,
  finishAttemptProgress,
  formatRunnerLog,
  logLevelFor,
  pushAttemptLog,
  recordAttemptTimings,
  setAttemptPhase,
} from "../live/attempt-progress.ts";
import {
  type AgentJson,
  flattenTranscript,
  type SessionCostRow,
  SwarmClient,
} from "../swarm/client.ts";
import {
  type BootMember,
  bootStack,
  collectHarnessSessionFiles,
  markAttemptStart,
  type StackHandle,
  sandboxExec,
  sandboxReadFile,
  sweepRunSandboxes,
  type WorkerHandle,
} from "../swarm/sandbox.ts";
import {
  type AttemptRow,
  CASCADE_SKIP_RE,
  type CostSource,
  type DeterministicCheck,
  type HarnessConfig,
  type JudgeContext,
  type JudgeTrace,
  type PhaseTimings,
  type RecomputeInput,
  type RecomputeResult,
  type SandboxInfo,
  type Scenario,
  type SwarmTask,
  scenarioWorkerCount,
  scenarioWorkerSpec,
  type TaskSpec,
  type TokenTotals,
  totalTokenCount,
  type WorkerRosterEntry,
  type WorkerSpec,
} from "../types.ts";
import { topoOrder } from "./topo.ts";

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 1; // infra retries per attempt (fresh sandboxes each try)

// ---- sql-dump fixture validation (v6 §1.3 — rules FROZEN) ----

const SQL_DUMP_MAX_BYTES = 5 * 1024 * 1024;
// A full `sqlite3 <db> .dump` always carries the _migrations table WITH applied
// rows. A dump missing them would make the migration bootstrapper re-apply 002+
// onto already-migrated tables at first boot → breakage.
const SQL_DUMP_MIGRATIONS_DDL_RE = /CREATE TABLE\s+(IF NOT EXISTS\s+)?["'`]?_migrations/i;
const SQL_DUMP_MIGRATIONS_ROWS_RE = /INSERT INTO\s+["'`]?_migrations/i;

/** Returns the violation reason, or null when the dump text is acceptable. */
export function validateSqlDumpText(text: string): string | null {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > SQL_DUMP_MAX_BYTES) {
    return `fixture exceeds the 5 MB cap (${bytes} bytes) — fixtures are reference data, not prod DBs`;
  }
  if (!SQL_DUMP_MIGRATIONS_DDL_RE.test(text)) {
    return "dump does not create the _migrations table (use a full `sqlite3 <db> .dump`)";
  }
  if (!SQL_DUMP_MIGRATIONS_ROWS_RE.test(text)) {
    return "dump carries no applied _migrations rows (use a full `sqlite3 <db> .dump`)";
  }
  return null;
}

/**
 * Host-side fixture load + validation — runs BEFORE any sandbox is created, so
 * a bad fixture costs zero E2B time. Resolved relative to the evals package
 * root (import.meta-relative, never process.cwd()).
 */
async function loadSqlDumpFixture(name: string): Promise<{ fixture: string; text: string }> {
  const file = Bun.file(new URL(`../../scenarios/fixtures/${name}`, import.meta.url));
  if (!(await file.exists())) {
    throw new Error(`sql-seed fixture not found: scenarios/fixtures/${name}`);
  }
  const text = await file.text();
  const invalid = validateSqlDumpText(text);
  if (invalid) throw new Error(`sql-seed fixture invalid: ${invalid}`);
  return { fixture: name, text };
}

// ---- infra-failure net (v6 §0.13/§12 — FROZEN) ----

export interface InfraFailureSignature {
  id: string; // stable slug; appears in attempt error messages
  pattern: RegExp; // tested against task.failureReason of terminal "failed" tasks ONLY
  hint: string; // appended to the attempt error message
}

/**
 * Single registry of known-infrastructure task failures. Rules (v6 §12.3):
 * match on failureReason ONLY; patterns must be specific enough to never match
 * a model-caused failure — when in doubt, don't add.
 */
export const INFRA_FAILURE_SIGNATURES: InfraFailureSignature[] = [
  {
    id: "opencode-spawn-timeout",
    pattern: /Spawn failed: Timeout waiting for server/i,
    hint:
      "opencode server failed to start inside the worker sandbox (cold-start flake; " +
      "the root-repo OPENCODE_SERVER_TIMEOUT_MS fix reaches sandboxes only with the " +
      "next release's worker-template publish — this net is the interim + permanent insurance).",
  },
];

export class InfraTaskFailureError extends Error {
  constructor(
    public readonly signatureId: string,
    public readonly taskId: string,
    message: string,
  ) {
    super(message);
    this.name = "InfraTaskFailureError";
  }
}

/**
 * Uniform post-`waitForTask` classification (both creation modes), frozen
 * order (v6 §9.4): 1) infra-signature check — throws InfraTaskFailureError,
 * short-circuiting the whole attempt body (no log/cost waits, no judge spend)
 * and riding the per-attempt retry; 2) cascade-skip classification — a
 * dependent failed by the server's dependency cascade gets `skipped: true`.
 */
export function processTerminalTask<T extends SwarmTask>(
  task: T,
  log: (msg: string) => void = () => {},
): T {
  const reason = String(task.failureReason ?? "");
  if (task.status === "failed") {
    const sig = INFRA_FAILURE_SIGNATURES.find((s) => s.pattern.test(reason));
    if (sig) {
      throw new InfraTaskFailureError(
        sig.id,
        task.id,
        `infra failure (${sig.id}): task ${task.id} failed with "${reason.slice(0, 300)}". ${sig.hint}`,
      );
    }
    if (CASCADE_SKIP_RE.test(reason)) {
      log(`[task] ${task.id} skipped (failed dependency)`);
      return { ...task, skipped: true };
    }
  }
  return task;
}

/**
 * Build the persisted sandboxJson v2 blob (v6 §0.3 — shape FROZEN; v7 §9.3
 * adds the nullable identity + effective-config member fields — the override
 * trio is non-null ONLY when the member overrode the cell config).
 */
export function buildSandboxInfo(stack: StackHandle): SandboxInfo {
  return {
    v: 2,
    apiSandboxId: stack.apiSandbox.sandboxID,
    apiTemplate: stack.apiSandbox.templateID,
    apiUrl: stack.apiUrl,
    swarmKey: stack.swarmKey,
    domain: stack.apiSandbox.domain ?? null,
    apiStartedAt: stack.apiSandbox.startedAt ?? null,
    apiVersion: stack.apiVersion,
    workers: stack.workers.map((w) => ({
      index: w.index,
      sandboxId: w.sandbox.sandboxID,
      template: w.sandbox.templateID,
      agentId: w.agentId,
      startedAt: w.sandbox.startedAt ?? null,
      expiresAt: w.sandbox.endAt ?? w.sandbox.expiresAt ?? null,
      version: w.version,
      name: w.member.spec.name ?? null,
      agentTemplate: w.member.spec.template ?? null,
      role: w.member.role,
      configId: w.member.overridden ? w.member.config.id : null,
      provider: w.member.overridden ? w.member.config.provider : null,
      model: w.member.overridden ? (w.member.config.model ?? null) : null,
    })),
  };
}

// ---- roster members + per-member attribution (v7 §9/§10/§12 — FROZEN) ----

/**
 * Member config resolution (v7 §12.3 — FROZEN):
 *   base   = spec.configId ? catalog[spec.configId] : cellConfig
 *   model  = spec.model ?? base.model     (provider/env/tier from base)
 *   overridden = spec.configId !== undefined || spec.model !== undefined
 */
export function resolveMemberConfig(
  spec: WorkerSpec,
  cellConfig: HarnessConfig,
  catalog: Map<string, HarnessConfig>,
): { config: HarnessConfig; overridden: boolean } {
  const base = spec.configId !== undefined ? catalog.get(spec.configId) : cellConfig;
  if (!base) {
    // Unreachable for registered scenarios (validateScenario gates configId).
    throw new Error(`member configId "${spec.configId}" is not in the config catalog`);
  }
  return {
    config: { ...base, model: spec.model ?? base.model },
    overridden: spec.configId !== undefined || spec.model !== undefined,
  };
}

/**
 * Resolve the scenario's roster against the matrix cell's config: workers at
 * indices 0..N-1 (either `workers` shape), then ONE lead at index N when the
 * scenario defines one (v7 §12.4 — the lead is APPENDED, never shifts worker
 * indices, and does not count toward the worker cap).
 */
export function resolveBootMembers(
  scenario: Scenario,
  cellConfig: HarnessConfig,
  catalog: Map<string, HarnessConfig>,
): BootMember[] {
  const count = scenarioWorkerCount(scenario.workers);
  const members: BootMember[] = [];
  for (let i = 0; i < count; i++) {
    const spec = scenarioWorkerSpec(scenario.workers, i);
    members.push({
      index: i,
      role: "worker",
      spec,
      ...resolveMemberConfig(spec, cellConfig, catalog),
    });
  }
  if (scenario.lead) {
    members.push({
      index: count,
      role: "lead",
      spec: scenario.lead,
      ...resolveMemberConfig(scenario.lead, cellConfig, catalog),
    });
  }
  return members;
}

/**
 * v7 §12.5 (FROZEN): a roster is heterogeneous when any member overrode the
 * cell config, or a lead runs a different provider — those attempts recompute
 * cost/tokens PER MEMBER; homogeneous rosters keep the single-pass path.
 */
export function isHeterogeneousRoster(members: BootMember[], cellConfig: HarnessConfig): boolean {
  return members.some(
    (m) => m.overridden || (m.role === "lead" && m.config.provider !== cellConfig.provider),
  );
}

/**
 * One roster entry per boot member (v7 §10.1 — field sourcing FROZEN).
 * `agents` is the attempt stack's GET /api/agents snapshot; a member with no
 * matching agent row keeps nulls (+ `capabilities: []`, isLead from its boot
 * role). Per-member cost = Σ totalCostUsd over the member's tasks' session-cost
 * rows (null when none priced); tokens = field-wise Σ (null when the rows
 * carry no token data). The Σ of member costs may be less than the attempt's
 * costUsd when recompute priced the attempt — allowed; the UI labels member
 * cost as harness-reported.
 */
export function buildRosterEntries(opts: {
  workers: WorkerHandle[];
  agents: AgentJson[];
  /** taskId → member index, in creation order. */
  taskMemberIndex: Map<string, number>;
  costRows: { taskId: string; rows: SessionCostRow[] }[];
}): WorkerRosterEntry[] {
  return opts.workers.map((w) => {
    const taskIds = [...opts.taskMemberIndex]
      .filter(([, index]) => index === w.index)
      .map(([taskId]) => taskId);
    const idSet = new Set(taskIds);
    const rows = opts.costRows.filter((t) => idSet.has(t.taskId)).flatMap((t) => t.rows);
    const pricedRows = rows.filter((r) => r.totalCostUsd !== null);
    const hasTokenData = rows.some(
      (r) =>
        r.inputTokens !== null ||
        r.outputTokens !== null ||
        r.cacheReadTokens !== null ||
        r.cacheWriteTokens !== null,
    );
    const agent = opts.agents.find((a) => a.id === w.agentId) ?? null;
    return {
      index: w.index,
      memberRole: w.member.role,
      agentId: w.agentId,
      sandboxId: w.sandbox.sandboxID,
      name: agent?.name ?? null,
      role: agent?.role ?? null,
      isLead: agent ? agent.isLead : w.member.role === "lead",
      status: agent?.status ?? null,
      provider: agent?.harnessProvider ?? agent?.provider ?? w.member.config.provider,
      capabilities: agent?.capabilities ?? [],
      maxTasks: agent?.maxTasks ?? null,
      lastActivityAt: agent?.lastActivityAt ?? null,
      agentTemplate: w.member.spec.template ?? null,
      configId: w.member.overridden ? w.member.config.id : null,
      model: w.member.overridden ? (w.member.config.model ?? null) : null,
      version: w.version,
      taskIds,
      costUsd:
        pricedRows.length > 0 ? pricedRows.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0) : null,
      tokens: hasTokenData ? sumRowTokens(rows) : null,
    };
  });
}

// ---- seed.memories readiness gate (v6 §2.3 — FROZEN) ----

const MEMORY_READINESS_TIMEOUT_MS = 90_000;
const MEMORY_READINESS_POLL_MS = 3_000;
const MEMORY_SEED_FAILURE_SUFFIX =
  "memories never became searchable; check EMBEDDING_API_KEY in evals/.env " +
  "(the API sandbox needs an embedding key for memory scenarios)";

/**
 * Embedding is async (the index endpoint 202-queues) — poll memory search
 * until every seeded entry's memoryIds are retrievable. Timeout = attempt
 * error (fail loudly at seed time, not mysteriously at judging time).
 * Returns the readiness wall-clock in ms.
 */
async function awaitSeededMemoriesSearchable(opts: {
  client: SwarmClient;
  /** Worker-0 agent id — the search route hard-requires X-Agent-ID. */
  agentId: string;
  entries: { content: string; memoryIds: string[] }[];
  signal?: AbortSignal;
}): Promise<number> {
  const t0 = Date.now();
  const deadline = t0 + MEMORY_READINESS_TIMEOUT_MS;
  const pending = new Set(opts.entries.map((_, i) => i));
  while (pending.size > 0) {
    opts.signal?.throwIfAborted();
    for (const i of [...pending]) {
      const entry = opts.entries[i] as { content: string; memoryIds: string[] };
      try {
        const res = await opts.client.searchMemory({
          agentId: opts.agentId,
          query: entry.content.slice(0, 120),
          limit: 5,
          scope: "all",
        });
        if (res.results?.some((r) => entry.memoryIds.includes(r.id))) pending.delete(i);
      } catch {
        // transient API blip — keep polling until the deadline
      }
    }
    if (pending.size === 0) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `seed.memories failed: ${pending.size}/${opts.entries.length} seeded memory(ies) not ` +
          `searchable after ${Math.round(MEMORY_READINESS_TIMEOUT_MS / 1000)}s — ${MEMORY_SEED_FAILURE_SUFFIX}`,
      );
    }
    await Bun.sleep(MEMORY_READINESS_POLL_MS);
  }
  return Date.now() - t0;
}

export interface Registry {
  scenarios: Map<string, Scenario>;
  configs: Map<string, HarnessConfig>;
}

/** Live stacks per run, so signal handlers / cancel endpoints can tear them down. */
const activeStacksByRun = new Map<string, Set<StackHandle>>();

function trackStack(runId: string, stack: StackHandle): () => void {
  let set = activeStacksByRun.get(runId);
  if (!set) {
    set = new Set();
    activeStacksByRun.set(runId, set);
  }
  set.add(stack);
  return () => {
    set?.delete(stack);
    if (set && set.size === 0) activeStacksByRun.delete(runId);
  };
}

/** Kill every live stack of one run (used by cancel). */
export async function killRunStacks(runId: string): Promise<void> {
  const stacks = [...(activeStacksByRun.get(runId) ?? [])];
  await Promise.allSettled(stacks.map((s) => s.kill()));
}

/** Kill every live stack of every run (used by SIGINT/SIGTERM handlers). */
export async function killAllActiveStacks(): Promise<void> {
  const runIds = [...activeStacksByRun.keys()];
  await Promise.allSettled(runIds.map((id) => killRunStacks(id)));
}

export function attemptId(
  runId: string,
  scenarioId: string,
  configId: string,
  index: number,
): string {
  return `${runId}_${scenarioId}_${configId}_${index}`;
}

export async function ensureAttemptRows(db: Client, runId: string): Promise<void> {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  for (const scenarioId of run.scenarioIds) {
    for (const configId of run.configIds) {
      for (let i = 0; i < run.attemptsPerCell; i++) {
        await insertAttempt(db, {
          id: attemptId(runId, scenarioId, configId, i),
          runId,
          scenarioId,
          configId,
          attemptIndex: i,
        });
      }
    }
  }
}

function newPhaseTimings(): PhaseTimings {
  return {
    bootMs: null,
    seedMs: null,
    tasksMs: null,
    perTask: [],
    logCaptureMs: null,
    costMs: null,
    checksMs: null,
    llmJudgeMs: null,
    agenticJudgeMs: null,
    artifactsMs: null,
  };
}

/** Stopwatch for one phase: returns elapsed ms alongside the result. */
async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}

/** Aggregate swarm session-cost rows into TokenTotals (model = first non-null). */
function sumRowTokens(rows: SessionCostRow[]): TokenTotals {
  return {
    model: rows.find((r) => r.model)?.model ?? null,
    inputTokens: rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
    cacheReadTokens: rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
    cacheWriteTokens: rows.reduce((s, r) => s + (r.cacheWriteTokens ?? 0), 0),
  };
}

/**
 * v7 §11.1 (FROZEN) attempt cost/token decision, extracted from
 * `runAttemptOnce` so the branch is directly unit-testable (the recompute
 * extractor is injected as a thunk):
 * - harness-priced rows → costUsd = Σ totalCostUsd, costSource "harness",
 *   tokens summed from the rows. Harnesses can post priced rows with NULL
 *   token columns — when that branch yields ZERO tokens, the recompute
 *   extractor runs for TOKENS ONLY; `costUsd` / `costSource = "harness"` are
 *   never touched. Result: every attempt with parseable harness output
 *   carries tokens_json regardless of costSource.
 * - otherwise → full recompute: priced ⇒ "recomputed", else "unpriced"
 *   (tokens, if any, still stored).
 */
export async function resolveAttemptCost(opts: {
  allRows: SessionCostRow[];
  runRecompute: () => Promise<RecomputeResult>;
  log?: (msg: string) => void;
}): Promise<{
  costUsd: number | null;
  costSource: CostSource | null;
  tokens: TokenTotals | null;
  recomputeMs: number;
}> {
  const { allRows, runRecompute, log } = opts;
  const priced = allRows.some(
    (r) => (r.totalCostUsd ?? 0) > 0 || (r.costSource && r.costSource !== "unpriced"),
  );
  let costUsd: number | null = null;
  let costSource: CostSource | null = null;
  let tokens: TokenTotals | null = null;
  let recomputeMs = 0;
  if (allRows.length > 0 && priced) {
    costUsd = allRows.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    costSource = "harness";
    tokens = sumRowTokens(allRows);
    if (totalTokenCount(tokens) === 0) {
      const recompute = await timed(runRecompute);
      recomputeMs += recompute.ms;
      const recomputed = recompute.result.tokens;
      if (recomputed && totalTokenCount(recomputed) > 0) {
        tokens = recomputed;
        log?.("[cost] harness rows carried no tokens — token usage recomputed from session output");
      }
    }
  } else {
    const recompute = await timed(runRecompute);
    recomputeMs += recompute.ms;
    tokens = recompute.result.tokens;
    if (recompute.result.costUsd !== null) {
      costUsd = recompute.result.costUsd;
      costSource = "recomputed";
    } else {
      costSource = "unpriced"; // tokens (if any) still stored
    }
  }
  return { costUsd, costSource, tokens, recomputeMs };
}

/** Sum two nullable USD amounts; null only when BOTH are null. */
function sumNullableCosts(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Field-wise sum of two judge token totals (failed agentic trace + llm
 * fallback). Model = the fallback's, else the failed trace's; null when both
 * are null.
 */
function mergeJudgeTokens(
  failed: TokenTotals | null,
  fallback: TokenTotals | null,
): TokenTotals | null {
  if (!failed && !fallback) return null;
  return {
    model: fallback?.model ?? failed?.model ?? null,
    inputTokens: (failed?.inputTokens ?? 0) + (fallback?.inputTokens ?? 0),
    outputTokens: (failed?.outputTokens ?? 0) + (fallback?.outputTokens ?? 0),
    cacheReadTokens: (failed?.cacheReadTokens ?? 0) + (fallback?.cacheReadTokens ?? 0),
    cacheWriteTokens: (failed?.cacheWriteTokens ?? 0) + (fallback?.cacheWriteTokens ?? 0),
  };
}

const SEED_OUTPUT_CLIP = 20_000;

/**
 * Implicit deterministic check: every scenario task ended `completed`. The
 * failure detail separates real failures from cascade-skipped dependents
 * (v6 §9.4 frozen format: `<n> failed: <titles> · <m> skipped (failed dependency): <titles>`).
 */
function tasksCompletedCheck(tasks: SwarmTask[]): DeterministicCheck {
  const label = (t: SwarmTask): string => {
    const name = t.title || `task ${t.id}`;
    const timedOut = (t as { timedOut?: boolean }).timedOut;
    if (t.status === "failed" && !timedOut) return name;
    return `${name} (${t.status}${timedOut ? ", timed out" : ""})`;
  };
  return {
    name: "tasks-completed",
    fn: async () => {
      const bad = tasks.filter((t) => t.status !== "completed");
      if (bad.length === 0) return { pass: true, detail: `${tasks.length} task(s) completed` };
      const skipped = bad.filter((t) => t.skipped);
      const failed = bad.filter((t) => !t.skipped);
      const parts: string[] = [];
      if (failed.length > 0) {
        parts.push(`${failed.length} failed: ${failed.map(label).join(", ")}`);
      }
      if (skipped.length > 0) {
        parts.push(
          `${skipped.length} skipped (failed dependency): ${skipped.map(label).join(", ")}`,
        );
      }
      return { pass: false, detail: parts.join(" · ") };
    },
  };
}

async function runAttemptOnce(opts: {
  db: Client;
  attempt: AttemptRow;
  scenario: Scenario;
  config: HarnessConfig;
  /** Config catalog — member overrides resolve against it (v7 §12.3). */
  configs: Map<string, HarnessConfig>;
  judgeModel: string | null;
  /** Cancel signal — checked at every phase boundary and inside every polling await. */
  signal?: AbortSignal;
  log: (msg: string) => void;
}): Promise<void> {
  const { db, attempt, scenario, config, signal } = opts;
  // Live progress registry (v4 §2.1): every runner log line + phase transition
  // for this attempt flows through here while it executes; the full capture is
  // persisted as the runner.log artifact in the finally below.
  beginAttemptProgress(attempt.id);
  const log = (msg: string): void => {
    opts.log(msg);
    pushAttemptLog(attempt.id, logLevelFor(msg), msg);
  };
  const startedAt = Date.now();
  const taskTimeoutMs = scenario.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  // Sandbox TTL covers boot + all tasks + judging, with slack for retries inside.
  const timeoutSec = Math.ceil((taskTimeoutMs * scenario.tasks.length + 10 * 60 * 1000) / 1000);

  await updateAttempt(db, attempt.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    error: null,
    // A retry must not keep the previous try's roster (its sandboxes are dead).
    workersJson: null,
  });
  // A re-run of an interrupted attempt must not keep half-written results.
  await clearAttemptResults(db, attempt.id);

  // Host-side sqlDump fixture load + validation BEFORE any sandbox exists —
  // a missing/invalid fixture costs zero E2B time (v6 §1.3).
  const preBootSql = scenario.seed?.sqlDump
    ? await loadSqlDumpFixture(scenario.seed.sqlDump)
    : undefined;

  // Roster resolution (v7 §9.3/§12.3): workers 0..N-1 + optional lead at N,
  // each with its EFFECTIVE config. Resolution is pure — failures (impossible
  // for registered scenarios) throw before any sandbox exists.
  const members = resolveBootMembers(scenario, config, opts.configs);
  const heterogeneous = isHeterogeneousRoster(members, config);

  const timings = newPhaseTimings();
  setAttemptPhase(attempt.id, "boot");
  const boot = await timed(() =>
    bootStack({
      members,
      swarmSlug: `evals-${attempt.runId}`,
      preBootSql,
      timeoutSec,
      signal,
      log: (msg) => log(`[boot] ${msg}`),
    }),
  );
  const stack = boot.result;
  timings.bootMs = boot.ms;
  recordAttemptTimings(attempt.id, timings);
  const untrack = trackStack(attempt.runId, stack);
  // Written at boot so the live run-details page shows sandbox info while the
  // attempt runs. The swarmKey is deliberately stored/exposed — eval sandboxes
  // are throwaway. Always the v2 shape (v6 §0.3); the UI normalizes v1 rows.
  const sandboxInfo = buildSandboxInfo(stack);
  await updateAttempt(db, attempt.id, {
    // The scalar column keeps meaning worker 0's sandboxId.
    sandboxId: stack.workers[0]?.sandbox.sandboxID ?? null,
    apiUrl: stack.apiUrl,
    sandboxJson: JSON.stringify(sandboxInfo),
  });

  try {
    const client = new SwarmClient(stack.apiUrl, stack.swarmKey);
    await Promise.all(stack.workers.map((w) => markAttemptStart(w.sandbox.sandboxID)));

    // Seed-memories record for the artifacts phase (v6 §2.4).
    let seedMemories: { requested: number; memoryIds: string[]; readinessMs: number } | null = null;
    if (scenario.seed?.memories?.length || scenario.seed?.exec?.length) {
      signal?.throwIfAborted();
      setAttemptPhase(attempt.id, "seed");
      const seedT0 = Date.now();
      try {
        // 1. Memories FIRST (v6 §2.2): index all entries, then gate on
        // searchability — both complete before the first createTask, since
        // memory injection happens at task-prompt build time on the server.
        const memories = scenario.seed?.memories ?? [];
        if (memories.length > 0) {
          log(`[seed] indexing ${memories.length} memory(ies)`);
          const entries: { content: string; memoryIds: string[] }[] = [];
          for (let i = 0; i < memories.length; i++) {
            const content = memories[i] as string;
            try {
              const res = await client.indexMemory({
                content,
                name: `seed-memory-${i + 1}`,
                scope: "swarm",
                source: "manual",
                tags: ["eval-seed"],
              });
              entries.push({ content, memoryIds: res.memoryIds ?? [] });
              log(`[seed] seed-memory-${i + 1} queued (${(res.memoryIds ?? []).length} chunk(s))`);
            } catch (err) {
              throw new Error(
                `seed.memories failed: index call for seed-memory-${i + 1} failed ` +
                  `(${err instanceof Error ? err.message : err}) — ${MEMORY_SEED_FAILURE_SUFFIX}`,
              );
            }
          }
          const worker0 = stack.workers[0] as WorkerHandle;
          const readinessMs = await awaitSeededMemoriesSearchable({
            client,
            agentId: worker0.agentId,
            entries,
            signal,
          });
          seedMemories = {
            requested: memories.length,
            memoryIds: entries.flatMap((e) => e.memoryIds),
            readinessMs,
          };
          log(`[seed] memories searchable in ${readinessMs}ms`);
        }

        // 2. Then seed.exec, in WORKER 0's sandbox — exec scripts may want to
        // assert on the seeded environment.
        if (scenario.seed?.exec?.length) {
          const seedOutputs: {
            cmd: string;
            exitCode: number;
            durationMs: number;
            stdout: string;
            stderr: string;
          }[] = [];
          try {
            for (const cmd of scenario.seed.exec) {
              log(`[seed] ${cmd}`);
              const cmdT0 = Date.now();
              const res = await sandboxExec(
                (stack.workers[0] as WorkerHandle).sandbox.sandboxID,
                cmd,
              );
              seedOutputs.push({
                cmd,
                exitCode: res.exitCode,
                durationMs: Date.now() - cmdT0,
                stdout: res.stdout.slice(0, SEED_OUTPUT_CLIP),
                stderr: res.stderr.slice(0, SEED_OUTPUT_CLIP),
              });
              log(`[seed] exit ${res.exitCode} in ${Date.now() - cmdT0}ms`);
              if (res.exitCode !== 0) {
                throw new Error(
                  `seed command failed (${res.exitCode}): ${cmd}\n${res.stderr.slice(0, 500)}`,
                );
              }
            }
          } finally {
            // Written on success AND before a seed-failure throw (retry clears it).
            await insertArtifact(db, {
              id: crypto.randomUUID(),
              attemptId: attempt.id,
              kind: "meta",
              name: "seed-output.json",
              content: stack.redact(JSON.stringify(seedOutputs, null, 2)),
            });
          }
        }
      } finally {
        timings.seedMs = Date.now() - seedT0;
        recordAttemptTimings(attempt.id, timings);
      }
    }

    const tasks: SwarmTask[] = [];
    setAttemptPhase(attempt.id, "tasks");
    const tasksT0 = Date.now();
    // Scenario-local spec index → swarm task UUID. Index-keyed (NOT push-order)
    // so dependsOn resolution survives topo reordering (round 10).
    const swarmIdByIndex: string[] = [];
    // taskId → member index, recorded at creation (v7 §10.1 per-member cost
    // attribution; `worker: "lead"` tasks map to the lead member).
    const taskMemberIndex = new Map<string, number>();

    const workerCount = stack.workers.filter((w) => w.member.role === "worker").length;
    const resolveWorker = (spec: TaskSpec): WorkerHandle => {
      if (spec.worker === "lead") {
        const lead = stack.workers.find((w) => w.member.role === "lead");
        if (!lead) {
          // Unreachable for registered scenarios (validateScenario gates it).
          throw new Error(`task "${spec.title}" targets the lead but this scenario boots none`);
        }
        return lead;
      }
      const index = spec.worker ?? 0;
      const w = stack.workers[index];
      if (!w || w.member.role !== "worker") {
        throw new Error(
          `task "${spec.title}" references worker ${index} but only ${workerCount} booted`,
        );
      }
      return w;
    };
    const createTaskFor = async (specIndex: number): Promise<SwarmTask> => {
      const spec = scenario.tasks[specIndex] as TaskSpec;
      const w = resolveWorker(spec);
      const toLead = spec.worker === "lead";
      // Topo creation order guarantees every dep is already created here.
      const deps = (spec.dependsOn ?? []).map((d) => swarmIdByIndex[d] as string);
      log(
        `[task] creating "${spec.title}" → ${toLead ? "lead" : `worker ${w.index}`} (${w.agentId})` +
          (deps.length > 0 ? ` deps=[${deps.map((d) => d.slice(0, 8)).join(", ")}]` : ""),
      );
      // Worker tasks are ALWAYS directly assigned (an unassigned task on a
      // lead-less stack would rot unclaimed until timeout). Lead tasks are
      // created WITHOUT agentId (v7 §12.2): the swarm API routes agentId-less
      // tasks to the lead — the lead-orchestration entry point.
      const created = await client.createTask({
        task: `${spec.title}\n\n${spec.description}`,
        ...(toLead ? {} : { agentId: w.agentId }),
        ...(deps.length > 0 ? { dependsOn: deps } : {}),
      });
      swarmIdByIndex[specIndex] = created.id;
      taskMemberIndex.set(created.id, w.index);
      return created;
    };
    const awaitTask = async (id: string): Promise<SwarmTask> => {
      const taskT0 = Date.now();
      const final = await client.waitForTask(id, {
        timeoutMs: taskTimeoutMs,
        onStatus: (s) => log(`[task] ${id} -> ${s}`),
        signal,
      });
      timings.perTask.push({ taskId: id, ms: Date.now() - taskT0 });
      recordAttemptTimings(attempt.id, timings);
      // Frozen order (v6 §9.4): infra net first (throws), then skip classification.
      return processTerminalTask(final, log);
    };

    // Unified creation path (round 10): create ALL tasks upfront in topo
    // order (Kahn; lowest scenario index first among ready nodes — identical
    // to authoring order whenever authoring order is already topological,
    // i.e. every registered scenario today). Upfront creation is what lets
    // independent roots land on different members concurrently: the server
    // holds dependents `pending` until their deps complete (checkDependencies)
    // and cascade-fails them when a dep fails/cancels/times out. Await in
    // SCENARIO index order — waitForTask only polls to terminal, so await
    // order never affects execution; forward-ref dependents simply wait
    // (documented v7.7 DAG caveat).
    log(`[task] creating ${scenario.tasks.length} task(s) upfront`);
    const createdByIndex: SwarmTask[] = [];
    for (const specIndex of topoOrder(scenario.tasks)) {
      signal?.throwIfAborted();
      createdByIndex[specIndex] = await createTaskFor(specIndex);
    }
    // Ids are all known upfront — persist them before the long awaits, in
    // SCENARIO AUTHORING order (keeps left-bar rows / sub-tab pills stable).
    await updateAttempt(db, attempt.id, {
      taskIds: createdByIndex.map((created) => created.id),
    });
    for (const created of createdByIndex) {
      signal?.throwIfAborted();
      log(`[task] waiting for ${created.id} (timeout ${Math.round(taskTimeoutMs / 1000)}s)`);
      tasks.push(await awaitTask(created.id));
    }
    timings.tasksMs = Date.now() - tasksT0;
    recordAttemptTimings(attempt.id, timings);
    await updateAttempt(db, attempt.id, { taskIds: tasks.map((t) => t.id) });

    // Skipped tasks never produced a session — exclude them from the log and
    // cost waits (v6 §9.4 frozen); they STAY in tasks/taskIds/tasks.json.
    const activeTasks = tasks.filter((t) => !t.skipped);

    // Gather gradeable outputs (logs lag completion — wait for a stable count).
    signal?.throwIfAborted();
    setAttemptPhase(attempt.id, "log-capture");
    log(`[logs] waiting for stable session logs (${activeTasks.length} task(s))`);
    const logCapture = await timed(async () =>
      (
        await Promise.all(
          activeTasks.map((t) => client.getStableSessionLogs(t.id, undefined, signal)),
        )
      ).flat(),
    );
    let logRows = logCapture.result;
    timings.logCaptureMs = logCapture.ms;
    recordAttemptTimings(attempt.id, timings);
    log(`[logs] captured ${logRows.length} session-log row(s) in ${logCapture.ms}ms`);

    // 1. harness-reported session-cost rows (stability-polled, per-task waits in
    // parallel). claude on an OAuth subscription never posts a priced row (zero
    // rows, or a single cost-0 "unpriced" one) — the stability wait can't change
    // the outcome, so take a single snapshot for the session-costs.json artifact
    // and let the recompute fallback below do its job. Mirrors
    // credentialsForConfig's precedence: OAuth wins when both creds exist.
    signal?.throwIfAborted();
    setAttemptPhase(attempt.id, "cost");
    const oauthSubscription = config.provider === "claude" && !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthSubscription) log("[cost] claude subscription (OAuth) — skipping priced-row wait");
    else log(`[cost] waiting for stable session-cost rows (${activeTasks.length} task(s))`);
    const costWait = timed(() =>
      Promise.all(
        activeTasks.map(async (task) => ({
          taskId: task.id,
          rows: oauthSubscription
            ? await client.getSessionCosts(task.id).catch(() => [] as SessionCostRow[])
            : await client.waitForSessionCostRows(task.id, { signal }),
        })),
      ),
    );

    // Harness session files — captured per worker before judging so cost
    // recompute can reuse them. Runs concurrently with the cost wait: the
    // collection execs the WORKER sandboxes, cost rows come from the API
    // sandbox, and sessionFilesByWorker is first consumed after the join below.
    // Timing attribution stays per-phase (costMs = cost-wait wall, artifactsMs
    // += collection wall), so phases may overlap. Per-worker collection
    // failures stay non-fatal (log + continue).
    let sessionFilesByWorker: ({ index: number } & Awaited<
      ReturnType<typeof collectHarnessSessionFiles>
    >)[] = [];
    const collectWait = timed(async () => {
      const collected: typeof sessionFilesByWorker = [];
      for (const w of stack.workers) {
        try {
          // Per-member provider (v7 §12.5) — a member overriding the cell
          // config writes its session files where ITS harness puts them.
          const result = await collectHarnessSessionFiles(
            w.sandbox.sandboxID,
            w.member.config.provider,
          );
          collected.push({ index: w.index, ...result });
        } catch (err) {
          log(
            `[artifacts] harness session capture failed (worker ${w.index}): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      return collected;
    }).then((collect) => {
      sessionFilesByWorker = collect.result;
      timings.artifactsMs = (timings.artifactsMs ?? 0) + collect.ms;
    });
    const [costCapture] = await Promise.all([costWait, collectWait]);
    const costRowsByTask = costCapture.result;
    const allRows = costRowsByTask.flatMap((t) => t.rows);
    let costMs = costCapture.ms;
    recordAttemptTimings(attempt.id, timings);
    // In-memory union across workers (raw paths) — correct at attempt
    // granularity for the recompute fallback: each task ran on exactly one
    // worker and files are disjoint across sandboxes.
    const sessionFileUnion = sessionFilesByWorker.flatMap((w) => w.files);

    // The cost wait gave late log batches time to flush — re-fetch once and keep
    // the larger set (fixes transcripts losing their tail to the 30s stability cap).
    const refetch = await timed(async () =>
      (
        await Promise.all(activeTasks.map((t) => client.getSessionLogs(t.id).catch(() => [])))
      ).flat(),
    );
    timings.logCaptureMs += refetch.ms;
    recordAttemptTimings(attempt.id, timings);
    if (refetch.result.length > logRows.length) logRows = refetch.result;
    const transcript = flattenTranscript(logRows);

    // 2. recomputed from tokens × models.dev pricing; 3. tagged unpriced.
    // Heterogeneous rosters (v7 §12.5): the extractor runs PER MEMBER — that
    // member's session files + its tasks' log rows, with the member's own
    // provider/configModel — and results merge. Homogeneous rosters keep the
    // single-pass path bit-for-bit.
    const memberTaskIds = (index: number): Set<string> =>
      new Set(
        [...taskMemberIndex].filter(([, member]) => member === index).map(([taskId]) => taskId),
      );
    const runRecompute = () =>
      heterogeneous
        ? recomputeCostMulti(
            stack.workers.map((w): RecomputeInput => {
              const ids = memberTaskIds(w.index);
              return {
                provider: w.member.config.provider,
                configModel: w.member.config.model ?? null,
                logRows: logRows.filter((r) => ids.has(r.taskId)),
                sessionFiles: sessionFilesByWorker.find((f) => f.index === w.index)?.files ?? [],
              };
            }),
          )
        : recomputeCost({
            provider: config.provider,
            configModel: config.model ?? null,
            logRows,
            sessionFiles: sessionFileUnion,
          });
    // v7 §11.1 (FROZEN) decision — extracted to `resolveAttemptCost` for
    // direct unit coverage (see resolve-attempt-cost.test.ts).
    const costOutcome = await resolveAttemptCost({ allRows, runRecompute, log });
    costMs += costOutcome.recomputeMs;
    const { costUsd, costSource, tokens } = costOutcome;

    // Roster + per-member cost snapshot (v7 §10.1): one GET /api/agents call
    // while the stack is still alive, joined with the boot members and each
    // member's tasks' cost rows. Non-fatal — a failed fetch leaves
    // workers_json null and the UI falls back to the sandboxJson workers.
    const rosterTimed = await timed(async (): Promise<WorkerRosterEntry[] | null> => {
      try {
        const agents = await client.listAgents();
        return buildRosterEntries({
          workers: stack.workers,
          agents,
          taskMemberIndex,
          costRows: costRowsByTask,
        });
      } catch (err) {
        log(
          `[roster] agent fetch failed (${err instanceof Error ? err.message : err}) — workers_json stays null`,
        );
        return null;
      }
    });
    costMs += rosterTimed.ms;
    const roster = rosterTimed.result;
    if (roster) {
      await updateAttempt(db, attempt.id, { workersJson: JSON.stringify(roster) });
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "meta",
        name: "roster.json",
        content: stack.redact(JSON.stringify(roster, null, 2)),
      });
      log(`[roster] captured ${roster.length} member(s)`);
    }

    timings.costMs = costMs;
    recordAttemptTimings(attempt.id, timings);
    log(`[cost] source=${costSource}${costUsd !== null ? ` $${costUsd.toFixed(4)}` : ""}`);
    // Raw session-cost rows, always — even when empty.
    await insertArtifact(db, {
      id: crypto.randomUUID(),
      attemptId: attempt.id,
      kind: "meta",
      name: "session-costs.json",
      content: stack.redact(JSON.stringify(costRowsByTask, null, 2)),
    });

    // No judge calls (real LLM spend) may run after a cancel.
    signal?.throwIfAborted();
    await updateAttempt(db, attempt.id, { status: "judging" });
    // Judges stream their (mutable) traces here; the API server reads them for
    // the polled /api/attempts/:id/judge-live endpoint. Cleared in `finally`.
    const judgeLive = beginJudging(attempt.id);
    // Aggregate judge LLM cost (harness overhead) — NEVER added to costUsd.
    let judgeCostUsd: number | null = null;
    const addJudgeCost = (c: number | null): void => {
      if (c !== null) judgeCostUsd = (judgeCostUsd ?? 0) + c;
    };

    // One judge-context entry per booted worker; top-level exec/readFile stay
    // ALIASES of worker 0 (back-compat for existing checks + the agentic judge).
    const ctxWorkers = stack.workers.map((w) => ({
      index: w.index,
      agentId: w.agentId,
      exec: (cmd: string) => sandboxExec(w.sandbox.sandboxID, cmd),
      readFile: (path: string) => sandboxReadFile(w.sandbox.sandboxID, path),
    }));
    const worker0Ctx = ctxWorkers[0] as (typeof ctxWorkers)[number];
    const ctx: JudgeContext = {
      tasks,
      transcript,
      exec: worker0Ctx.exec,
      readFile: worker0Ctx.readFile,
      apiGet: (path) => client.get(path),
      workers: ctxWorkers,
    };

    const checks = [tasksCompletedCheck(tasks), ...(scenario.outcome.checks ?? [])];
    setAttemptPhase(attempt.id, "checks");
    log(`[check] running ${checks.length} deterministic check(s)`);
    const checksTimed = await timed(() => runChecks(checks, ctx, judgeLive));
    const checkResults = checksTimed.result;
    timings.checksMs = checksTimed.ms;
    recordAttemptTimings(attempt.id, timings);
    for (const result of checkResults) {
      await insertJudgment(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "deterministic",
        name: result.name,
        pass: result.pass,
        reasoning: result.detail ?? null,
        durationMs: result.durationMs,
      });
      log(
        `[check] ${result.name}: ${result.pass ? "pass" : "FAIL"}${result.detail ? ` (${result.detail})` : ""}`,
      );
    }
    const checksPass = checkResults.every((r) => r.pass);

    const threshold = scenario.outcome.passThreshold ?? 0.7;
    let llmPass = true;
    let score: number | null = null;

    if (scenario.outcome.llmJudge) {
      const spec = scenario.outcome.llmJudge;
      signal?.throwIfAborted();
      setAttemptPhase(attempt.id, "llm-judge");
      log(`[judge] llm judge starting (model ${spec.model ?? opts.judgeModel ?? "default"})`);
      const llmTimed = await timed(() =>
        judgeWithLlm({
          scenario,
          rubric: spec.rubric,
          tasks,
          transcript,
          model: spec.model ?? opts.judgeModel ?? undefined,
          live: judgeLive,
        }),
      );
      const verdict = llmTimed.result;
      timings.llmJudgeMs = llmTimed.ms;
      recordAttemptTimings(attempt.id, timings);
      score = verdict.score;
      llmPass = verdict.pass && verdict.score >= threshold;
      await insertJudgment(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "llm",
        name: "llm-judge",
        pass: llmPass,
        score: verdict.score,
        reasoning: verdict.reasoning,
        raw: verdict.raw,
        durationMs: verdict.trace.durationMs ?? llmTimed.ms,
        costUsd: verdict.trace.costUsd,
        tokensJson: verdict.trace.tokens ? JSON.stringify(verdict.trace.tokens) : null,
        stepsJson: JSON.stringify(verdict.trace.steps),
      });
      addJudgeCost(verdict.trace.costUsd);
      log(`[judge] llm score=${verdict.score.toFixed(2)} pass=${llmPass}`);
    }

    let agenticPass = true;
    if (scenario.outcome.agenticJudge) {
      const spec = scenario.outcome.agenticJudge;
      signal?.throwIfAborted();
      setAttemptPhase(attempt.id, "agentic-judge");
      log(
        `[judge] agentic judge starting (model ${spec.model ?? opts.judgeModel ?? "default"}` +
          `${spec.maxSteps ? `, maxSteps ${spec.maxSteps}` : ""})`,
      );
      const agenticT0 = Date.now();
      let verdict: Awaited<ReturnType<typeof judgeAgentic>>;
      let judgeName = "agentic-judge";
      // Kept on AgenticJudgeError so the failed loop's steps/cost are never lost.
      let failedTrace: JudgeTrace | null = null;
      try {
        verdict = await judgeAgentic({
          scenario,
          rubric: spec.rubric,
          tasks,
          transcript,
          ctx,
          model: spec.model ?? opts.judgeModel ?? undefined,
          maxSteps: spec.maxSteps,
          live: judgeLive,
        });
      } catch (err) {
        // Cancel mid-agentic-judge kills the sandbox, which makes the judge's
        // exec tools fail — don't start a fresh LLM judge call post-abort
        // (frozen contract: no judge calls run after the abort).
        signal?.throwIfAborted();
        // Agent never submitted a verdict (or judge-model flake) — fall back to
        // the plain LLM judge rather than burning the whole attempt.
        log(
          `[judge] agentic judge failed (${err instanceof Error ? err.message : err}); falling back to llm judge`,
        );
        failedTrace = err instanceof AgenticJudgeError ? err.trace : null;
        judgeName = "agentic-judge (llm fallback)";
        verdict = await judgeWithLlm({
          scenario,
          rubric: spec.rubric,
          tasks,
          transcript,
          model: spec.model ?? opts.judgeModel ?? undefined,
          live: judgeLive,
        });
      }
      timings.agenticJudgeMs = Date.now() - agenticT0;
      recordAttemptTimings(attempt.id, timings);
      agenticPass = verdict.pass && verdict.score >= threshold;
      // Agentic verdicts verify against the live sandbox, so they take score precedence.
      score = verdict.score;
      // Fallback path: merge the failed agentic trace with the fallback's —
      // the failed loop's spend is real and MUST be counted.
      const steps = failedTrace
        ? [...failedTrace.steps, ...verdict.trace.steps].map((s, i) => ({ ...s, index: i }))
        : verdict.trace.steps;
      const judgmentCost = failedTrace
        ? sumNullableCosts(failedTrace.costUsd, verdict.trace.costUsd)
        : verdict.trace.costUsd;
      const judgmentTokens = failedTrace
        ? mergeJudgeTokens(failedTrace.tokens, verdict.trace.tokens)
        : verdict.trace.tokens;
      await insertJudgment(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "llm",
        name: judgeName,
        pass: agenticPass,
        score: verdict.score,
        reasoning: verdict.reasoning,
        raw: verdict.raw,
        durationMs: failedTrace
          ? timings.agenticJudgeMs
          : (verdict.trace.durationMs ?? timings.agenticJudgeMs),
        costUsd: judgmentCost,
        tokensJson: judgmentTokens ? JSON.stringify(judgmentTokens) : null,
        stepsJson: JSON.stringify(steps),
      });
      addJudgeCost(judgmentCost);
      log(`[judge] agentic score=${verdict.score.toFixed(2)} pass=${agenticPass}`);
    }

    // Live view flips judging → false; traces stay readable until clearJudging.
    endJudging(attempt.id);

    const passed = checksPass && llmPass && agenticPass;
    if (score === null) score = passed ? 1 : 0;

    // Persist artifacts (redacted) before the sandboxes die.
    signal?.throwIfAborted();
    setAttemptPhase(attempt.id, "artifacts");
    log("[artifacts] persisting transcript, session files, tasks, and sandbox logs");
    const artifactsT0 = Date.now();
    await insertArtifact(db, {
      id: crypto.randomUUID(),
      attemptId: attempt.id,
      kind: "transcript",
      content: stack.redact(transcript).slice(0, 400_000),
    });
    // Raw swarm session-log events, one JSON object per line (id/createdAt kept
    // so the transcript viewer can order + coalesce without hitting the dead stack).
    if (logRows.length > 0) {
      const jsonl = logRows
        .map((r) =>
          JSON.stringify({
            id: r.id,
            taskId: r.taskId,
            sessionId: r.sessionId,
            iteration: r.iteration,
            lineNumber: r.lineNumber,
            cli: r.cli,
            content: r.content,
            createdAt: r.createdAt,
          }),
        )
        .join("\n");
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "raw-session-logs",
        name: "session-logs.jsonl",
        content: stack.redact(jsonl).slice(0, 2_000_000),
      });
    }
    // The harness's own raw session files (collected pre-judging above),
    // namespaced per worker (v6 §0.5: `worker-<i>/<absolute path>`).
    for (const workerFiles of sessionFilesByWorker) {
      for (const file of workerFiles.files) {
        await insertArtifact(db, {
          id: crypto.randomUUID(),
          attemptId: attempt.id,
          kind: "harness-session",
          name: `worker-${workerFiles.index}/${file.path.replace(/^\//, "")}${file.truncated ? " (truncated)" : ""}`,
          content: stack.redact(file.content),
        });
      }
      if (workerFiles.listing.length > 0) {
        await insertArtifact(db, {
          id: crypto.randomUUID(),
          attemptId: attempt.id,
          kind: "meta",
          name: `worker-${workerFiles.index}/session-files.json`,
          content: stack.redact(JSON.stringify(workerFiles.listing, null, 2)),
        });
      }
    }
    if (sessionFileUnion.length > 0) {
      log(`[artifacts] captured ${sessionFileUnion.length} harness session file(s)`);
    }
    // SQL-seed import record (v6 §1.3) — only when the scenario seeded a dump.
    if (stack.sqlSeed) {
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "meta",
        name: "sql-seed-output.json",
        content: stack.redact(JSON.stringify(stack.sqlSeed, null, 2)),
      });
    }
    // Memory-seed record (v6 §2.4) — only when memories were seeded.
    if (seedMemories) {
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "meta",
        name: "seed-memories.json",
        content: stack.redact(JSON.stringify(seedMemories, null, 2)),
      });
    }
    await insertArtifact(db, {
      id: crypto.randomUUID(),
      attemptId: attempt.id,
      kind: "task",
      name: "tasks.json",
      content: stack.redact(JSON.stringify(tasks, null, 2)),
    });
    // Entrypoint logs: one artifact per worker — ALWAYS indexed naming, even
    // for a single worker (v6 §0.5; legacy rows keep `worker.log` → worker 0).
    for (const w of stack.workers) {
      const workerLog = await sandboxExec(
        w.sandbox.sandboxID,
        "tail -n 2000 /tmp/agent-swarm-e2b-worker.log",
      ).catch(() => null);
      if (workerLog?.stdout) {
        await insertArtifact(db, {
          id: crypto.randomUUID(),
          attemptId: attempt.id,
          kind: "sandbox-log",
          name: `worker-${w.index}.log`,
          content: stack.redact(workerLog.stdout),
        });
      }
    }
    const apiLog = await sandboxExec(
      stack.apiSandbox.sandboxID,
      "tail -n 500 /tmp/agent-swarm-e2b-api.log",
    ).catch(() => null);
    if (apiLog?.stdout) {
      await insertArtifact(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "sandbox-log",
        name: "api.log",
        content: stack.redact(apiLog.stdout),
      });
    }
    timings.artifactsMs = (timings.artifactsMs ?? 0) + (Date.now() - artifactsT0);
    recordAttemptTimings(attempt.id, timings);
    setAttemptPhase(attempt.id, null);

    await updateAttempt(db, attempt.id, {
      status: passed ? "passed" : "failed",
      passed,
      score,
      costUsd,
      costSource,
      judgeCostUsd,
      tokensJson: tokens ? JSON.stringify(tokens) : null,
      timingsJson: JSON.stringify(timings),
      durationMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
    });
    log(
      `[done] ${passed ? "PASSED" : "FAILED"} score=${score.toFixed(2)}${costUsd !== null ? ` cost=$${costUsd.toFixed(4)}` : ""}`,
    );
  } finally {
    // After final persistence on success, and on every error path — the live
    // registry never leaks. Retries re-enter via beginJudging (resets entry).
    clearJudging(attempt.id);
    // Persist the full captured runner log as an artifact (v4 §2.2). Best-effort:
    // a DB hiccup here must not mask the attempt's own error or skip teardown.
    // `clearAttemptResults` wipes it on retry — each try gets a fresh runner.log.
    try {
      const progressLog = finishAttemptProgress(attempt.id);
      if (progressLog.length > 0) {
        await insertArtifact(db, {
          id: crypto.randomUUID(),
          attemptId: attempt.id,
          kind: "log",
          name: "runner.log",
          content: stack.redact(formatRunnerLog(progressLog)),
        });
      }
    } catch (err) {
      opts.log(
        `[artifacts] runner.log persist failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    untrack();
    await stack.kill();
  }
}

async function runAttemptWithRetry(opts: {
  db: Client;
  attempt: AttemptRow;
  registry: Registry;
  maxRetries: number;
  judgeModel: string | null;
  signal?: AbortSignal;
  log: (msg: string) => void;
}): Promise<void> {
  const { db, attempt, registry } = opts;
  // Own lines ([error]/[retry]) also flow into the live registry — pushAttemptLog
  // no-ops once runAttemptOnce's finally has already cleared the entry.
  const log = (msg: string): void => {
    opts.log(msg);
    pushAttemptLog(attempt.id, logLevelFor(msg), msg);
  };
  const scenario = registry.scenarios.get(attempt.scenarioId);
  const config = registry.configs.get(attempt.configId);
  if (!scenario || !config) {
    await updateAttempt(db, attempt.id, {
      status: "error",
      error: `unknown ${!scenario ? `scenario ${attempt.scenarioId}` : `config ${attempt.configId}`}`,
      finishedAt: new Date().toISOString(),
    });
    return;
  }
  for (let retry = attempt.retries; ; retry++) {
    try {
      await runAttemptOnce({
        db,
        attempt,
        scenario,
        config,
        configs: registry.configs,
        judgeModel: opts.judgeModel,
        signal: opts.signal,
        // Raw log — runAttemptOnce wraps it once for the live registry itself.
        log: opts.log,
      });
      return;
    } catch (err) {
      // Infra-net errors persist the frozen §0.13 message verbatim (it must
      // START with "infra failure (<signatureId>)"); everything else keeps the
      // stack for debuggability.
      const message =
        err instanceof InfraTaskFailureError
          ? err.message
          : err instanceof Error
            ? (err.stack ?? err.message)
            : String(err);
      log(`[error] ${message.split("\n")[0]}`);
      // Leak guard: boot failures throw before runAttemptOnce's inner finally can
      // run, so the progress entry may still be live. Idempotent — [] once cleared.
      const orphanedLog = finishAttemptProgress(attempt.id);
      if (opts.signal?.aborted) {
        // Cancelled mid-attempt — leave it pending so resume re-runs it cleanly.
        await updateAttempt(db, attempt.id, { status: "pending", retries: retry });
        return;
      }
      if (retry >= opts.maxRetries) {
        if (orphanedLog.length > 0) {
          // Terminal error before the stack existed (no redact available — the
          // boot log carries no secrets beyond throwaway sandbox ids). Best-effort.
          try {
            await insertArtifact(db, {
              id: crypto.randomUUID(),
              attemptId: attempt.id,
              kind: "log",
              name: "runner.log",
              content: formatRunnerLog(orphanedLog),
            });
          } catch {
            // never mask the terminal error below
          }
        }
        await updateAttempt(db, attempt.id, {
          status: "error",
          retries: retry,
          error: message.slice(0, 4000),
          finishedAt: new Date().toISOString(),
        });
        return;
      }
      await updateAttempt(db, attempt.id, { retries: retry + 1, error: message.slice(0, 4000) });
      log(`[retry] attempt ${attempt.id} retrying (${retry + 1}/${opts.maxRetries})`);
    }
  }
}

async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      if (shouldStop?.()) return;
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Execute (or resume) an eval run: every unfinished attempt in the
 * scenarios x configs x attemptsPerCell matrix, with safe retry. Attempts that
 * already reached a terminal state are skipped, so re-invoking after a crash
 * or Ctrl-C continues where it left off.
 */
export async function executeRun(opts: {
  db: Client;
  runId: string;
  registry: Registry;
  maxRetries?: number;
  /** Abort starting new attempts (cancel / Ctrl-C). In-flight stacks are killed by the caller. */
  signal?: AbortSignal;
  log?: (msg: string) => void;
}): Promise<void> {
  const { db, runId, registry, signal } = opts;
  const baseLog = opts.log ?? ((msg: string) => console.log(msg));
  const run = await getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);

  await ensureAttemptRows(db, runId);
  await setRunStatus(db, runId, "running");

  // A previous execution may have died mid-attempt and leaked its sandboxes.
  const swept = await sweepRunSandboxes(runId, baseLog);
  if (swept > 0) baseLog(`swept ${swept} leaked sandbox(es) from a previous execution`);

  const unfinished = await listUnfinishedAttempts(db, runId);
  baseLog(
    `run ${runId}: ${unfinished.length} attempt(s) to execute (concurrency ${run.concurrency})`,
  );

  await pool(
    unfinished,
    run.concurrency,
    (attempt) =>
      runAttemptWithRetry({
        db,
        attempt,
        registry,
        maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
        judgeModel: run.judgeModel,
        signal,
        log: (msg) =>
          baseLog(`[${attempt.scenarioId} × ${attempt.configId} #${attempt.attemptIndex}] ${msg}`),
      }),
    () => signal?.aborted ?? false,
  );

  if (signal?.aborted) {
    await setRunStatus(db, runId, "cancelled");
    baseLog(`run ${runId} cancelled — unfinished attempts stay pending; resume to continue`);
    return;
  }
  const attempts = await listAttempts(db, runId);
  const allErrored = attempts.length > 0 && attempts.every((a) => a.status === "error");
  await setRunStatus(db, runId, allErrored ? "failed" : "done");
  baseLog(
    `run ${runId} finished: ${attempts.filter((a) => a.status === "passed").length}/${attempts.length} attempts passed`,
  );
}
