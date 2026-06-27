/**
 * v1 → v2 OutcomeSpec normalization (v8.0). Pure, no I/O.
 *
 * Maps any authored {@link OutcomeSpec} onto the canonical {@link
 * NormalizedOutcome} shape so all existing v1 authoring keeps working:
 *   - v1 `checks[]`           → `gates[]` (binary must-pass), order preserved.
 *   - v1 `llmJudge`/`agenticJudge` → a single `correctness` dimension weight 1.
 *   - v2 `gates`/`dimensions` → pass through.
 * `passThreshold` resolves to `spec.passThreshold ?? DEFAULT_PASS_THRESHOLD`,
 * and (per the resolved decision) gates the WEIGHTED AGGREGATE — Phase 3
 * implements the gate; this module only resolves the value.
 *
 * NOTE: `tasksCompletedCheck` is NOT prepended here — the runner (Phase 3)
 * prepends it as the first gate so it applies uniformly to v1 and v2 specs.
 */

import { DEFAULT_PASS_THRESHOLD } from "./scoring.ts";
import type { DeterministicCheck, JudgeSubSpec, NormalizedOutcome, OutcomeSpec } from "./types.ts";

export function normalizeOutcome(spec: OutcomeSpec): NormalizedOutcome {
  // Gates: v2 `gates` first, then any v1 `checks` concatenated after (mixing is
  // allowed but discouraged — validateScenario flags the mix). Order preserved.
  const gates: DeterministicCheck[] = [...(spec.gates ?? []), ...(spec.checks ?? [])];

  // Dimensions: native v2 `dimensions` pass through as-is. v1 judges collapse
  // into a single `correctness` dimension weight 1 (only when no v2 dimensions
  // are authored — a mixed spec keeps its explicit dimensions).
  const dimensions = spec.dimensions ? [...spec.dimensions] : v1JudgeDimension(spec);

  return {
    gates,
    dimensions,
    passThreshold: spec.passThreshold ?? DEFAULT_PASS_THRESHOLD,
  };
}

/**
 * Collapse the v1 `llmJudge`/`agenticJudge` pair into one `correctness`
 * dimension (weight 1). If both are set (no current scenario does), prefer the
 * agentic judge. Returns `[]` when neither judge is present.
 */
function v1JudgeDimension(spec: OutcomeSpec): NormalizedOutcome["dimensions"] {
  const agentic = spec.agenticJudge;
  const llm = spec.llmJudge;
  if (!agentic && !llm) return [];

  const judge: JudgeSubSpec = agentic
    ? {
        rubric: agentic.rubric,
        model: agentic.model,
        agentic: true,
        maxSteps: agentic.maxSteps,
      }
    : {
        // llm is defined here (agentic is falsy, but at least one is set).
        rubric: (llm as NonNullable<OutcomeSpec["llmJudge"]>).rubric,
        model: (llm as NonNullable<OutcomeSpec["llmJudge"]>).model,
        agentic: false,
      };

  return [{ name: "correctness", weight: 1, judge }];
}
