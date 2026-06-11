import { configs } from "../configs/index.ts";
import { scenarios } from "../scenarios/index.ts";
import type { Registry } from "./runner/index.ts";
import type { HarnessConfig, Scenario } from "./types.ts";

export function loadRegistry(): Registry {
  return {
    scenarios: new Map(scenarios.map((s) => [s.id, s])),
    configs: new Map(configs.map((c) => [c.id, c])),
  };
}

/** JSON-safe scenario shape for the API/UI (check functions become names). */
export interface SerializedScenario {
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

export function serializeScenario(s: Scenario): SerializedScenario {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    tasks: s.tasks.map((t) => ({ title: t.title, description: t.description })),
    seed: s.seed?.exec?.length ? { exec: s.seed.exec } : null,
    timeoutMs: s.timeoutMs ?? 10 * 60 * 1000,
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
      passThreshold: s.outcome.passThreshold ?? 0.7,
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
  };
}
