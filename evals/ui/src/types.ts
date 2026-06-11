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
  tokens: TokenTotalsJson | null;
  sandbox: SandboxInfoJson | null;
  timings: PhaseTimingsJson | null;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
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

export interface RunListItem {
  run: RunJson;
  cells: CellJson[];
  totals: TotalsJson;
  active: boolean;
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
