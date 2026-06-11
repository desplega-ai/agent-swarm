/**
 * Core domain types for the swarm eval system.
 *
 * An eval run is a matrix: scenarios x harness configs, with n attempts per
 * cell (best@n). Each attempt boots a fresh swarm stack in an E2B sandbox,
 * seeds optional data, creates the scenario's initial task(s), waits for
 * completion, then grades the outcome (LLM judge + deterministic checks).
 */

export type HarnessProvider = "claude" | "pi" | "codex" | "opencode";

export type ModelTier = "smol" | "regular" | "smart" | "ultra";

/** One cell of the config axis: which harness + model the worker under test runs. */
export interface HarnessConfig {
  /** Stable slug used in DB rows and result tables, e.g. "pi-deepseek-flash". */
  id: string;
  label?: string;
  provider: HarnessProvider;
  /** Concrete model override (MODEL_OVERRIDE for the worker). */
  model?: string;
  /** Portable tier intent; resolved by the worker at claim time. */
  modelTier?: ModelTier;
  /** Extra env vars for the worker container (merged over defaults). */
  env?: Record<string, string>;
}

export interface TaskSpec {
  title: string;
  description: string;
}

export interface ScenarioSeed {
  /** Shell commands run inside the sandbox after the stack is healthy. */
  exec?: string[];
  /** Memories to inject for the worker under test before tasks start. */
  memories?: string[];
}

export interface LlmJudgeSpec {
  /** Rubric describing what a successful outcome looks like. */
  rubric: string;
  /** OpenRouter model id; defaults to the run's judgeModel, then EVAL_JUDGE_MODEL. */
  model?: string;
}

/**
 * Agentic judge: an AI SDK tool-loop agent that actively verifies the outcome
 * using the deterministic context tools (run_command / read_file / api_get)
 * before submitting a verdict.
 */
export interface AgenticJudgeSpec {
  rubric: string;
  /** OpenRouter model id; same default chain as LlmJudgeSpec. */
  model?: string;
  /** Max agent steps before forcing a verdict. Default 10. */
  maxSteps?: number;
}

export interface CheckResult {
  pass: boolean;
  detail?: string;
}

/** Deterministic check, run against the live attempt context after tasks finish. */
export interface DeterministicCheck {
  name: string;
  fn: (ctx: JudgeContext) => Promise<CheckResult>;
}

export interface OutcomeSpec {
  llmJudge?: LlmJudgeSpec;
  agenticJudge?: AgenticJudgeSpec;
  checks?: DeterministicCheck[];
  /** Minimum LLM judge score in [0,1] to count as pass. Default 0.7. */
  passThreshold?: number;
}

export interface Scenario {
  /** Stable slug, e.g. "hello-file". */
  id: string;
  name: string;
  description?: string;
  seed?: ScenarioSeed;
  /** Initial task(s) created against the worker under test. */
  tasks: TaskSpec[];
  outcome: OutcomeSpec;
  /** Per-attempt wall clock budget. Default 10 minutes. */
  timeoutMs?: number;
}

/** What judges can see: the swarm API of the attempt's stack + sandbox access. */
export interface JudgeContext {
  /** Completed task records as returned by the swarm API. */
  tasks: SwarmTask[];
  /** Flattened transcript/session-log text for the worker under test. */
  transcript: string;
  /** Run a shell command inside the attempt's sandbox (e.g. inspect /workspace). */
  exec: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Read a file from the sandbox; returns null when missing. */
  readFile: (path: string) => Promise<string | null>;
  /** Raw authenticated GET against the attempt's swarm API. */
  apiGet: (path: string) => Promise<unknown>;
}

/** Minimal shape of a swarm task as the eval system consumes it. */
export interface SwarmTask {
  id: string;
  title: string;
  description: string;
  status: string;
  result?: string | null;
  assignedAgentId?: string | null;
  [key: string]: unknown;
}

export type CostSource = "harness" | "recomputed" | "unpriced";

export interface TokenTotals {
  model: string | null; // dominant concrete model id observed (e.g. "claude-opus-4-7")
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Everything known about the attempt's E2B stack. Taras explicitly OK'd storing the swarm API key. */
export interface SandboxInfo {
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
  expiresAt: string | null; // worker sandbox endAt/expiresAt
  /** Swarm API version from the sandbox /health response. Null/absent (older attempts) = not captured. */
  apiVersion?: string | null;
  /** Worker build version (`agent-swarm version` in the worker sandbox). Null/absent = not captured. */
  workerVersion?: string | null;
}

/** Per-phase wall-clock timings in ms. All nullable (phase may not have run). */
export interface PhaseTimings {
  bootMs: number | null;
  seedMs: number | null;
  tasksMs: number | null; // total across tasks
  perTask: { taskId: string; ms: number }[];
  logCaptureMs: number | null;
  costMs: number | null;
  checksMs: number | null;
  llmJudgeMs: number | null;
  agenticJudgeMs: number | null;
  artifactsMs: number | null;
}

// ---- live attempt progress (round 4, items 6 + 14) ----

/** Runner phase identifiers, 1:1 with the PhaseTimings keys (perTask folds into "tasks"). */
export type AttemptPhase =
  | "boot"
  | "seed"
  | "tasks"
  | "log-capture"
  | "cost"
  | "checks"
  | "llm-judge"
  | "agentic-judge"
  | "artifacts";

export type ProgressLogLevel = "info" | "warn" | "error";

/** One captured runner-log line for an attempt (live ring buffer + runner.log artifact). */
export interface ProgressLogLine {
  ts: string; // ISO
  level: ProgressLogLevel;
  line: string;
}

/**
 * Snapshot served by GET /api/attempts/:id/progress. Same philosophy as
 * judge-live: registry-only, ALWAYS 200 — unknown/finished attempts return the
 * empty shape ({ active: false, … }).
 */
export interface AttemptProgressSnapshot {
  /** True while the attempt is executing in this server process. */
  active: boolean;
  startedAt: string | null;
  currentPhase: AttemptPhase | null;
  /** When the current phase started (drives the live waterfall's growing bar). */
  currentPhaseStartedAt: string | null;
  /** Filled as phases complete — partial while the attempt runs. */
  phases: Partial<PhaseTimings>;
  log: ProgressLogLine[];
}

export interface RecomputeInput {
  provider: HarnessProvider;
  configModel: string | null; // HarnessConfig.model (may be shortname/prefixed)
  logRows: { cli: string; content: string }[]; // raw swarm session-log rows
  sessionFiles: { path: string; content: string }[]; // harness-session file heads
}

export interface RecomputeResult {
  costUsd: number | null;
  tokens: TokenTotals | null;
}

export type JudgeKind = "deterministic" | "llm" | "agentic";

export type JudgeStepKind = "reasoning" | "tool" | "check" | "error";

/**
 * One step of a judge trace. Field usage varies by kind:
 *   reasoning — text = model reasoning + text of one LLM call; tokens/costUsd = the call's usage
 *   tool      — tool = tool name; args = input object; output = clipped JSON string
 *   check     — tool = check name; text = detail; pass = check result
 *   error     — text = failure message
 */
export interface JudgeStep {
  /** Position in JudgeTrace.steps. Renumbered whenever a step is inserted mid-array. */
  index: number;
  kind: JudgeStepKind;
  text: string | null;
  tool: string | null;
  /** Tool-call input object (tool steps only); null otherwise. */
  args: unknown;
  /** Clipped JSON string of the tool output (tool steps only); null otherwise. */
  output: string | null;
  /** Check result (check steps only); null for every other kind. */
  pass: boolean | null;
  startedAt: string;
  durationMs: number | null;
  /** The LLM call's usage (reasoning steps only). */
  tokens: TokenTotals | null;
  /** Priced usage (reasoning steps only; null when the model is unpriced). */
  costUsd: number | null;
}

/** Full trace of one judge execution — streamed live, then persisted on the judgment row. */
export interface JudgeTrace {
  judge: JudgeKind;
  /** Resolved judge model id (OpenRouter id). Null for deterministic. */
  model: string | null;
  startedAt: string;
  /** Null while the judge is still running (live view). */
  finishedAt: string | null;
  durationMs: number | null;
  /** Sum of step costUsd values; null when no step was priced. */
  costUsd: number | null;
  /** Summed usage across reasoning steps; null when there were none. */
  tokens: TokenTotals | null;
  /** Set when the judge crashed or never submitted a verdict. */
  error: string | null;
  steps: JudgeStep[];
}

export type AttemptStatus = "pending" | "running" | "judging" | "passed" | "failed" | "error";

export type RunStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface EvalRunRow {
  id: string;
  name: string | null;
  status: RunStatus;
  scenarioIds: string[];
  configIds: string[];
  attemptsPerCell: number;
  concurrency: number;
  /** Run-level judge model override (scenario-level model still wins). */
  judgeModel: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AttemptRow {
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
  costSource: CostSource | null;
  /** Aggregate judge LLM cost (harness overhead) — NEVER included in costUsd. */
  judgeCostUsd: number | null;
  tokens: TokenTotals | null;
  sandbox: SandboxInfo | null;
  timings: PhaseTimings | null;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JudgmentRow {
  id: string;
  attemptId: string;
  /** DB CHECK constraint — agentic judgments keep kind "llm" + name "agentic-judge". */
  kind: "llm" | "deterministic";
  name: string;
  pass: boolean;
  score: number | null;
  reasoning: string | null;
  raw: string | null;
  /** Wall-clock for this judgment (per-check ms for deterministic). Null on old rows. */
  durationMs: number | null;
  /** Judge LLM cost for this judgment (harness overhead). Null on old rows / deterministic. */
  costUsd: number | null;
  /** Judge token usage; tokens.model carries the judge model id. Null on old rows. */
  tokens: TokenTotals | null;
  /** Full trace steps (llm/agentic). Null on old rows / deterministic. */
  steps: JudgeStep[] | null;
  createdAt: string;
}

export interface ArtifactRow {
  id: string;
  attemptId: string;
  kind:
    | "transcript"
    | "raw-session-logs"
    | "harness-session"
    | "task"
    | "sandbox-log"
    | "workspace-file"
    | "log"
    | "meta";
  name: string | null;
  content: string;
  createdAt: string;
}

// ---- analytics (round 5, item 2 — v5 spec §1, FROZEN) ----

/** One scenario × config cell aggregated across ALL runs (analytics heat matrix). */
export interface AnalyticsCell {
  scenarioId: string;
  configId: string;
  /** Every attempt row, any status. */
  attempts: number;
  /** Status 'passed' | 'failed' — errors are infra, not graded. */
  graded: number;
  passed: number;
  errors: number;
  /** passed / graded; null when graded === 0 (never NaN). */
  passRate: number | null;
  /** Attempts with costUsd !== null. */
  pricedAttempts: number;
  /** Σ costUsd over priced attempts; null when 0 priced. */
  totalCostUsd: number | null;
  /** totalCostUsd / pricedAttempts. */
  avgCostUsd: number | null;
  /** Attempts with judgeCostUsd !== null. */
  judgePricedAttempts: number;
  /** Σ judgeCostUsd over judge-priced attempts; null when 0 judge-priced. */
  totalJudgeCostUsd: number | null;
  /** Mean over attempts with judgeCostUsd !== null. */
  avgJudgeCostUsd: number | null;
  /** Mean over attempts with durationMs !== null. */
  avgDurationMs: number | null;
  /** Mean over attempts with score !== null. */
  avgScore: number | null;
  /** Newest run.createdAt touching this cell. */
  lastRunAt: string | null;
}

/** Per-model rollup (model key: tokens.model → registry config.model → "(configId)"). */
export interface AnalyticsModel {
  model: string;
  /** Distinct registry providers of contributing configs. */
  providers: string[];
  configIds: string[];
  /** Distinct runs touched (any attempt). */
  runs: number;
  attempts: number;
  graded: number;
  passed: number;
  errors: number;
  passRate: number | null;
  avgScore: number | null;
  pricedAttempts: number;
  totalCostUsd: number | null;
  /** totalCostUsd / pricedAttempts. */
  avgCostPerAttempt: number | null;
  /** totalCostUsd / distinct runs with ≥1 priced attempt. */
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
  /** First non-null among the cell's attempts, cleanVersion()ed. */
  apiVersion: string | null;
  workerVersion: string | null;
}

/** A detected version change along a series (drawn as a vertical marker line). */
export interface AnalyticsVersionEvent {
  /** The point where the new version first appears. */
  runId: string;
  createdAt: string;
  kind: "api" | "worker";
  /** Null = first capture (older points had no version). */
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
  /** Every scenario id seen in attempts, first-seen order. */
  scenarioIds: string[];
  configIds: string[];
  /** Only cells with ≥1 attempt. */
  matrix: AnalyticsCell[];
  /** Sorted by attempts desc. */
  models: AnalyticsModel[];
  /** Every (scenario, config) pair with ≥1 attempt. */
  series: AnalyticsSeries[];
}

/** Distinct cleaned versions across one run's attempts (runs list, v5 spec §1.5). */
export interface RunVersions {
  api: string[];
  worker: string[];
}
