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
  /** OpenRouter model id; defaults to EVAL_JUDGE_MODEL or a sane default. */
  model?: string;
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
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JudgmentRow {
  id: string;
  attemptId: string;
  kind: "llm" | "deterministic";
  name: string;
  pass: boolean;
  score: number | null;
  reasoning: string | null;
  raw: string | null;
  createdAt: string;
}

export interface ArtifactRow {
  id: string;
  attemptId: string;
  kind: "transcript" | "task" | "sandbox-log" | "workspace-file" | "meta";
  name: string | null;
  content: string;
  createdAt: string;
}
