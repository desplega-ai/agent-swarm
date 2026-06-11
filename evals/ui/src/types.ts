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

export interface SandboxInfoJson {
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

export interface ScenarioJson {
  id: string;
  name: string;
  description: string | null;
  tasks: { title: string; description: string }[];
  seed: { exec: string[] } | null;
  timeoutMs: number;
  outcome: {
    checks: string[];
    llmJudge: { rubric: string; model: string | null } | null;
    agenticJudge: { rubric: string; model: string | null; maxSteps: number | null } | null;
    passThreshold: number;
  };
}

export interface ConfigJson {
  id: string;
  label: string | null;
  provider: string;
  model: string | null;
  modelTier: string | null;
  envKeys: string[];
  isDefault: boolean;
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
}

export interface CreateRunBody {
  name?: string;
  scenarioIds: string[];
  configIds: string[];
  attemptsPerCell?: number;
  concurrency?: number;
  judgeModel?: string;
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

export interface AnalyticsResponse {
  generatedAt: string;
  scenarioIds: string[];
  configIds: string[];
  matrix: AnalyticsCell[];
  models: AnalyticsModel[];
  series: AnalyticsSeries[];
}
