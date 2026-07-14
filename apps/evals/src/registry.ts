import { getAaForConfig } from "../configs/aa.ts";
import { configs } from "../configs/index.ts";
import { scenarios } from "../scenarios/index.ts";
import { normalizeOutcome } from "./normalize-outcome.ts";
import type { Registry } from "./runner/index.ts";
import { findDependencyCycles } from "./runner/topo.ts";
import {
  type CoreDimension,
  type DimensionSpec,
  type HarnessConfig,
  type Scenario,
  scenarioWorkerCount,
  type WorkerSpec,
} from "./types.ts";

const MAX_WORKERS = 3;
/**
 * Canonical dimension names (v8.0). Custom dimension names are allowed
 * (warn-only — never an error); this set is the source of truth for "is this a
 * core dimension" used by validation messaging and downstream UI/analytics.
 */
export const CORE_DIMENSIONS = new Set<CoreDimension>([
  "correctness",
  "completeness",
  "efficiency",
  "instruction-following",
  "communication",
]);
/**
 * Env keys the boot path owns — WorkerSpec.env may never override them
 * (v7 §9/§12). TEMPLATE_ID / AGENT_NAME / SYSTEM_PROMPT* are reserved too:
 * they are SET FROM the spec's typed fields (template/name/systemPrompt).
 */
export const WORKER_SPEC_RESERVED_ENV = new Set([
  "API_KEY",
  "AGENT_SWARM_API_KEY",
  "MCP_BASE_URL",
  "AGENT_ROLE",
  "AGENT_ID",
  "HARNESS_PROVIDER",
  "MODEL_OVERRIDE",
  "MAX_CONCURRENT_TASKS",
  "YOLO",
  "DESPLEGA_TELEMETRY_ENV",
  "HOME",
  "PATH",
  "TEMPLATE_ID",
  "TEMPLATE_REGISTRY_URL",
  "AGENT_NAME",
  "SYSTEM_PROMPT",
  "SYSTEM_PROMPT_FILE",
]);
const TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_SEED_MEMORIES = 16;
/** Bare filename, no path separators — prevents traversal out of evals/scenarios/fixtures/. */
const SQL_DUMP_NAME_RE = /^[A-Za-z0-9._-]+\.sql$/;

const CONFIG_IDS = new Set(configs.map((c) => c.id));

/** Shared member-spec rules (v7 §9/§12) for workers[] entries AND the lead. */
function validateWorkerSpec(
  spec: WorkerSpec,
  label: string,
  names: Set<string>,
  errors: string[],
): void {
  if (spec.template !== undefined && !TEMPLATE_SLUG_RE.test(spec.template)) {
    errors.push(`${label}.template "${spec.template}" must match ${TEMPLATE_SLUG_RE}`);
  }
  if (spec.name !== undefined) {
    if (spec.name.trim().length === 0) {
      errors.push(`${label}.name must be non-empty when present`);
    } else if (names.has(spec.name)) {
      errors.push(`${label}.name "${spec.name}" duplicates another member's name`);
    }
    names.add(spec.name);
  }
  if (spec.configId !== undefined && !CONFIG_IDS.has(spec.configId)) {
    errors.push(`${label}.configId "${spec.configId}" is not in the config catalog`);
  }
  if (spec.model !== undefined && spec.model.trim().length === 0) {
    errors.push(`${label}.model must be non-empty when present`);
  }
  for (const key of Object.keys(spec.env ?? {})) {
    if (!ENV_KEY_RE.test(key)) {
      errors.push(`${label}.env key "${key}" must match ${ENV_KEY_RE}`);
    } else if (WORKER_SPEC_RESERVED_ENV.has(key)) {
      errors.push(`${label}.env key "${key}" is reserved by the boot path`);
    }
  }
}

/**
 * True for the DETERMINISTIC efficiency dimension (v8.0 §5): a dimension named
 * `efficiency` with no graded checks and no judge. This shape is scored by the
 * runner from the attempt's REAL cost/duration vs the scenario budget (see
 * `isDeterministicEfficiencyDimension` in runner/index.ts), so — unlike every
 * other dimension — it is ALLOWED to omit checks/judge. The validator still
 * requires the scenario to set at least one budget (budgetUsd/budgetMs); without
 * a budget the runner re-normalizes it out entirely and it is a silent no-op.
 */
function isDeterministicEfficiencyDimension(dim: DimensionSpec): boolean {
  return dim.name === "efficiency" && (dim.checks?.length ?? 0) === 0 && dim.judge === undefined;
}

/**
 * OutcomeSpec v2 dimension validation (v8.0). Each DimensionSpec must carry a
 * positive weight and EXACTLY ONE source of truth — deterministic checks XOR a
 * judge, never both (round 11: the runner short-circuits on checks, so a judge
 * set alongside checks would be DEAD; the XOR contract makes that authoring
 * mistake a load-time error instead of a silent no-op). Dimension names are
 * unique within a scenario; core names are validated, custom strings allowed
 * (warn-only — not pushed as errors); per-check weights (when present) must be
 * > 0; the total dimension weight must be > 0 (avoids divide-by-zero in the
 * Phase 3 aggregation). The one exception to the checks/judge requirement is the
 * deterministic `efficiency` dimension (v8.0 §5), which is scored by the runner
 * from the attempt's real cost/time vs a scenario budget — `hasBudget` says
 * whether the scenario set budgetUsd/budgetMs to back it.
 */
function validateDimensions(
  dimensions: DimensionSpec[],
  hasBudget: boolean,
  errors: string[],
): void {
  const names = new Set<string>();
  let totalWeight = 0;
  dimensions.forEach((dim, i) => {
    const label = `outcome.dimensions[${i}] ("${dim.name}")`;
    if (typeof dim.name !== "string" || dim.name.trim().length === 0) {
      errors.push(`${label}: name must be a non-empty string`);
    } else if (names.has(dim.name)) {
      errors.push(`${label}: dimension name "${dim.name}" is duplicated`);
    }
    names.add(dim.name);
    // Core names (CORE_DIMENSIONS) are the canonical set; custom names (e.g.
    // "retrieval-fidelity", "provenance") are allowed by design and never
    // rejected. Validation only enforces structure (weight/sources/uniqueness),
    // so a non-core name produces no error.
    if (!(dim.weight > 0)) {
      errors.push(`${label}: weight must be > 0, got ${dim.weight}`);
    } else {
      totalWeight += dim.weight;
    }
    const hasChecks = (dim.checks?.length ?? 0) > 0;
    if (isDeterministicEfficiencyDimension(dim)) {
      // Deterministic efficiency (v8.0 §5): checks/judge are intentionally
      // omitted; the runner scores it from real cost/time. It MUST be backed by a
      // budget, else it is silently re-normalized out and the weight is dead.
      if (!hasBudget) {
        errors.push(
          `${label}: deterministic efficiency dimension requires scenario.budgetUsd or budgetMs`,
        );
      }
    } else if (!hasChecks && dim.judge === undefined) {
      errors.push(`${label}: must define at least one of checks/judge`);
    } else if (hasChecks && dim.judge !== undefined) {
      // XOR (round 11): a dimension is fed by deterministic checks OR a judge,
      // never both. The runner short-circuits on checks, so a co-set judge would
      // never run. Split such a dimension into a check-fed dimension and a
      // judge-only dimension. (The efficiency exemption above never reaches here.)
      errors.push(
        `${label}: a dimension must define EITHER checks OR a judge, not both ` +
          `(the runner scores from checks and the judge would be dead — split into two dimensions)`,
      );
    }
    for (const check of dim.checks ?? []) {
      if (check.weight !== undefined && !(check.weight > 0)) {
        errors.push(
          `${label}: check "${check.name}" weight must be > 0 when present, got ${check.weight}`,
        );
      }
    }
  });
  if (dimensions.length > 0 && !(totalWeight > 0)) {
    errors.push("outcome.dimensions total weight must be > 0");
  }
}

/**
 * Scenario shape validation (v6 §0.11 + v7 §9/§12; dependsOn relaxed in
 * round 10 — forward refs legal, whole-graph cycle check instead of the
 * strictly-earlier-index rule). Returns human-readable violations; empty
 * array = valid. File existence/content of `seed.sqlDump` is validated later,
 * host-side in the runner, so a missing fixture breaks one attempt — not the
 * whole registry.
 */
export function validateScenario(s: Scenario): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  if (Array.isArray(s.workers)) {
    // WorkerSpec[] shape (v7 §9): 1..MAX entries; identity/env rules per spec.
    if (s.workers.length < 1 || s.workers.length > MAX_WORKERS) {
      errors.push(`workers array must have 1..${MAX_WORKERS} entries, got ${s.workers.length}`);
    }
    s.workers.forEach((spec: WorkerSpec, i) => {
      validateWorkerSpec(spec, `workers[${i}]`, names, errors);
    });
  } else if (
    s.workers !== undefined &&
    (!Number.isInteger(s.workers) || s.workers < 1 || s.workers > MAX_WORKERS)
  ) {
    errors.push(`workers must be an integer in [1, ${MAX_WORKERS}], got ${s.workers}`);
  }
  // Lead (v7 §12): one extra member, outside the worker cap; same spec rules.
  if (s.lead !== undefined) validateWorkerSpec(s.lead, "lead", names, errors);
  const workers = Math.max(1, scenarioWorkerCount(s.workers));
  s.tasks.forEach((task, i) => {
    if (task.worker === "lead") {
      if (s.lead === undefined) {
        errors.push(`task ${i} ("${task.title}"): worker "lead" requires scenario.lead`);
      }
    } else if (
      task.worker !== undefined &&
      (!Number.isInteger(task.worker) || task.worker < 0 || task.worker >= workers)
    ) {
      errors.push(
        `task ${i} ("${task.title}"): worker ${task.worker} out of range [0, ${workers - 1}]`,
      );
    }
    if (task.dependsOn !== undefined) {
      const seen = new Set<number>();
      for (const dep of task.dependsOn) {
        if (!Number.isInteger(dep)) {
          errors.push(`task ${i} ("${task.title}"): dependsOn entry ${dep} is not an integer`);
          continue;
        }
        // Round 10: forward references are LEGAL — any existing index works.
        // Acyclicity moves to the whole-graph check below.
        if (dep === i) {
          errors.push(`task ${i} ("${task.title}"): dependsOn entry ${dep} is a self-dependency`);
        } else if (dep < 0 || dep >= s.tasks.length) {
          errors.push(
            `task ${i} ("${task.title}"): dependsOn entry ${dep} must reference an existing task index [0, ${s.tasks.length - 1}]`,
          );
        }
        if (seen.has(dep)) {
          errors.push(`task ${i} ("${task.title}"): duplicate dependsOn entry ${dep}`);
        }
        seen.add(dep);
      }
    }
  });
  // Whole-graph cycle detection (round 10): with forward refs legal, cycles
  // are possible — name each offending chain with indices + titles so the
  // load-time failure points straight at the bad scenario edges.
  for (const chain of findDependencyCycles(s.tasks)) {
    errors.push(
      `dependency cycle: ${chain.map((j) => `${j} ("${s.tasks[j]?.title}")`).join(" → ")}`,
    );
  }
  if (s.seed?.sqlDump !== undefined && !SQL_DUMP_NAME_RE.test(s.seed.sqlDump)) {
    errors.push(
      `seed.sqlDump "${s.seed.sqlDump}" must be a bare filename ending in .sql (no path separators)`,
    );
  }
  if (s.seed?.memories !== undefined) {
    if (s.seed.memories.length > MAX_SEED_MEMORIES) {
      errors.push(`seed.memories has ${s.seed.memories.length} entries (max ${MAX_SEED_MEMORIES})`);
    }
    s.seed.memories.forEach((memory, i) => {
      if (typeof memory !== "string" || memory.trim().length === 0) {
        errors.push(`seed.memories[${i}] must be a non-empty string`);
      }
    });
  }
  // OutcomeSpec v2 (v8.0): weighted graded dimensions.
  if (s.outcome.dimensions !== undefined) {
    const hasBudget = s.budgetUsd !== undefined || s.budgetMs !== undefined;
    validateDimensions(s.outcome.dimensions, hasBudget, errors);
  }
  // Efficiency-dimension budgets (v8.0 §5): positive when present.
  if (s.budgetUsd !== undefined && !(s.budgetUsd > 0)) {
    errors.push(`budgetUsd must be > 0 when present, got ${s.budgetUsd}`);
  }
  if (s.budgetMs !== undefined && !(s.budgetMs > 0)) {
    errors.push(`budgetMs must be > 0 when present, got ${s.budgetMs}`);
  }
  return errors;
}

/** Fail fast at CLI/server startup: aggregate every violation across all scenarios. */
export function loadRegistry(): Registry {
  const violations: string[] = [];
  for (const scenario of scenarios) {
    for (const error of validateScenario(scenario)) {
      violations.push(`scenario "${scenario.id}": ${error}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `invalid scenario definitions:\n${violations.map((v) => `  - ${v}`).join("\n")}`,
    );
  }
  return {
    scenarios: new Map(scenarios.map((s) => [s.id, s])),
    configs: new Map(configs.map((c) => [c.id, c])),
  };
}

/** JSON-safe member spec (v7 §9/§12) — env VALUES stay out, keys only. */
export interface SerializedWorkerSpec {
  template: string | null;
  name: string | null;
  systemPrompt: string | null;
  configId: string | null;
  model: string | null;
  envKeys: string[];
}

/**
 * JSON-safe scenario shape for the API/UI (check functions become names).
 * v4 — v6 §0.10 + v7 §9 (`workerSpecs`) + v7 §12 (`lead`, member overrides).
 */
export interface SerializedScenario {
  id: string;
  name: string;
  description: string | null;
  /** Worker COUNT for either Scenario.workers shape (back-compat). */
  workers: number;
  /** Null when the scenario uses the numeric (homogeneous) shape. */
  workerSpecs: SerializedWorkerSpec[] | null;
  /** Null when the scenario defines no lead (v7 §12). */
  lead: SerializedWorkerSpec | null;
  tasks: {
    title: string;
    description: string;
    worker: number | "lead";
    dependsOn: number[];
    outputSchema?: Record<string, unknown>;
  }[];
  seed: { exec: string[]; sqlDump: string | null; memories: string[] } | null;
  timeoutMs: number;
  /** v8.0 §5: cost budget (USD) for the deterministic efficiency dimension; null when unset. */
  budgetUsd: number | null;
  /** v8.0 §5: wall-clock budget (ms) for the deterministic efficiency dimension; null when unset. */
  budgetMs: number | null;
  outcome: {
    checks: string[];
    llmJudge: { rubric: string; model: string | null } | null;
    agenticJudge: { rubric: string; model: string | null; maxSteps: number | null } | null;
    passThreshold: number;
    /** v8.0 OutcomeSpec v2: gate check names (after normalization). */
    gates: string[];
    /** v8.0 OutcomeSpec v2: weighted graded dimensions (after normalization). */
    dimensions: { name: string; weight: number; checks: string[]; judge: boolean }[];
  };
}

function serializeWorkerSpec(w: WorkerSpec): SerializedWorkerSpec {
  return {
    template: w.template ?? null,
    name: w.name ?? null,
    systemPrompt: w.systemPrompt ?? null,
    configId: w.configId ?? null,
    model: w.model ?? null,
    envKeys: Object.keys(w.env ?? {}),
  };
}

export function serializeScenario(s: Scenario): SerializedScenario {
  const hasSeed = Boolean(s.seed?.exec?.length || s.seed?.sqlDump || s.seed?.memories?.length);
  // v8.0: serialize gates/dimensions from the NORMALIZED outcome so the UI sees
  // a consistent view regardless of v1/v2 authoring. The synthetic
  // "tasks-completed" prepend on `checks` stays (the runner injects it).
  const normalized = normalizeOutcome(s.outcome);
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    workers: scenarioWorkerCount(s.workers),
    workerSpecs: Array.isArray(s.workers) ? s.workers.map(serializeWorkerSpec) : null,
    lead: s.lead ? serializeWorkerSpec(s.lead) : null,
    tasks: s.tasks.map((t) => ({
      title: t.title,
      description: t.description,
      worker: t.worker ?? 0,
      dependsOn: t.dependsOn ?? [],
      outputSchema: t.outputSchema,
    })),
    seed: hasSeed
      ? {
          exec: s.seed?.exec ?? [],
          sqlDump: s.seed?.sqlDump ?? null,
          memories: s.seed?.memories ?? [],
        }
      : null,
    timeoutMs: s.timeoutMs ?? 10 * 60 * 1000,
    budgetUsd: s.budgetUsd ?? null,
    budgetMs: s.budgetMs ?? null,
    outcome: {
      checks: ["tasks-completed", ...(s.outcome.checks ?? []).map((c) => c.name)],
      llmJudge: s.outcome.llmJudge
        ? { rubric: s.outcome.llmJudge.rubric, model: s.outcome.llmJudge.model ?? null }
        : null,
      agenticJudge: s.outcome.agenticJudge
        ? {
            rubric: s.outcome.agenticJudge.rubric,
            model: s.outcome.agenticJudge.model ?? null,
            maxSteps: s.outcome.agenticJudge.maxSteps ?? null,
          }
        : null,
      passThreshold: normalized.passThreshold,
      gates: normalized.gates.map((g) => g.name),
      dimensions: normalized.dimensions.map((d) => ({
        name: d.name,
        weight: d.weight,
        checks: (d.checks ?? []).map((c) => c.name),
        judge: d.judge !== undefined,
      })),
    },
  };
}

/** JSON-safe config shape — env values stay out (they can carry credentials). */
export function serializeConfig(c: HarnessConfig) {
  return {
    id: c.id,
    label: c.label ?? null,
    provider: c.provider,
    model: c.model ?? null,
    modelTier: c.modelTier ?? null,
    envKeys: c.env ? Object.keys(c.env) : [],
    /** v7.6 item D: AA benchmark block; null = unmatched (UI renders nothing). */
    aa: getAaForConfig(c.id),
  };
}
