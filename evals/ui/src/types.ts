/**
 * TypeScript mirrors of the evals API JSON contracts (spec §4).
 * Deliberately duplicated from the backend — the UI never imports from evals/src.
 */

export type RunStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export type AttemptStatus = "pending" | "running" | "judging" | "passed" | "failed" | "error";

export interface RunJson {
  id: string;
  name: string | null;
  status: RunStatus;
  scenarioIds: string[];
  configIds: string[];
  attemptsPerCell: number;
  concurrency: number;
  judgeModel: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface CellJson {
  scenarioId: string;
  configId: string;
  attempts: number;
  finished: number;
  passedAny: boolean;
  passedFirst: boolean | null;
  bestScore: number | null;
  avgScore: number | null;
  totalCostUsd: number | null;
  avgDurationMs: number | null;
  errors: number;
  /** v7 §2: count of passed attempts in the cell. Absent on pre-v7 servers. */
  passed?: number;
  /** v7 §2: attempts with costUsd !== null. Absent on pre-v7 servers. */
  pricedAttempts?: number;
  /** v7 §2: totalCostUsd ÷ priced attempts; null when 0 priced. */
  avgCostUsd?: number | null;
}

export interface TotalsJson {
  attempts: number;
  finished: number;
  passedCells: number;
  totalCells: number;
  totalCostUsd: number | null;
  /** Judge LLM cost (harness overhead) — kept SEPARATE from totalCostUsd. */
  judgeCostUsd: number | null;
  totalDurationMs: number | null;
  passedAttempts: number;
  errorAttempts: number;
  unpricedAttempts: number;
}

export interface TokenTotalsJson {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Legacy flat sandboxJson (v1) — old rows in existing evals.db files (read-only). */
export interface SandboxInfoV1Json {
  apiSandboxId: string;
  workerSandboxId: string;
  apiTemplate: string;
  workerTemplate: string;
  apiUrl: string;
  swarmKey: string;
  workerAgentId: string;
  domain: string | null;
  apiStartedAt: string | null;
  workerStartedAt: string | null;
  expiresAt: string | null;
  /** Swarm API version from the sandbox /health response. Null/absent (older attempts) = not captured. */
  apiVersion?: string | null;
  /** Worker build version (`agent-swarm version` in the worker sandbox). Null/absent = not captured. */
  workerVersion?: string | null;
}

/**
 * One worker entry of the persisted sandboxJson v2 blob (v6 spec §0.3 —
 * FROZEN; v7 §9/§12 add the nullable identity + effective-config fields,
 * absent on old rows).
 */
export interface SandboxWorkerInfoJson {
  index: number;
  sandboxId: string;
  template: string;
  agentId: string;
  startedAt: string | null;
  expiresAt: string | null;
  version: string | null;
  /** WorkerSpec.name (AGENT_NAME) — v7 §9. Null/absent = default worker. */
  name?: string | null;
  /** WorkerSpec.template (TEMPLATE_ID) — v7 §9; NOT the E2B template. */
  agentTemplate?: string | null;
  /** "lead" | "worker" (v7 §12). Null/absent (pre-v7 rows) = worker. */
  role?: "lead" | "worker" | null;
  /**
   * EFFECTIVE member config (v7 §12) — non-null only when this member
   * OVERRODE the attempt's cell config; fall back to the cell config.
   */
  configId?: string | null;
  provider?: string | null;
  model?: string | null;
}

/**
 * Per-member roster + cost snapshot captured at attempt end (v7 §10/§12 —
 * FROZEN). Null/absent on pre-v7 attempts — fall back to the sandbox workers.
 * Includes the LEAD (memberRole "lead") when the scenario defines one.
 */
export interface WorkerRosterEntryJson {
  /** Member index — joins SandboxWorkerInfoJson.index (lead = workers.length). */
  index: number;
  memberRole: "lead" | "worker";
  agentId: string;
  sandboxId: string;
  name: string | null;
  /** Free-form profile role from the agents API (template-applied). */
  role: string | null;
  isLead: boolean;
  /** Agent status at roster-capture time (§10.3); null when the agent fetch missed. */
  status: string | null;
  provider: string | null;
  capabilities: string[];
  maxTasks: number | null;
  lastActivityAt: string | null;
  agentTemplate: string | null;
  /** Effective member config (v7 §12); null = ran the cell config exactly. */
  configId: string | null;
  model: string | null;
  version: string | null;
  taskIds: string[];
  costUsd: number | null;
  tokens: TokenTotalsJson | null;
}

/** sandboxJson v2 (v6 spec §0.3 — FROZEN): discriminated by `v: 2` / `workers` array. */
export interface SandboxInfoV2Json {
  v: 2;
  apiSandboxId: string;
  apiTemplate: string;
  apiUrl: string;
  swarmKey: string;
  domain: string | null;
  apiStartedAt: string | null;
  apiVersion: string | null;
  workers: SandboxWorkerInfoJson[];
}

/**
 * Union of both persisted shapes. ALL UI consumers go through
 * `normalizeSandboxInfo` (lib/sandbox.ts) — no direct field access on the
 * union outside that file (v6 spec §0.4).
 */
export type SandboxInfoJson = SandboxInfoV1Json | SandboxInfoV2Json;

/**
 * One entry of the tasks.json artifact (kind "task") — only the fields the UI
 * reads. `skipped` is runner-computed (v6 spec §0.12); rows predating the flag
 * fall back to testing failureReason against CASCADE_SKIP_RE.
 */
export interface TaskArtifactJson {
  id: string;
  title?: string;
  status?: string;
  failureReason?: string | null;
  skipped?: boolean;
  [key: string]: unknown;
}

/**
 * One normalized per-task record from GET /api/attempts/:id/tasks (v7.5 items
 * 2/5/6 — FROZEN; mirrors evals/src/types.ts AttemptTaskRecord). Every field
 * degrades to null/[]/false on old rows — render "—" (never break).
 */
export interface AttemptTaskJson {
  id: string;
  /** Normalized title; null when empty/absent. */
  title: string | null;
  /** Swarm task status string; null when unknown ("task-ids" source). */
  status: string | null;
  /** Final result/output text (server-clipped); null when absent. */
  outcome: string | null;
  /** failureReason (server-clipped); null when absent. */
  error: string | null;
  /** Cascade-skipped dependent (v6 §9 semantics) — render distinctly from real errors. */
  skipped: boolean;
  /** Task UUIDs this task depended on; [] when none/unknown. */
  dependsOn: string[];
  agentId: string | null;
  /**
   * Run-vs-seed classification (display-only; mirrors AttemptTaskRecord.origin).
   * "run" = real run activity; "seed" = pre-existing scenario reference-data the
   * swarm DB carried in. Optional = pre-tag server payloads — default a missing
   * value to "run" (the run-only contract: never hide a record on absence).
   */
  origin?: "run" | "seed";
  /**
   * Σ priced session-cost rows of this task (same rule as the round-7
   * per-member roster cost). Null = unpriced / no artifact (v1-era) / live.
   */
  costUsd: number | null;
  tokens: TokenTotalsJson | null;
  // ---- v7.7 item 7 amendment (FROZEN; mirrors AttemptTaskRecord): task
  // economics for the sub-tab chips. Optional = pre-round-9 server payloads;
  // the round-9 server always populates (null when unknown). Render rule:
  // null/absent → omit the chip segment ("—" in the hover breakdown); v1-era
  // all-null records render the pill exactly as today.
  /** Raw task-record `createdAt` ISO string; null when unknown. */
  createdAt?: string | null;
  /** Raw task-record `finishedAt` ISO string; null while running / unknown. */
  finishedAt?: string | null;
  /** Server-computed finishedAt − createdAt in ms; null unless both parse and diff >= 0. */
  durationMs?: number | null;
}

/**
 * GET /api/attempts/:id/tasks (v7.5 — FROZEN). `source`: "live" (fresh from
 * the running stack — costUsd/tokens always null), "tasks-artifact" (stored
 * tasks.json + session-costs.json), "task-ids" (attempt.taskIds only — no
 * artifact yet / v1-era rows), or null (nothing known). Records keep
 * attempt.taskIds creation order; artifact-only extras append after.
 */
export interface AttemptTasksResponse {
  source: "live" | "tasks-artifact" | "task-ids" | null;
  live: boolean;
  tasks: AttemptTaskJson[];
}

export interface PhaseTimingsJson {
  bootMs: number | null;
  seedMs: number | null;
  tasksMs: number | null;
  perTask: { taskId: string; ms: number }[];
  logCaptureMs: number | null;
  costMs: number | null;
  checksMs: number | null;
  llmJudgeMs: number | null;
  agenticJudgeMs: number | null;
  artifactsMs: number | null;
}

// ---- live attempt progress (v4 spec §2–§3) ----

export type AttemptPhaseJson =
  | "boot"
  | "seed"
  | "tasks"
  | "log-capture"
  | "cost"
  | "checks"
  | "llm-judge"
  | "agentic-judge"
  | "artifacts";

export type ProgressLogLevelJson = "info" | "warn" | "error";

export interface ProgressLogLineJson {
  ts: string;
  level: ProgressLogLevelJson;
  line: string;
}

/**
 * GET /api/attempts/:id/progress — ALWAYS 200; unknown/finished attempts
 * return { active: false, …empty }. Only meaningful while the attempt runs;
 * finished attempts use persisted timings + the runner.log artifact instead.
 */
export interface AttemptProgressResponse {
  active: boolean;
  startedAt: string | null;
  currentPhase: AttemptPhaseJson | null;
  /** When the current phase started (drives the live waterfall's growing bar). */
  currentPhaseStartedAt: string | null;
  phases: Partial<PhaseTimingsJson>;
  log: ProgressLogLineJson[];
}

export interface AttemptJson {
  id: string;
  runId: string;
  scenarioId: string;
  configId: string;
  attemptIndex: number;
  status: AttemptStatus;
  retries: number;
  sandboxId: string | null;
  apiUrl: string | null;
  taskIds: string[];
  score: number | null;
  passed: boolean | null;
  error: string | null;
  costUsd: number | null;
  costSource: string | null;
  /** Aggregate judge LLM cost (harness overhead) — NEVER included in costUsd. */
  judgeCostUsd: number | null;
  tokens: TokenTotalsJson | null;
  sandbox: SandboxInfoJson | null;
  /** v7 §10: per-worker roster + cost. Null/absent on pre-v7 attempts. */
  workers?: WorkerRosterEntryJson[] | null;
  timings: PhaseTimingsJson | null;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export type JudgeKindJson = "deterministic" | "llm" | "agentic";

export type JudgeStepKindJson = "reasoning" | "tool" | "check" | "error";

/**
 * One step of a judge trace (v3 spec §1). Field usage by kind:
 *   reasoning — text = model reasoning + text; tokens/costUsd = the LLM call's usage
 *   tool      — tool = tool name; args = input object; output = clipped JSON string
 *   check     — tool = check name; text = detail; pass = check result
 *   error     — text = failure message
 */
export interface JudgeStepJson {
  index: number;
  kind: JudgeStepKindJson;
  text: string | null;
  tool: string | null;
  args: unknown;
  output: string | null;
  pass: boolean | null;
  startedAt: string;
  durationMs: number | null;
  tokens: TokenTotalsJson | null;
  costUsd: number | null;
}

export interface JudgeTraceJson {
  judge: JudgeKindJson;
  model: string | null;
  startedAt: string;
  /** Null while the judge is still running (live view). */
  finishedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  tokens: TokenTotalsJson | null;
  error: string | null;
  steps: JudgeStepJson[];
}

export interface JudgeLiveResponse {
  judging: boolean;
  traces: JudgeTraceJson[];
}

export interface JudgmentJson {
  id: string;
  attemptId: string;
  kind: "llm" | "deterministic";
  name: string;
  pass: boolean;
  score: number | null;
  reasoning: string | null;
  raw: string | null;
  /** Wall-clock for this judgment (per-check ms for deterministic). Null on old rows. */
  durationMs: number | null;
  /** Judge LLM cost for this judgment (harness overhead). Null on old rows. */
  costUsd: number | null;
  /** Judge token usage; tokens.model carries the judge model id. Null on old rows. */
  tokens: TokenTotalsJson | null;
  /** Full trace steps (llm/agentic). Null on old rows / deterministic. */
  steps: JudgeStepJson[] | null;
  /**
   * Weighted dimension this judgment scores (v8.0 OutcomeSpec v2). NULL on gate
   * rows and all pre-v2 rows — rendered as a dash; never backfilled.
   */
  dimension: string | null;
  /** Dimension weight in the aggregate (v8.0). NULL on gate rows / pre-v2 rows. */
  weight: number | null;
  createdAt: string;
}

export interface ArtifactMetaJson {
  id: string;
  attemptId: string;
  kind: string;
  name: string | null;
  createdAt: string;
  size: number;
}

/** Distinct cleaned versions across one run's attempts (v5 spec §1.5). */
export interface RunVersions {
  api: string[];
  worker: string[];
}

export interface RunListItem {
  run: RunJson;
  cells: CellJson[];
  totals: TotalsJson;
  active: boolean;
  /** Optional until WP-AAPI lands — render "—" when absent (v5 spec §1.5). */
  versions?: RunVersions;
}

export interface RunDetail extends RunListItem {
  attempts: AttemptJson[];
}

export interface AttemptDetail {
  attempt: AttemptJson;
  judgments: JudgmentJson[];
  artifacts: ArtifactMetaJson[];
}

export interface TranscriptRow {
  id: string;
  taskId: string;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
}

export interface TranscriptResponse {
  source: "raw-session-logs" | "transcript" | null;
  harness: string | null;
  rows: TranscriptRow[] | null;
  text: string | null;
  /** True when rows were fetched fresh from the attempt's live sandbox (?live=1). */
  live?: boolean;
}

/** Mirrors SerializedWorkerSpec (v7 §9/§12) — env keys only, never values. */
export interface WorkerSpecJson {
  template: string | null;
  name: string | null;
  systemPrompt: string | null;
  /** v7 §12: member config override; null = the cell's config. */
  configId: string | null;
  model: string | null;
  envKeys: string[];
}

/** Mirrors SerializedScenario v4 (v6 §0.10 + v7 §9 `workerSpecs` + §12 `lead`). */
export interface ScenarioJson {
  id: string;
  name: string;
  description: string | null;
  /** Worker COUNT booted per attempt (default 1) — either workers shape. */
  workers: number;
  /** v7 §9: per-worker specs; null/absent = homogeneous numeric shape. */
  workerSpecs?: WorkerSpecJson[] | null;
  /** v7 §12: optional lead member; null/absent = no lead. */
  lead?: WorkerSpecJson | null;
  tasks: { title: string; description: string; worker: number | "lead"; dependsOn: number[] }[];
  seed: { exec: string[]; sqlDump: string | null; memories: string[] } | null;
  timeoutMs: number;
  outcome: {
    checks: string[];
    llmJudge: { rubric: string; model: string | null } | null;
    agenticJudge: { rubric: string; model: string | null; maxSteps: number | null } | null;
    passThreshold: number;
    /**
     * v8.0 OutcomeSpec v2: pass/fail gate check names (serializeScenario emits
     * normalized `gates`). NULL/absent on pre-v2 payloads — render nothing.
     */
    gates?: string[];
    /**
     * v8.0 OutcomeSpec v2: weighted scoring dimensions. `judge` true = the
     * dimension is fed by a judge rubric; otherwise its `checks` feed it.
     * NULL/absent on pre-v2 payloads — render nothing (back-compat).
     */
    dimensions?: { name: string; weight: number; checks: string[]; judge: boolean }[];
  };
}

/**
 * Artificial Analysis benchmark block on a catalog config (v7.6 item D —
 * mirrors evals/src/types.ts AaBenchmark). Null fields = "--" in the source
 * TSV; `provisional` = a numeric cell carried the trailing-"*" marker (keep
 * the number, flag it). Render "—" for nulls; configs without a block render
 * nothing (absent/null `ConfigJson.aa`).
 */
export interface AaBenchmarkJson {
  /** Exact AA row name this config maps to (incl. "(variant 2)" suffixes). */
  sourceRow: string;
  /** Why this AA variant matches how the harness runs the model; null = no variants. */
  matchedVariant: string | null;
  /** Raw display string ("1M", "922k"); null when unknown. */
  contextWindow: string | null;
  creator: string | null;
  intelligenceIndex: number | null;
  blendedUsdPer1M: number | null;
  medianTokensPerS: number | null;
  latencyFirstChunkS: number | null;
  totalResponseS: number | null;
  provisional: boolean;
}

export interface ConfigJson {
  id: string;
  label: string | null;
  provider: string;
  model: string | null;
  modelTier: string | null;
  envKeys: string[];
  isDefault: boolean;
  /** v7.6 item D: AA benchmark block; null/absent = unmatched config (render nothing). */
  aa?: AaBenchmarkJson | null;
}

/**
 * Named quick-run config set from GET /api/presets (v7.7 item 1 — FROZEN;
 * mirrors evals/src/types.ts ConfigPreset). Display order = response order.
 * The new-run preset buttons REPLACE the selection with the preset's ids ∩
 * the fetched catalog (unknown ids dropped; empty intersection = disabled
 * button) — same replace semantics as the frozen "Defaults" chip.
 */
export interface PresetJson {
  id: string;
  label: string;
  description: string;
  configIds: string[];
}

export interface ModelJson {
  id: string;
  name: string;
  reasoning: boolean;
  toolCall: boolean;
  context: number | null;
  inputPerM: number | null;
  outputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
}

export interface ModelsResponse {
  defaultJudgeModel: string;
  models: ModelJson[];
  /**
   * v7 §8: frozen claude bare-alias map ("fable" → "claude-fable-5", …),
   * computed server-side from the models.dev anthropic section. Absent on
   * pre-v7 servers — resolution then degrades to the raw id (old behavior).
   */
  aliases?: Record<string, string>;
}

export interface CreateRunBody {
  name?: string;
  scenarioIds: string[];
  configIds: string[];
  attemptsPerCell?: number;
  concurrency?: number;
  judgeModel?: string;
}

// ---- analytics v2 additions (round 7 — v7 spec §6/§7/§11, FROZEN) ----
// Optional fields below are ALWAYS populated by the v7 server; optionality
// only covers pre-v7 payloads, which must keep rendering (degrade to "—").

/** Σ token usage over a group's token-bearing attempts (v7 §11). */
export interface AnalyticsTokenSums {
  tokenAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output + cacheRead + cacheWrite. */
  totalTokens: number;
  /** totalTokens / tokenAttempts; null when tokenAttempts === 0. */
  avgTotalTokens: number | null;
}

/** Rollup keyed by harness ("claude") or model vendor ("anthropic") — v7 §7. */
export interface AnalyticsGroupRollup {
  group: string;
  models: string[];
  configIds: string[];
  runs: number;
  attempts: number;
  graded: number;
  passed: number;
  errors: number;
  passRate: number | null;
  avgScore: number | null;
  pricedAttempts: number;
  totalCostUsd: number | null;
  avgCostPerAttempt: number | null;
  minCostUsd: number | null;
  maxCostUsd: number | null;
  avgDurationMs: number | null;
  tokens: AnalyticsTokenSums | null;
}

/** One scatter point per model key (v7 §7/§11 — accuracy vs tokens). */
export interface AnalyticsScatterPoint {
  model: string;
  /** Model vendor (anthropic/openai/google/deepseek/…); "(unknown)" fallback. */
  vendor: string;
  harnesses: string[];
  attempts: number;
  graded: number;
  passRate: number | null;
  avgScore: number | null;
  avgCostUsd: number | null;
  avgDurationMs: number | null;
  /** x axis: mean total tokens per token-bearing attempt; null → omit point. */
  avgTotalTokens: number | null;
  totalTokens: number;
}

// ---- analytics (round 5 — v5 spec §1, FROZEN; mirrors evals/src/types.ts) ----

/** One scenario × config cell aggregated across ALL runs (analytics heat matrix). */
export interface AnalyticsCell {
  scenarioId: string;
  configId: string;
  attempts: number;
  /** Status 'passed' | 'failed' — errors are infra, not graded. */
  graded: number;
  passed: number;
  errors: number;
  /** passed / graded; null when graded === 0. */
  passRate: number | null;
  /** Attempts with costUsd !== null. */
  pricedAttempts: number;
  totalCostUsd: number | null;
  avgCostUsd: number | null;
  /** Attempts with judgeCostUsd !== null. */
  judgePricedAttempts: number;
  /** Σ judgeCostUsd over judge-priced attempts; null when 0 judge-priced. */
  totalJudgeCostUsd: number | null;
  avgJudgeCostUsd: number | null;
  avgDurationMs: number | null;
  avgScore: number | null;
  lastRunAt: string | null;
  /** v7 §6: min/max costUsd over priced attempts; null when 0 priced. */
  minCostUsd?: number | null;
  maxCostUsd?: number | null;
  /** v7 §11: token sums over the cell's token-bearing attempts. */
  tokens?: AnalyticsTokenSums | null;
}

/** Per-model rollup (model key: tokens.model → registry config.model → "(configId)"). */
export interface AnalyticsModel {
  model: string;
  providers: string[];
  configIds: string[];
  runs: number;
  attempts: number;
  graded: number;
  passed: number;
  errors: number;
  passRate: number | null;
  avgScore: number | null;
  pricedAttempts: number;
  totalCostUsd: number | null;
  avgCostPerAttempt: number | null;
  avgCostPerRun: number | null;
  /** $ per minute of work: Σcost / (Σduration/60000) over attempts having BOTH fields. */
  costPerMinute: number | null;
  avgDurationMs: number | null;
  /** v7 §6: min/max costUsd over priced attempts; null when 0 priced. */
  minCostUsd?: number | null;
  maxCostUsd?: number | null;
  /** v7 §7: model vendor (anthropic/openai/…); "(unknown)" fallback. */
  vendor?: string;
  /** v7 §11: token sums over the model's token-bearing attempts. */
  tokens?: AnalyticsTokenSums | null;
}

/** One run's aggregate for a (scenario, config) cell — a time-series point. */
export interface AnalyticsSeriesPoint {
  runId: string;
  runName: string | null;
  /** Run createdAt — the series x value. */
  createdAt: string;
  attempts: number;
  graded: number;
  passRate: number | null;
  avgScore: number | null;
  totalCostUsd: number | null;
  avgCostUsd: number | null;
  avgJudgeCostUsd: number | null;
  avgDurationMs: number | null;
  apiVersion: string | null;
  workerVersion: string | null;
  /** v7 §6: min/max costUsd over the run-cell's priced attempts. */
  minCostUsd?: number | null;
  maxCostUsd?: number | null;
  /** v7 §11: token sums over the run-cell's token-bearing attempts. */
  tokens?: AnalyticsTokenSums | null;
}

/** A detected version change along a series (drawn as a vertical marker line). */
export interface AnalyticsVersionEvent {
  runId: string;
  createdAt: string;
  kind: "api" | "worker";
  /** Null = first capture. */
  from: string | null;
  to: string;
}

export interface AnalyticsSeries {
  scenarioId: string;
  configId: string;
  /** Ascending createdAt. */
  points: AnalyticsSeriesPoint[];
  versionEvents: AnalyticsVersionEvent[];
}

/**
 * Global analytics filter (v7.6 §C3 — mirrors evals/src/types.ts). Sent as
 * `harnesses` / `configs` CSV query params on GET /api/analytics; the server
 * filters source rows BEFORE aggregation (client-side filtering cannot
 * re-derive model/vendor/scatter aggregates). Empty array = no filter.
 */
export interface AnalyticsFilter {
  harnesses: string[];
  configIds: string[];
}

/** Pre-filter option lists for the global filter bar (v7.6 §C3). */
export interface AnalyticsFilterOptions {
  harnesses: string[];
  configIds: string[];
}

export interface AnalyticsResponse {
  generatedAt: string;
  scenarioIds: string[];
  configIds: string[];
  matrix: AnalyticsCell[];
  models: AnalyticsModel[];
  series: AnalyticsSeries[];
  /** v7 §7: rollups by harness provider, sorted by attempts desc. */
  harnesses?: AnalyticsGroupRollup[];
  /** v7 §7: rollups by model vendor, sorted by attempts desc. */
  vendors?: AnalyticsGroupRollup[];
  /** v7 §7/§11: one point per model key (scatter: accuracy vs tokens). */
  scatter?: AnalyticsScatterPoint[];
  /** v7.6 §C3: distinct harness/config options over ALL rows (pre-filter). Absent on old cached payloads. */
  filterOptions?: AnalyticsFilterOptions;
  /** v7.6 §C3: the filter the server applied; null/absent = unfiltered. */
  appliedFilter?: AnalyticsFilter | null;
}
