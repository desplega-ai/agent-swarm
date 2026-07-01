import type { Client } from "@libsql/client";
import { recomputeCost, recomputeCostMulti } from "../cost/recompute.ts";
import {
  clearAttemptResults,
  getRun,
  insertArtifact,
  insertAttempt,
  insertJudgment,
  listAttempts,
  listRuns,
  listUnfinishedAttempts,
  setRunStatus,
  updateAttempt,
} from "../db/queries.ts";
import { AgenticJudgeError, judgeAgentic } from "../judge/agentic.ts";
import { runChecks } from "../judge/deterministic.ts";
import {
  beginJudging,
  clearJudging,
  endJudging,
  type JudgeLiveHandle,
} from "../judge/live-registry.ts";
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
import { normalizeOutcome } from "../normalize-outcome.ts";
import { dimensionScoreFromChecks, efficiencyScore, finalizeScore } from "../scoring.ts";
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
  type NormalizedDimension,
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

// ---- sql-seed fixture validation (INSERT-only convention) ----
//
// Fixtures are INSERT-only seeds: just the reference rows, NO schema and NO
// `_migrations`. The schema is built PRE-BOOT from the REAL migrations in the
// API image (see bootStack in swarm/sandbox.ts), so a fixture must NOT carry
// `CREATE TABLE`/`_migrations` (that would be a stale full-dump — exactly the
// drift this convention removes). The seed lands AFTER migrations build the
// schema, so it must contain at least one INSERT, and it must not seed live
// operational state (see scenarios/fixtures/README.md).

const SQL_DUMP_MAX_BYTES = 5 * 1024 * 1024;
/** Any INSERT — an INSERT-only seed must carry at least one row. */
const SQL_SEED_INSERT_RE = /INSERT\s+INTO/i;
/** A full `.dump` carries DDL; an INSERT-only seed must not. */
const SQL_SEED_CREATE_TABLE_RE = /CREATE\s+TABLE/i;
/** The `_migrations` bookkeeping is owned by the pre-boot migrate step, never the seed. */
const SQL_SEED_MIGRATIONS_RE = /\b_migrations\b/i;
/**
 * Forbidden live-operational tables/state (README rules):
 *  - `agents` — workers self-register at boot; a seeded row would be reused;
 *  - in-flight (`pending`/`running`) tasks — the booting worker would claim them;
 *  - `agent_memory` — embeddings live in a sqlite-vec virtual table; use
 *    `scenario.seed.memories` instead.
 */
const SQL_SEED_AGENTS_RE = /INSERT\s+INTO\s+["'`]?agents\b/i;
const SQL_SEED_AGENT_MEMORY_RE = /INSERT\s+INTO\s+["'`]?agent_memory\b/i;
const SQL_SEED_INFLIGHT_STATUS_RE = /['"](pending|running)['"]/i;

/** Returns the violation reason, or null when the seed text is acceptable. */
export function validateSqlDumpText(text: string): string | null {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > SQL_DUMP_MAX_BYTES) {
    return `fixture exceeds the 5 MB cap (${bytes} bytes) — fixtures are reference data, not prod DBs`;
  }
  if (SQL_SEED_CREATE_TABLE_RE.test(text)) {
    return "fixture contains CREATE TABLE — seeds are INSERT-only; the schema is built from the real migrations pre-boot (do not ship a full `.dump`)";
  }
  if (SQL_SEED_MIGRATIONS_RE.test(text)) {
    return "fixture references `_migrations` — seeds are INSERT-only; the `_migrations` bookkeeping is written by the pre-boot migrate step (do not ship a full `.dump`)";
  }
  if (!SQL_SEED_INSERT_RE.test(text)) {
    return "fixture carries no INSERT rows — an INSERT-only seed must seed at least one reference row";
  }
  if (SQL_SEED_AGENTS_RE.test(text)) {
    return "fixture seeds `agents` rows — forbidden (workers self-register at boot; a colliding id would be silently reused)";
  }
  if (SQL_SEED_AGENT_MEMORY_RE.test(text)) {
    return "fixture seeds `agent_memory` rows — forbidden (embeddings are not portable; use `scenario.seed.memories` instead)";
  }
  if (SQL_SEED_INFLIGHT_STATUS_RE.test(text)) {
    return "fixture seeds an in-flight ('pending'/'running') status — forbidden (the booting worker would claim the row); seed only terminal rows";
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
 * A genuine judge model/infra failure (v8.0 §3.5) — raised by the dimension
 * scoring loop when a judge call (and, for agentic judges, its llm fallback)
 * throws for a reason that is NOT a cancel. `runAttemptWithRetry` maps it to
 * attempt status `error` (excluded from analytics) so a judge flake never
 * masquerades as a 0-score config failure. A graded *check* that throws stays
 * score 0 (that's the config's broken sandbox, not a judge fault); only a
 * judge-side throw becomes `error`. Cancel (`signal.throwIfAborted()`) stays
 * ahead of this so a cancelled attempt is left resumable/`pending`, never
 * `error`.
 */
export class JudgeInfraError extends Error {
  constructor(
    public readonly dimension: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JudgeInfraError";
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
 * Classify a task as run-vs-seed for the run-details artifact (display-only —
 * scoring NEVER consults this). A scenario may seed reference-data tasks into the
 * same swarm DB the run uses (e.g. delegation-probe's 20 audit-history rows); they
 * pollute the run-details Tasks panel as if they were run activity.
 *
 * A task is a RUN task iff ANY of:
 *   - its id is one of the scenario's upfront task ids (`upfrontTaskIds`), OR
 *   - its `creatorAgentId` is one of the run's agent ids (lead + workers), OR
 *   - its `agentId` is one of the run's agent ids.
 * Everything else — the pre-existing fixture history, created BEFORE the run's
 * agents existed and assigned to no run agent — is a SEED task. Defensive: the
 * delegation fields ride the SwarmTask index signature and may be absent/non-string.
 */
export function classifyTaskOrigin(
  task: SwarmTask,
  upfrontTaskIds: ReadonlySet<string>,
  runAgentIds: ReadonlySet<string>,
): "run" | "seed" {
  if (typeof task.id === "string" && upfrontTaskIds.has(task.id)) return "run";
  const creatorAgentId = task.creatorAgentId;
  if (typeof creatorAgentId === "string" && runAgentIds.has(creatorAgentId)) return "run";
  const agentId = task.agentId ?? task.assignedAgentId;
  if (typeof agentId === "string" && runAgentIds.has(agentId)) return "run";
  return "seed";
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

type RunSandboxSweeper = typeof sweepRunSandboxes;
type RunnerLog = (msg: string) => void;

/**
 * A fresh server process has an empty active-runs map. Any DB row still marked
 * running at boot is therefore orphaned by a previous process and must not stay
 * permanently un-cancellable.
 */
export async function reconcileOrphanedRuns(
  db: Client,
  log: RunnerLog = (msg) => console.log(msg),
  sweep: RunSandboxSweeper = sweepRunSandboxes,
): Promise<number> {
  const orphanedRuns = (await listRuns(db)).filter((run) => run.status === "running");
  for (const run of orphanedRuns) {
    const swept = await sweep(run.id, log);
    await setRunStatus(db, run.id, "failed");
    log(
      `run ${run.id} was left "running" by a previous process (orphaned) - swept ${swept} sandbox(es), marked failed. POST /api/runs/${run.id}/resume to continue it.`,
    );
  }
  return orphanedRuns.length;
}

export async function forceCancelInactiveRun(
  db: Client,
  runId: string,
  log: RunnerLog = (msg) => console.log(msg),
  sweep: RunSandboxSweeper = sweepRunSandboxes,
): Promise<number> {
  const swept = await sweep(runId, log);
  await setRunStatus(db, runId, "cancelled");
  return swept;
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

/**
 * Score ONE normalized dimension (v8.0 §3.3) and persist exactly one judgment
 * row carrying `dimension`/`weight`. Returns the dimension's 0-1 sub-score.
 *
 * - graded checks: `runChecks(dim.checks, ctx, judgeLive)` (threads the live
 *   trace); per-check value = `res.score ?? (res.pass ? 1 : 0)`; sub-score =
 *   weighted mean over member checks (per-check `weight ?? 1`). A check that
 *   THROWS yields {pass:false} → value 0 (counts against the config). Row:
 *   kind 'deterministic', name/dimension = dim.name, durationMs = Σ member
 *   durations, score = subScore, pass = subScore >= 1.
 * - judge: `judgeAgentic` (per `dim.judge.agentic`) with the agentic→llm
 *   fallback, else `judgeWithLlm`. A genuine judge model/infra throw (NOT a
 *   cancel — `signal.throwIfAborted()` stays ahead of the fallback) becomes a
 *   typed {@link JudgeInfraError} so the attempt is marked `error`. Row: kind
 *   'llm', name/dimension = dim.name, score = verdict.score, pass = score >= 1,
 *   carrying steps/cost/tokens.
 */
export async function scoreDimension(opts: {
  db: Client;
  attempt: AttemptRow;
  scenario: Scenario;
  dim: NormalizedDimension;
  ctx: JudgeContext;
  judgeLive: JudgeLiveHandle;
  judgeModel: string | null;
  timings: PhaseTimings;
  addJudgeCost: (c: number | null) => void;
  signal?: AbortSignal;
  log: (msg: string) => void;
}): Promise<number> {
  const { db, attempt, scenario, dim, ctx, judgeLive, timings, signal, log } = opts;

  // ---- graded checks ----
  if (dim.checks && dim.checks.length > 0) {
    setAttemptPhase(attempt.id, "checks");
    log(`[dimension] ${dim.name}: running ${dim.checks.length} graded check(s)`);
    const dimTimed = await timed(() => runChecks(dim.checks ?? [], ctx, judgeLive));
    const results = dimTimed.result;
    timings.checksMs = (timings.checksMs ?? 0) + dimTimed.ms;
    recordAttemptTimings(attempt.id, timings);
    const values = results.map((res, i) => ({
      value: res.score ?? (res.pass ? 1 : 0),
      // A graded check that THROWS → {pass:false} → value 0 (config's fault).
      weight: dim.checks?.[i]?.weight ?? 1,
    }));
    const subScore = dimensionScoreFromChecks(values);
    const durationMs = results.reduce((s, r) => s + r.durationMs, 0);
    const detail = results
      .map((r) => `${r.name}=${(r.score ?? (r.pass ? 1 : 0)).toFixed(2)}`)
      .join(", ");
    await insertJudgment(db, {
      id: crypto.randomUUID(),
      attemptId: attempt.id,
      kind: "deterministic",
      name: dim.name,
      pass: subScore >= 1,
      score: subScore,
      reasoning: detail || null,
      durationMs,
      dimension: dim.name,
      weight: dim.weight,
    });
    log(`[dimension] ${dim.name}: score=${subScore.toFixed(2)} (graded checks)`);
    return subScore;
  }

  // ---- judge ----
  const judge = dim.judge;
  if (!judge) {
    // Normalizer guarantees a dimension has checks or a judge; defensively a
    // source-less dimension contributes 0 rather than crashing.
    log(`[dimension] ${dim.name}: no checks/judge — sub-score 0`);
    await insertJudgment(db, {
      id: crypto.randomUUID(),
      attemptId: attempt.id,
      kind: "deterministic",
      name: dim.name,
      pass: false,
      score: 0,
      reasoning: "dimension has no checks or judge",
      durationMs: 0,
      dimension: dim.name,
      weight: dim.weight,
    });
    return 0;
  }

  const model = judge.model ?? opts.judgeModel ?? undefined;
  const phase = judge.agentic ? "agentic-judge" : "llm-judge";
  signal?.throwIfAborted();
  setAttemptPhase(attempt.id, phase);
  log(
    `[dimension] ${dim.name}: ${judge.agentic ? "agentic" : "llm"} judge starting ` +
      `(model ${judge.model ?? opts.judgeModel ?? "default"}` +
      `${judge.agentic && judge.maxSteps ? `, maxSteps ${judge.maxSteps}` : ""})`,
  );
  const judgeT0 = Date.now();
  let verdict: Awaited<ReturnType<typeof judgeWithLlm>>;
  let judgeName = dim.name;
  // Kept on AgenticJudgeError so the failed loop's steps/cost are never lost.
  let failedTrace: JudgeTrace | null = null;
  try {
    if (judge.agentic) {
      try {
        verdict = await judgeAgentic({
          scenario,
          rubric: judge.rubric,
          tasks: ctx.tasks,
          transcript: ctx.transcript,
          ctx,
          model,
          maxSteps: judge.maxSteps,
          live: judgeLive,
        });
      } catch (err) {
        // Cancel mid-agentic-judge kills the sandbox, making the judge tools
        // fail — never start a fresh LLM call post-abort (frozen contract).
        signal?.throwIfAborted();
        log(
          `[dimension] ${dim.name}: agentic judge failed (${err instanceof Error ? err.message : err}); falling back to llm judge`,
        );
        failedTrace = err instanceof AgenticJudgeError ? err.trace : null;
        judgeName = `${dim.name} (llm fallback)`;
        verdict = await judgeWithLlm({
          scenario,
          rubric: judge.rubric,
          tasks: ctx.tasks,
          transcript: ctx.transcript,
          workers: ctx.workers,
          model,
          live: judgeLive,
        });
      }
    } else {
      verdict = await judgeWithLlm({
        scenario,
        rubric: judge.rubric,
        tasks: ctx.tasks,
        transcript: ctx.transcript,
        workers: ctx.workers,
        model,
        live: judgeLive,
      });
    }
  } catch (err) {
    // A cancel is re-thrown verbatim (handled by runAttemptWithRetry → pending).
    signal?.throwIfAborted();
    // Anything else here (llm-judge throw, or the agentic fallback's llm throw)
    // is a genuine judge model/infra flake — surface it typed so the attempt is
    // marked `error`, never a 0-score config failure.
    const message = err instanceof Error ? err.message : String(err);
    throw new JudgeInfraError(
      dim.name,
      `judge infra failure on dimension "${dim.name}": ${message}`,
      { cause: err },
    );
  }
  const judgeMs = Date.now() - judgeT0;
  if (judge.agentic) timings.agenticJudgeMs = (timings.agenticJudgeMs ?? 0) + judgeMs;
  else timings.llmJudgeMs = (timings.llmJudgeMs ?? 0) + judgeMs;
  recordAttemptTimings(attempt.id, timings);

  const subScore = verdict.score;
  // Fallback path: merge the failed agentic trace with the fallback's — the
  // failed loop's spend is real and MUST be counted.
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
    pass: subScore >= 1,
    score: subScore,
    reasoning: verdict.reasoning,
    raw: verdict.raw,
    durationMs: failedTrace ? judgeMs : (verdict.trace.durationMs ?? judgeMs),
    costUsd: judgmentCost,
    tokensJson: judgmentTokens ? JSON.stringify(judgmentTokens) : null,
    stepsJson: JSON.stringify(steps),
    dimension: dim.name,
    weight: dim.weight,
  });
  opts.addJudgeCost(judgmentCost);
  log(`[dimension] ${dim.name}: score=${subScore.toFixed(2)} (judge)`);
  return subScore;
}

/**
 * True for the DETERMINISTIC efficiency dimension (v8.0 §5): a dimension named
 * `efficiency` with no graded checks and no judge. Such a dimension is scored by
 * the runner from the attempt's REAL cost/duration vs the scenario budget — not
 * by a check or judge. A scenario that DOES attach checks/judge to a dimension
 * named `efficiency` keeps the normal graded/judged path (this returns false).
 */
function isDeterministicEfficiencyDimension(dim: NormalizedDimension): boolean {
  return dim.name === "efficiency" && (dim.checks?.length ?? 0) === 0 && dim.judge === undefined;
}

/**
 * Score the deterministic `efficiency` dimension (v8.0 §5) from the attempt's
 * REAL cost/duration against the scenario budget — never self-reported.
 *
 * - cost: scored only when `scenario.budgetUsd` is set AND `costUsd` is non-null
 *   (priced). An UNPRICED attempt (`costUsd === null`) DROPS the cost sub-score
 *   — a missing price is not a model failure (Open Question 6).
 * - time: scored only when `scenario.budgetMs` is set.
 * - when BOTH sub-scores are available, the dimension sub-score is the MIN of the
 *   two (worst-case discipline).
 *
 * Returns `null` when NO sub-score is available (no time budget AND unpriced, or
 * no budgets at all). The caller treats `null` as "drop this dimension from the
 * weighted average" → the divisor re-normalizes over the REMAINING weights, so
 * the dimension is never silently scored 0. When `null`, NO judgment row is
 * written (there is nothing to grade).
 */
async function efficiencyDimensionScore(opts: {
  db: Client;
  attempt: AttemptRow;
  scenario: Scenario;
  dim: NormalizedDimension;
  costUsd: number | null;
  durationMs: number;
  log: (msg: string) => void;
}): Promise<number | null> {
  const { db, attempt, scenario, dim, costUsd, durationMs, log } = opts;
  const parts: string[] = [];
  const subScores: number[] = [];

  if (scenario.budgetUsd !== undefined) {
    if (costUsd === null) {
      // Unpriced — a missing price is not a model failure; drop the cost term.
      parts.push("cost=unpriced(skip)");
    } else {
      const costScore = efficiencyScore(costUsd, scenario.budgetUsd);
      subScores.push(costScore);
      parts.push(`cost=${costScore.toFixed(2)} ($${costUsd.toFixed(4)}/$${scenario.budgetUsd})`);
    }
  }
  if (scenario.budgetMs !== undefined) {
    const timeScore = efficiencyScore(durationMs, scenario.budgetMs);
    subScores.push(timeScore);
    parts.push(`time=${timeScore.toFixed(2)} (${durationMs}ms/${scenario.budgetMs}ms)`);
  }

  if (subScores.length === 0) {
    // Nothing to score (no time budget AND unpriced, or no budgets at all) —
    // re-normalize this dimension OUT of the weighted average. No row written.
    log(`[dimension] efficiency: no available metric — dropped (re-normalized out)`);
    return null;
  }

  // Dual budget → MIN of the two sub-scores (worst-case discipline).
  const subScore = Math.min(...subScores);
  await insertJudgment(db, {
    id: crypto.randomUUID(),
    attemptId: attempt.id,
    kind: "deterministic",
    name: dim.name,
    pass: subScore >= 1,
    score: subScore,
    reasoning: parts.join(", ") || null,
    // Deterministic compute is ~instant; report 0 (the attempt's own durationMs
    // is the wall-clock signal, not this dimension's compute time).
    durationMs: 0,
    dimension: dim.name,
    weight: dim.weight,
  });
  log(`[dimension] efficiency: score=${subScore.toFixed(2)} (${parts.join(", ")})`);
  return subScore;
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
    if (
      scenario.seed?.memories?.length ||
      scenario.seed?.exec?.length ||
      scenario.seed?.workerFailures?.length
    ) {
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

        // 3. Then seed.workerFailures (swarm-mechanics) — deterministically
        // break a CHOSEN worker's sandbox to test team recovery. UNLIKE
        // seed.exec these are BEST-EFFORT: a non-zero exit (or an exec error)
        // NEVER throws/fails the attempt — that is the whole point, leave the
        // worker broken and let the swarm cope. Out-of-range worker = skip+log.
        if (scenario.seed?.workerFailures?.length) {
          const failureOutputs: {
            worker: number;
            label: string | null;
            cmd: string;
            exitCode: number | null;
            durationMs: number;
            stdout: string;
            stderr: string;
            error: string | null;
            skipped: boolean;
          }[] = [];
          // Worker-role members only (mirrors resolveWorker / the later
          // workerCount): a failure may only target a real worker, never the lead.
          const bootedWorkerCount = stack.workers.filter((m) => m.member.role === "worker").length;
          try {
            for (const entry of scenario.seed.workerFailures) {
              const label = entry.label ?? null;
              const w = stack.workers[entry.worker];
              if (!w || w.member.role !== "worker") {
                log(
                  `[seed] WARNING: injecting failure into worker ${entry.worker}${label ? ` (${label})` : ""}: ` +
                    `worker out of range (${bootedWorkerCount} booted) — SKIPPED`,
                );
                for (const cmd of entry.commands) {
                  failureOutputs.push({
                    worker: entry.worker,
                    label,
                    cmd,
                    exitCode: null,
                    durationMs: 0,
                    stdout: "",
                    stderr: "",
                    error: `worker ${entry.worker} out of range (${bootedWorkerCount} booted)`,
                    skipped: true,
                  });
                }
                continue;
              }
              log(
                `[seed] injecting failure into worker ${entry.worker}${label ? ` (${label})` : ""} ` +
                  `(${entry.commands.length} command(s))`,
              );
              for (const cmd of entry.commands) {
                log(`[seed] (failure) ${cmd}`);
                const cmdT0 = Date.now();
                try {
                  const res = await sandboxExec(w.sandbox.sandboxID, cmd);
                  failureOutputs.push({
                    worker: entry.worker,
                    label,
                    cmd,
                    exitCode: res.exitCode,
                    durationMs: Date.now() - cmdT0,
                    stdout: res.stdout.slice(0, SEED_OUTPUT_CLIP),
                    stderr: res.stderr.slice(0, SEED_OUTPUT_CLIP),
                    error: null,
                    skipped: false,
                  });
                  // Best-effort: a non-zero exit is EXPECTED to be tolerated —
                  // log it, do NOT throw (the worker is meant to stay broken).
                  log(
                    `[seed] (failure) exit ${res.exitCode} in ${Date.now() - cmdT0}ms` +
                      (res.exitCode !== 0 ? " (tolerated)" : ""),
                  );
                } catch (err) {
                  // Even an exec/connect error must not fail the attempt.
                  const msg = err instanceof Error ? err.message : String(err);
                  failureOutputs.push({
                    worker: entry.worker,
                    label,
                    cmd,
                    exitCode: null,
                    durationMs: Date.now() - cmdT0,
                    stdout: "",
                    stderr: "",
                    error: msg.slice(0, SEED_OUTPUT_CLIP),
                    skipped: false,
                  });
                  log(`[seed] WARNING: (failure) exec error (tolerated): ${msg.slice(0, 300)}`);
                }
              }
            }
          } finally {
            await insertArtifact(db, {
              id: crypto.randomUUID(),
              attemptId: attempt.id,
              kind: "meta",
              name: "seed-worker-failures.json",
              content: stack.redact(JSON.stringify(failureOutputs, null, 2)),
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
        ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
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

    // Runtime-spawned-task enumeration (Plan A §Phase 1). The scenario's upfront
    // tasks are the only ones we await/capture, but the agents spawn MORE tasks
    // at runtime — lead-delegated child tasks, the auto follow-ups a worker
    // completion triggers (taskType="follow-up"), and resume tasks. Those ARE
    // the delegation artifacts the rubric scores, but they're invisible to
    // `tasks` (which only holds the upfront set). Fresh-DB-per-attempt means a
    // full list returns exactly THIS attempt's tasks, so merge any not already
    // tracked into the set passed to JudgeContext.tasks. Read-only for scoring:
    // NOT awaited, NOT added to taskIds, NOT pulled into log/cost capture (those
    // stay scenario-scoped via `activeTasks`). Best-effort — a list failure must
    // not fail the attempt (scoring degrades to the upfront set).
    const ctxTasks: SwarmTask[] = [...tasks];
    const upfrontTaskIds = new Set(tasks.map((t) => t.id));
    try {
      const allTasks = await client.listAllTasks();
      const spawned = allTasks.filter((t) => t.id && !upfrontTaskIds.has(t.id));
      ctxTasks.push(...spawned);
      log(`[task] captured ${spawned.length} runtime-spawned task(s) for scoring`);
    } catch (err) {
      log(
        `[task] runtime-spawned-task enumeration failed (scoring upfront set only): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
    // Tag each task run-vs-seed (display-only — scoring is unaffected). A scenario
    // may seed reference-data tasks (e.g. delegation-probe's 20 audit-history rows)
    // into the SAME swarm DB the run uses; listAllTasks() returns them alongside
    // the real run activity. They were created BEFORE the run's agents existed, so
    // none carry a run agent id / upfront id — the predicate (see classifyTaskOrigin)
    // segregates them. The flag rides on the artifact (origin) so the UI can hide the
    // seed rows by default; the seed tasks STAY in ctxTasks for post-hoc debugging.
    const runAgentIds = new Set(
      stack.workers.map((w) => w.agentId).filter((id): id is string => !!id),
    );
    for (const t of ctxTasks) {
      (t as SwarmTask).origin = classifyTaskOrigin(t, upfrontTaskIds, runAgentIds);
    }

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
      // Roster metadata (v8.0 §4) from boot-time BootMember — the agentic judge
      // renders this as a manifest so it knows which worker is which / the lead.
      name: w.member.spec.name,
      template: w.member.spec.template,
      role: w.member.role,
      isLead: w.member.role === "lead",
    }));
    const worker0Ctx = ctxWorkers[0] as (typeof ctxWorkers)[number];
    const ctx: JudgeContext = {
      // Scenario tasks + runtime-spawned tasks (Plan A §Phase 1) — the latter
      // are read-only delegation artifacts merged in above for the rubric.
      tasks: ctxTasks,
      transcript,
      exec: worker0Ctx.exec,
      readFile: worker0Ctx.readFile,
      apiGet: (path) => client.get(path),
      workers: ctxWorkers,
    };

    // ---- v8.0 OutcomeSpec v2 scoring: gates → weighted dimensions ----
    // Normalize any v1 spec (checks/llmJudge/agenticJudge/passThreshold) onto
    // the v2 shape so v1 and v2 share one code path. tasksCompletedCheck is
    // prepended HERE (not in the normalizer) so it gates both uniformly.
    const normalized = normalizeOutcome(scenario.outcome);
    const threshold = normalized.passThreshold;

    // 1) Gates — binary must-pass. A gate failure forces passed=false, but the
    // score is STILL computed and stored (anti-gaming: a config can't "win" by
    // clearing only the cheap gate). A thrown check yields {pass:false} (it's
    // the config's broken sandbox), NOT a judge error.
    const gates = [tasksCompletedCheck(tasks), ...normalized.gates];
    setAttemptPhase(attempt.id, "checks");
    log(`[check] running ${gates.length} gate check(s)`);
    const gatesTimed = await timed(() => runChecks(gates, ctx, judgeLive));
    const gateResults = gatesTimed.result;
    timings.checksMs = gatesTimed.ms;
    recordAttemptTimings(attempt.id, timings);
    for (const result of gateResults) {
      await insertJudgment(db, {
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        kind: "deterministic",
        name: result.name,
        pass: result.pass,
        score: result.score ?? (result.pass ? 1 : 0),
        reasoning: result.detail ?? null,
        durationMs: result.durationMs,
        // Gates are NOT dimensions — dimension/weight stay NULL.
        dimension: null,
        weight: null,
      });
      log(
        `[check] ${result.name}: ${result.pass ? "pass" : "FAIL"}${result.detail ? ` (${result.detail})` : ""}`,
      );
    }
    const allGatesPass = gateResults.every((r) => r.pass);

    // 2) Dimensions — each yields a 0-1 sub-score (graded checks weighted mean,
    // a judge, OR the deterministic efficiency metric), persisted as exactly one
    // judgment row carrying dimension + weight. Sub-scores aggregate into
    // score = Σ wᵢ·dimᵢ / Σ wᵢ.
    const scored: { weight: number; subScore: number }[] = [];
    for (const dim of normalized.dimensions) {
      // Deterministic efficiency (v8.0 §5): a dimension named `efficiency` with
      // no checks/judge is scored from the attempt's REAL cost/duration vs the
      // scenario budget. An unpriced+no-time-budget result returns null → the
      // dimension is DROPPED (re-normalized out of the divisor), never 0.
      if (isDeterministicEfficiencyDimension(dim)) {
        const effScore = await efficiencyDimensionScore({
          db,
          attempt,
          scenario,
          dim,
          costUsd,
          durationMs: Date.now() - startedAt,
          log,
        });
        if (effScore !== null) scored.push({ weight: dim.weight, subScore: effScore });
        continue;
      }
      const subScore = await scoreDimension({
        db,
        attempt,
        scenario,
        dim,
        ctx,
        judgeLive,
        judgeModel: opts.judgeModel,
        timings,
        addJudgeCost,
        signal,
        log,
      });
      scored.push({ weight: dim.weight, subScore });
    }

    // Live view flips judging → false; traces stay readable until clearJudging.
    endJudging(attempt.id);

    // 3) Aggregate + pass. No dimensions (legacy gates-only spec) → score is the
    // binary gate verdict. Otherwise score = Σ wᵢ·dimᵢ / Σ wᵢ. The score is
    // computed regardless of gate outcome; gates only gate `passed`.
    const { score, passed } = finalizeScore({
      allGatesPass,
      dimensions: scored,
      passThreshold: threshold,
    });

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
      // Serialize ctxTasks (the upfront set MERGED with runtime-spawned child +
      // follow-up tasks — the exact set the checks scored), not the upfront `tasks`
      // alone, so the delegation paper-trail is inspectable post-hoc.
      content: stack.redact(JSON.stringify(ctxTasks, null, 2)),
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
      // START with "infra failure (<signatureId>)"); a JudgeInfraError (v8.0
      // §3.5 judge model/infra flake) keeps its clean typed message and maps to
      // status `error` (NOT `failed`); everything else keeps the stack for
      // debuggability.
      const message =
        err instanceof InfraTaskFailureError || err instanceof JudgeInfraError
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
