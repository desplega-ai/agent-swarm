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

/**
 * Artificial Analysis benchmark block for one catalog config (v7.6 item D —
 * FROZEN shape). Source of record: evals/configs/aa-benchmarks-2026-06-12.tsv
 * (transcribed from artificialanalysis.ai). Lives in a sibling module
 * (evals/configs/aa.ts) keyed by config id — HarnessConfig itself stays
 * untouched; serializeConfig() merges `aa` into the /api/configs payload.
 * Unmatched configs simply have no entry (UI renders nothing).
 *
 * Parse rules (frozen): TSV cell "--" → null; a numeric cell with a trailing
 * "*" (e.g. "35*") keeps the number and sets `provisional: true` on the block;
 * contextWindow/creator stay raw display strings ("1M", "922k"). "(variant 2)"
 * suffixes mark the lower-intelligence-index duplicate of an AA reasoning /
 * non-reasoning pair — `sourceRow` is the exact TSV `model` cell incl. any
 * such suffix, and `matchedVariant` documents WHY that row matches how the
 * eval harness actually runs the model.
 */
export interface AaBenchmark {
  /** Exact TSV `model` cell this config maps to (incl. "(variant 2)" suffixes). */
  sourceRow: string;
  /** Variant-choice note ("max — Claude Code thinking on by default", …); null when the row has no variants. */
  matchedVariant: string | null;
  /** Raw context-window display string ("1M", "922k", "256k"); null when "--". */
  contextWindow: string | null;
  creator: string | null;
  intelligenceIndex: number | null;
  blendedUsdPer1M: number | null;
  medianTokensPerS: number | null;
  latencyFirstChunkS: number | null;
  totalResponseS: number | null;
  /** True when any numeric cell carried the trailing-"*" provisional marker. */
  provisional: boolean;
}

/**
 * Named quick-run config set (v7.7 item 1 — FROZEN shape). Definitions live in
 * evals/configs/presets.ts (`CONFIG_PRESETS`, display order); served verbatim
 * as GET /api/presets. Registry test enforces: ids unique, configIds non-empty,
 * and every configIds entry resolves in the catalog. CLI `--preset <id>`
 * (repeatable) expands to config ids — union with explicit `--configs`, deduped
 * keeping first occurrence, presets first in flag order. UI preset buttons
 * REPLACE the new-run selection (same semantics as the frozen "Defaults" chip).
 */
export interface ConfigPreset {
  /** Stable slug used by `--preset` and the UI buttons ("frontier"). */
  id: string;
  /** Button caption ("Frontier"). */
  label: string;
  /** One-line blurb for the button tooltip. */
  description: string;
  /** Catalog config ids (HarnessConfig.id); every entry must resolve. */
  configIds: string[];
}

export interface TaskSpec {
  title: string;
  description: string;
  /**
   * Index of the worker this task is assigned to. Default 0. Must be
   * < the scenario's worker count. `"lead"` (v7 §12) creates the task WITHOUT
   * an agentId — the swarm API routes unassigned tasks to the lead agent
   * (src/http/tasks.ts: getLeadAgent() default) — and requires Scenario.lead.
   */
  worker?: number | "lead";
  /**
   * Indices of tasks this task depends on (native swarm-API dependsOn, v6 §9).
   * Round 10: any existing task index works — forward references included.
   * validateScenario rejects self-references, out-of-range/duplicate entries,
   * and dependency cycles (whole-graph check) at load time; the runner
   * topo-sorts creation order (evals/src/runner/topo.ts).
   * Absent/empty = no dependencies.
   */
  dependsOn?: number[];
  /** Optional structured-output schema forwarded to the swarm task. */
  outputSchema?: Record<string, unknown>;
}

export interface ScenarioSeed {
  /** Shell commands run inside worker 0's sandbox after the stack is healthy. */
  exec?: string[];
  /** Memories indexed into the swarm API (scope "swarm") before tasks start. */
  memories?: string[];
  /**
   * Filename of an INSERT-only SQL seed under evals/scenarios/fixtures/, applied
   * to the API sandbox DB BEFORE the API server first boots — after the schema is
   * built pre-boot from the real migrations (see bootStack in swarm/sandbox.ts).
   * Bare filename only (no path separators), must end in ".sql".
   * Example: "delegation-probe-history.sql".
   */
  sqlDump?: string;
  /**
   * Failure-injection primitive (swarm-mechanics evals): deterministically break
   * a CHOSEN worker (not just worker 0) at seed time so the scenario can grade
   * whether the SWARM recovers from a poisoned/disabled teammate.
   *
   * Each entry runs its shell `commands` in `workers[entry.worker]`'s sandbox
   * AFTER `exec` (and after memory indexing) but BEFORE any task is created —
   * to corrupt/poison/disable that worker, e.g. delete a required input file,
   * write a confidently-wrong intermediate result, or remove a needed CLI.
   *
   * CRUCIAL SEMANTIC DIFFERENCE FROM {@link exec}: these are BEST-EFFORT. A
   * non-zero exit (or even an exec error) MUST NOT throw/fail the attempt — the
   * whole point is to LEAVE the worker broken and let the swarm cope. Every
   * command's outcome is logged; an out-of-range `worker` index is skipped (and
   * logged), never thrown. Absent/empty `workerFailures` => zero behavior change.
   */
  workerFailures?: {
    /** 0-based index into the scenario's booted workers; out-of-range is skipped + logged. */
    worker: number;
    /** Shell commands run (in order) in that worker's sandbox; non-zero exits are tolerated. */
    commands: string[];
    /** Optional human label for logs/artifacts ("delete-input", "poison-result"). */
    label?: string;
  }[];
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
  /**
   * Graded value in [0,1] (v8.0 OutcomeSpec v2). When omitted, scoring falls
   * back to the binary `pass` (1 when pass, else 0). A graded check that feeds
   * a weighted dimension sets this to report partial credit.
   */
  score?: number;
}

/** Deterministic check, run against the live attempt context after tasks finish. */
export interface DeterministicCheck {
  name: string;
  fn: (ctx: JudgeContext) => Promise<CheckResult>;
  /**
   * Per-check weight within a dimension's graded checks (v8.0). Default 1.
   * Ignored for gates (binary must-pass — weight is meaningless there).
   */
  weight?: number;
}

/**
 * The five canonical scoring dimensions (v8.0 OutcomeSpec v2). Core names are
 * validated against this set; custom dimension names are allowed (warn-only).
 */
export type CoreDimension =
  | "correctness"
  | "completeness"
  | "efficiency"
  | "instruction-following"
  | "communication";

/** A dimension name: a {@link CoreDimension} or any custom string (core validated, custom allowed). */
export type DimensionName = CoreDimension | (string & {});

/** Judge sub-spec feeding a single weighted dimension (v8.0). */
export interface JudgeSubSpec {
  /** Rubric describing what a successful outcome looks like for this dimension. */
  rubric: string;
  /** OpenRouter model id; defaults to the run's judgeModel, then EVAL_JUDGE_MODEL. */
  model?: string;
  /** When true, the dimension is graded by the agentic (tool-loop) judge. */
  agentic?: boolean;
  /** Max agentic-judge steps before forcing a verdict (agentic only). Default 10. */
  maxSteps?: number;
}

/**
 * One weighted, graded dimension of an outcome (v8.0 OutcomeSpec v2). The
 * dimension's 0-1 sub-score comes from graded {@link checks} (weighted mean) OR
 * a {@link judge} rubric. At least one of `checks`/`judge` is required
 * (enforced in validateScenario). The final attempt score is
 * `Σ wᵢ·dimᵢ / Σ wᵢ` over all dimensions.
 */
export interface DimensionSpec {
  name: DimensionName;
  /** Dimension weight in the aggregate; must be > 0 (validated). */
  weight: number;
  /** Graded checks feeding this dimension (weighted mean of per-check values). */
  checks?: DeterministicCheck[];
  /** OR a judge rubric grading this dimension. */
  judge?: JudgeSubSpec;
}

export interface OutcomeSpec {
  // ---- v1 (kept; normalized to v2 internally) ----
  llmJudge?: LlmJudgeSpec;
  agenticJudge?: AgenticJudgeSpec;
  checks?: DeterministicCheck[];
  /**
   * Minimum aggregate score in [0,1] to count as pass. Default
   * DEFAULT_PASS_THRESHOLD (0.75). In v2 this gates the WEIGHTED AGGREGATE, not
   * each judge individually.
   */
  passThreshold?: number;
  // ---- v2 (gates + weighted graded dimensions) ----
  /** Binary must-pass checks (v8.0). A failed gate forces `passed = false`. */
  gates?: DeterministicCheck[];
  /** Weighted graded dimensions (v8.0). */
  dimensions?: DimensionSpec[];
}

/**
 * Canonical v2 dimension after normalization (v8.0). Either `checks` or `judge`
 * is populated (a normalized dimension always has at least one source). Custom
 * names survive normalization unchanged.
 */
export interface NormalizedDimension {
  name: DimensionName;
  weight: number;
  checks?: DeterministicCheck[];
  judge?: JudgeSubSpec;
}

/**
 * Canonical v2 outcome (v8.0): the shape the runner aggregates against. Any v1
 * spec (checks/llmJudge/agenticJudge/passThreshold) maps onto this via
 * {@link import("./normalize-outcome.ts").normalizeOutcome}; native-v2 specs
 * pass through. `gates` are binary must-pass; `dimensions` are weighted/graded.
 * `tasksCompletedCheck` is NOT prepended here — that stays the runner's job so
 * it applies uniformly to v1 and v2.
 */
export interface NormalizedOutcome {
  gates: DeterministicCheck[];
  dimensions: NormalizedDimension[];
  passThreshold: number;
}

/**
 * One configured roster member of a scenario (v7 §9 + §12 — FROZEN). A spec
 * shapes the agent's identity via the worker-entrypoint env contract:
 *   template     → TEMPLATE_ID   (registry slug, e.g. "coder", "researcher";
 *                  fetched from TEMPLATE_REGISTRY_URL, applies agentDefaults:
 *                  role, capabilities, maxTasks + identity files)
 *   name         → AGENT_NAME    (registered agent name; precedence over the
 *                  template displayName and the worker-<idx> fallback)
 *   systemPrompt → SYSTEM_PROMPT (extra system prompt appended to the base)
 *   env          → merged LAST over config.env (validated; see validateScenario)
 *
 * Heterogeneous rosters (v7 §12): a member may override the matrix cell's
 * HarnessConfig. Frozen resolution rule:
 *   base   = configId ? catalog[configId] : the cell's config
 *   model  = spec.model ?? base.model      (provider always = base.provider)
 * The member's sandbox env (HARNESS_PROVIDER / MODEL_OVERRIDE / provider
 * credentials) is built from the EFFECTIVE config — credential isolation stays
 * per-sandbox, so members spanning providers never see each other's keys. The
 * cell config remains the run's primary axis; overridden members are labeled
 * as overrides in UI/analytics, and their cost/token attribution follows the
 * ACTUAL model each member ran.
 */
export interface WorkerSpec {
  template?: string;
  name?: string;
  systemPrompt?: string;
  /** Catalog config id this member runs INSTEAD of the cell's config (v7 §12). */
  configId?: string;
  /** Model override applied on top of the member's base config (v7 §12). */
  model?: string;
  /** Reserved runtime keys (AGENT_ID, API_KEY, HARNESS_PROVIDER, …) are rejected. */
  env?: Record<string, string>;
}

export interface Scenario {
  /** Stable slug, e.g. "memory-seeded-recall". */
  id: string;
  name: string;
  description?: string;
  seed?: ScenarioSeed;
  /** Initial task(s) created against the worker under test. */
  tasks: TaskSpec[];
  outcome: OutcomeSpec;
  /** Per-attempt wall clock budget. Default 10 minutes. */
  timeoutMs?: number;
  /**
   * Cost budget in USD for the deterministic `efficiency` dimension (v8.0 §5).
   * When set (> 0, validated), an `efficiency` dimension with no checks/judge is
   * scored 1.0 at observed cost ≤ budget, decaying linearly to 0 at N× budget
   * ({@link import("./scoring.ts").EFFICIENCY_DECAY_FACTOR}). Unpriced attempts
   * (costUsd null) drop the cost sub-score (re-normalized out — never scored 0).
   */
  budgetUsd?: number;
  /**
   * Wall-clock budget in ms for the deterministic `efficiency` dimension
   * (v8.0 §5). Same decay mapping as {@link budgetUsd}. When BOTH budgets are
   * set, the efficiency sub-score is MIN(costScore, timeScore) (worst-case
   * discipline).
   */
  budgetMs?: number;
  /**
   * Workers booted per attempt. Number = N homogeneous default workers
   * (back-compat); WorkerSpec[] = one configured worker per entry (v7 §9).
   * Default 1. Max 3 either way.
   */
  workers?: number | WorkerSpec[];
  /**
   * Optional LEAD agent (v7 §12): boots one extra sandbox with AGENT_ROLE=lead
   * (registers isLead via the worker entrypoint). Tasks with `worker: "lead"`
   * are created WITHOUT an agentId and the swarm routes them to the lead —
   * the lead-driven orchestration entry point. Cost/log/roster capture treat
   * the lead like any member. The lead does NOT count toward the 3-worker cap.
   */
  lead?: WorkerSpec;
}

/** Worker count for either `Scenario.workers` shape (v7 §9). */
export function scenarioWorkerCount(workers: Scenario["workers"]): number {
  if (workers === undefined) return 1;
  return Array.isArray(workers) ? workers.length : workers;
}

/** Per-index WorkerSpec for either shape (numeric shape = default specs). */
export function scenarioWorkerSpec(workers: Scenario["workers"], index: number): WorkerSpec {
  if (Array.isArray(workers)) return workers[index] ?? {};
  return {};
}

/** Per-worker sandbox access exposed to judges (multi-worker v1, v6 §0.8). */
export interface JudgeWorkerContext {
  index: number;
  agentId: string;
  exec: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile: (path: string) => Promise<string | null>;
  /**
   * Roster metadata (v8.0 §4) — populated from the boot member so the agentic
   * judge can render a manifest and attribute "who said what". All optional for
   * back-compat (pre-v8 ctxWorkers and bare test fixtures omit them).
   */
  name?: string;
  template?: string;
  role?: "lead" | "worker";
  isLead?: boolean;
}

/** What judges can see: the swarm API of the attempt's stack + sandbox access. */
export interface JudgeContext {
  /** Completed task records as returned by the swarm API. */
  tasks: SwarmTask[];
  /** Flattened transcript/session-log text for the worker under test. */
  transcript: string;
  /** Run a shell command inside worker 0's sandbox (alias of workers[0].exec). */
  exec: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Read a file from worker 0's sandbox (alias of workers[0].readFile); null when missing. */
  readFile: (path: string) => Promise<string | null>;
  /** Raw authenticated GET against the attempt's swarm API. */
  apiGet: (path: string) => Promise<unknown>;
  /** One entry per booted worker, ascending index. */
  workers: JudgeWorkerContext[];
}

/**
 * Matches root src/be/db.ts cascadeFailDependents(): `Blocked dependency <uuid8> was <status>`.
 * Applied to task.failureReason when status === "failed" to classify cascade-failed
 * dependents as "skipped" (v6 §0.12 — FROZEN; the UI duplicates this source string).
 */
export const CASCADE_SKIP_RE = /^Blocked dependency [0-9a-f]{8} was /;

/** Minimal shape of a swarm task as the eval system consumes it. */
export interface SwarmTask {
  id: string;
  title: string;
  description: string;
  status: string;
  result?: string | null;
  assignedAgentId?: string | null;
  /** Server-populated on failed tasks. */
  failureReason?: string | null;
  /** Runner-computed: status === "failed" && CASCADE_SKIP_RE.test(failureReason ?? ""). */
  skipped?: boolean;
  /**
   * Runner-tagged at artifact-serialization time (display-only — scoring never
   * reads this): "run" = real run activity (upfront / run-agent-attributed),
   * "seed" = pre-existing scenario reference-data the swarm DB carried in. Absent
   * on pre-tag artifacts; consumers must default a missing value to "run".
   */
  origin?: "run" | "seed";
  [key: string]: unknown;
}

// ---- per-task records (v7.5 items 2/5/6 — FROZEN) ----

/**
 * One normalized per-task record served by GET /api/attempts/:id/tasks
 * (v7.5 items 2/5/6 — FROZEN). Sources, in precedence order:
 *   "live"           — fetched from the attempt's still-running stack
 *                      (?live=1 only; costUsd/tokens are ALWAYS null here);
 *   "tasks-artifact" — parsed from the stored tasks.json artifact (kind
 *                      "task"), joined with the session-costs.json artifact
 *                      for per-task cost/tokens;
 *   "task-ids"       — attempt.taskIds only (no artifact yet / v1-era rows):
 *                      one record per id with all-null fields.
 * Ordering: attempt.taskIds creation order first, then artifact-only extras
 * in artifact order. Every field degrades to null/[]/false — old rows never
 * break (back-compat is sacred).
 */
export interface AttemptTaskRecord {
  id: string;
  /** Normalized title; null when empty/absent. */
  title: string | null;
  /** Swarm task status string; null when unknown ("task-ids" source). */
  status: string | null;
  /** Final result/output text, server-clipped to 4000 chars; null when absent. */
  outcome: string | null;
  /** failureReason, server-clipped to 4000 chars; null when absent. */
  error: string | null;
  /** Cascade-skip (stored `skipped` flag, else CASCADE_SKIP_RE on failureReason). */
  skipped: boolean;
  /** Task UUIDs this task depended on (native swarm dependsOn); [] when none/unknown. */
  dependsOn: string[];
  /** Assigned agent id; null when unknown. */
  agentId: string | null;
  /**
   * Run-vs-seed classification (display-only — scoring never reads this). "run" =
   * real run activity; "seed" = pre-existing scenario reference-data the swarm DB
   * carried in (runner-tagged on the tasks.json artifact). Defaults to "run" on
   * the live / task-ids sources and on pre-tag artifacts (the run-only contract).
   */
  origin: "run" | "seed";
  /**
   * Σ totalCostUsd over this task's PRICED session-cost rows (same rule as the
   * round-7 per-member roster attribution); null when 0 priced rows, when the
   * session-costs.json artifact is missing (v1-era), or on the live source.
   */
  costUsd: number | null;
  /** Field-wise Σ over the task's cost rows; null when rows carry no token data. */
  tokens: TokenTotals | null;
  // ---- v7.7 item 7 amendment (FROZEN): task economics for the sub-tab chips.
  // Typed OPTIONAL purely for pre-round-9 payload compatibility — the round-9
  // server ALWAYS populates them (null when unknown). Source of record: the
  // swarm task record's own timestamps (`createdAt` / `finishedAt` on stored
  // tasks.json entries AND live GET /api/tasks/:id payloads — verified present
  // on both; there is NO claimedAt/startedAt on swarm tasks). NOT the runner's
  // PhaseTimings.perTask wait spans (those measure marginal await time, not
  // task lifetime). DAG caveat (documented, accepted): dependents are created
  // upfront, so their span includes dependency-pending time.
  /** Raw task-record `createdAt` ISO string (passed through, never reformatted); null when absent ("task-ids" source, v1-era). */
  createdAt?: string | null;
  /** Raw task-record `finishedAt` ISO string; null while running / when absent. */
  finishedAt?: string | null;
  /**
   * Server-computed `Date.parse(finishedAt) - Date.parse(createdAt)`; null
   * unless BOTH parse to finite numbers and the difference is >= 0.
   */
  durationMs?: number | null;
}

export type AttemptTasksSource = "live" | "tasks-artifact" | "task-ids";

/** Response of GET /api/attempts/:id/tasks (v7.5 — FROZEN). */
export interface AttemptTasksSnapshot {
  /** Null when the attempt has no taskIds and no tasks artifact. */
  source: AttemptTasksSource | null;
  /** True when records were fetched fresh from the live stack (?live=1). */
  live: boolean;
  tasks: AttemptTaskRecord[];
}

/** Structural subset of a swarm session-cost row that cost aggregation reads. */
export interface CostRowTotals {
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  model: string | null;
}

/**
 * Per-task cost/token aggregation (v7.5 item 6 — FROZEN). EXACTLY mirrors the
 * round-7 per-member roster rule (runner buildRosterEntries): costUsd = Σ
 * totalCostUsd over rows with totalCostUsd !== null (null when none priced);
 * tokens = field-wise Σ, null when NO row carries any non-null token column;
 * tokens.model = first non-null row model.
 */
export function aggregateCostRows(rows: CostRowTotals[]): {
  costUsd: number | null;
  tokens: TokenTotals | null;
} {
  const priced = rows.filter((r) => r.totalCostUsd !== null);
  const hasTokenData = rows.some(
    (r) =>
      r.inputTokens !== null ||
      r.outputTokens !== null ||
      r.cacheReadTokens !== null ||
      r.cacheWriteTokens !== null,
  );
  return {
    costUsd: priced.length > 0 ? priced.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0) : null,
    tokens: hasTokenData
      ? {
          model: rows.find((r) => r.model)?.model ?? null,
          inputTokens: rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
          outputTokens: rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
          cacheReadTokens: rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
          cacheWriteTokens: rows.reduce((s, r) => s + (r.cacheWriteTokens ?? 0), 0),
        }
      : null,
  };
}

// ---- default boot identity (v7.5 item 7 — FROZEN) ----

/**
 * Default TEMPLATE_ID for the LEAD member when WorkerSpec.template is unset
 * (v7.5 item 7 — FROZEN). Namespaced form matches production boots
 * (docker-compose.example.yml lead service); the registry route also accepts
 * bare slugs ("lead" → category "official" via parseTemplateId), which is what
 * WorkerSpec.template's frozen bare-slug validation produces.
 */
export const DEFAULT_LEAD_TEMPLATE_ID = "official/lead";

/**
 * Boot identity defaults per member (v7.5 item 7 — FROZEN rule):
 * - LEAD: TEMPLATE_ID defaults to {@link DEFAULT_LEAD_TEMPLATE_ID} (the
 *   official lead profile is what production leads run; its agentDefaults —
 *   role/isLead/maxTasks — are no-ops because the boot env already pins them);
 *   AGENT_NAME defaults to "Lead" (deterministic even when the registry fetch
 *   fails — fetch failure is non-fatal in the worker entrypoint).
 * - WORKER: NO TEMPLATE_ID default. A worker template would inject its
 *   soul/identity/tools/claude markdown into the eval SUBJECT's system prompt,
 *   add capabilities, and execute its setupScript — silently changing eval
 *   behavior/scores across rounds. The `worker-<hash>` name symptom is purely
 *   the entrypoint's `${role}-${agentId.slice(0,8)}` fallback, so the fix is
 *   AGENT_NAME-only: defaults to `Worker <index>` (0-based, matching sandbox
 *   worker indices and the UI's workerLabel()).
 * Applied at env-construction time only (workerRuntimeEnv step 4) — persisted
 * SandboxWorkerInfo.name/agentTemplate keep meaning "what the scenario
 * AUTHORED" (null for defaults); runtime names land in the roster snapshot.
 */
export function defaultMemberIdentity(
  role: "lead" | "worker",
  index: number,
  spec: WorkerSpec,
): { templateId: string | null; agentName: string } {
  return {
    templateId: spec.template ?? (role === "lead" ? DEFAULT_LEAD_TEMPLATE_ID : null),
    agentName: spec.name ?? (role === "lead" ? "Lead" : `Worker ${index}`),
  };
}

export type CostSource = "harness" | "recomputed" | "unpriced";

export interface TokenTotals {
  model: string | null; // dominant concrete model id observed (e.g. "claude-opus-4-7")
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Unified total (v7 §11): input + output + cache read + cache write. */
export function totalTokenCount(t: TokenTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

/**
 * One worker entry of the persisted sandboxJson v2 blob (v6 §0.3 — FROZEN;
 * v7 §9/§12 add the nullable identity + effective-config fields — absent on
 * pre-v7 rows, never required by readers).
 */
export interface SandboxWorkerInfo {
  index: number;
  sandboxId: string;
  template: string;
  agentId: string;
  startedAt: string | null;
  expiresAt: string | null; // sandbox endAt/expiresAt
  /** Worker build version (`agent-swarm version` in this worker's sandbox). Null = not captured. */
  version: string | null;
  /** WorkerSpec.name passed as AGENT_NAME (v7 §9). Null/absent = default worker. */
  name?: string | null;
  /** WorkerSpec.template passed as TEMPLATE_ID (v7 §9) — NOT the E2B template. */
  agentTemplate?: string | null;
  /** "lead" | "worker" (v7 §12). Null/absent (pre-v7 rows) = worker. */
  role?: "lead" | "worker" | null;
  /**
   * EFFECTIVE member config (v7 §12) — populated only when the member
   * overrides the attempt's cell config (configId and/or model differ).
   * Null/absent = the member ran the cell config exactly (readers fall back).
   */
  configId?: string | null;
  provider?: HarnessProvider | null;
  model?: string | null;
}

/**
 * Per-member roster + cost snapshot captured at the END of an attempt
 * (v7 §10/§12 — FROZEN). Persisted as `attempts.workers_json`; null on pre-v7
 * rows (UI falls back to the sandboxJson worker entries). Includes the LEAD
 * (when the scenario defines one) as a member with memberRole "lead".
 */
export interface WorkerRosterEntry {
  /** Member index — joins SandboxWorkerInfo.index (lead = workers.length). */
  index: number;
  /** Boot-time role of this member (v7 §12). */
  memberRole: "lead" | "worker";
  agentId: string;
  sandboxId: string;
  /** From GET /api/agents of the attempt's stack; nulls when the fetch failed. */
  name: string | null;
  /** Free-form profile role from the agents API (template-applied). */
  role: string | null;
  isLead: boolean;
  /** Agent status at roster-capture time (§10.3 status-at-capture); null when unmatched. */
  status: string | null;
  /** Registered harness provider (agents.harnessProvider ?? agents.provider). */
  provider: string | null;
  capabilities: string[];
  maxTasks: number | null;
  lastActivityAt: string | null;
  /** WorkerSpec.template (TEMPLATE_ID) this member booted with. */
  agentTemplate: string | null;
  /**
   * EFFECTIVE member config (v7 §12) — non-null only when the member overrode
   * the attempt's cell config. Mirrors the SandboxWorkerInfo fields.
   */
  configId: string | null;
  model: string | null;
  /** Worker build version (copied from boot capture). */
  version: string | null;
  /** Task ids of this attempt assigned to this member. */
  taskIds: string[];
  /** Σ session-cost USD over this member's tasks; null when none priced. */
  costUsd: number | null;
  /** Σ token usage over this member's tasks' cost rows; null when no rows. */
  tokens: TokenTotals | null;
}

/**
 * Everything known about the attempt's E2B stack — sandboxJson v2, the only
 * shape new code writes (v6 §0.3 — FROZEN). Old DB rows carry the legacy v1
 * flat shape (workerSandboxId/workerAgentId/...); the runner only ever writes
 * this, never reads it back, so the v1/v2 normalization lives UI-side.
 * HARD INVARIANT: `swarmKey` and `apiUrl` stay top-level and unrenamed — the
 * evals API server reads them out of the stored blob for live transcripts.
 * Taras explicitly OK'd storing the swarm API key.
 */
export interface SandboxInfo {
  v: 2;
  apiSandboxId: string;
  apiTemplate: string;
  apiUrl: string;
  swarmKey: string;
  domain: string | null;
  apiStartedAt: string | null;
  /** Swarm API version from the sandbox /health response. Null = not captured. */
  apiVersion: string | null;
  workers: SandboxWorkerInfo[];
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
  /** v7 §10: per-worker roster + cost (`workers_json`). Null on pre-v7 rows. */
  workers?: WorkerRosterEntry[] | null;
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
  /**
   * The scoring dimension this judgment grades (v8.0 OutcomeSpec v2). NULL on
   * gate rows and all pre-v2 rows (gates are binary must-pass, not dimensions).
   */
  dimension: string | null;
  /**
   * Dimension weight in the weighted aggregate (v8.0). NULL on gate rows and
   * all pre-v2 rows.
   */
  weight: number | null;
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

// ---- analytics v2 additions (round 7 — v7 spec §6/§7/§11, FROZEN) ----
// The v7 fields below are typed OPTIONAL purely for compile-staging and old
// cached payloads: the v7 server ALWAYS populates them. Aggregation rules
// mirror §1.3 of v5 (null — never NaN/Infinity — on empty denominators).

/** Σ token usage over a group's token-bearing attempts (v7 §11). */
export interface AnalyticsTokenSums {
  /** Attempts contributing tokens (tokens_json present with totalTokens > 0). */
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
  /** Distinct model keys contributing to the group. */
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
  /** Min/max costUsd over priced attempts; null when 0 priced (v7 §6). */
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
  /** Contributing harness providers (registry; configId-prefix fallback). */
  harnesses: string[];
  attempts: number;
  graded: number;
  passRate: number | null;
  avgScore: number | null;
  avgCostUsd: number | null;
  avgDurationMs: number | null;
  /** x axis: mean total tokens per token-bearing attempt; null → UI omits the point. */
  avgTotalTokens: number | null;
  totalTokens: number;
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
  /** v7 §6: min/max costUsd over priced attempts; null when 0 priced. */
  minCostUsd?: number | null;
  maxCostUsd?: number | null;
  /** v7 §11: token sums over the cell's token-bearing attempts. */
  tokens?: AnalyticsTokenSums | null;
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
  /** First non-null among the cell's attempts, cleanVersion()ed. */
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

/**
 * Global analytics filter (v7.6 §C3 — FROZEN). Applied SERVER-SIDE on
 * GET /api/analytics (query params `harnesses` + `configs`, CSV): the source
 * rows are filtered BEFORE buildAnalytics so every section (matrix, models,
 * series, rollups, scatter, highlights) re-aggregates correctly — per-model /
 * per-vendor aggregates cannot be recomputed client-side from the
 * pre-aggregated cells. Empty array = no filter on that axis. A row is kept
 * iff its configId ∈ configIds (when set) AND its harness key — the §7.1
 * harnessKey() rule (registry provider, configId-prefix fallback) —
 * ∈ harnesses (when set).
 */
export interface AnalyticsFilter {
  harnesses: string[];
  configIds: string[];
}

/**
 * Filter-bar option lists (v7.6 §C3) — distinct harness keys / config ids over
 * ALL source rows BEFORE filtering (first-seen order), so the bar keeps every
 * option visible while a filter is active.
 */
export interface AnalyticsFilterOptions {
  harnesses: string[];
  configIds: string[];
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
  /** v7 §7: rollups by harness provider, sorted by attempts desc. */
  harnesses?: AnalyticsGroupRollup[];
  /** v7 §7: rollups by model vendor, sorted by attempts desc. */
  vendors?: AnalyticsGroupRollup[];
  /** v7 §7/§11: one point per model key (scatter: accuracy vs tokens). */
  scatter?: AnalyticsScatterPoint[];
  /** v7.6 §C3: pre-filter option lists. Optional for old cached payloads; the v7.6 server always fills it. */
  filterOptions?: AnalyticsFilterOptions;
  /** v7.6 §C3: the filter the server applied; null/absent = unfiltered. */
  appliedFilter?: AnalyticsFilter | null;
}

/** Distinct cleaned versions across one run's attempts (runs list, v5 spec §1.5). */
export interface RunVersions {
  api: string[];
  worker: string[];
}
