/**
 * dsh `status.step_end.usage` normalization, shared by the worker adapter
 * (session cost row) and the dashboard log parser (turn summary row) so both
 * surfaces count the same tokens. Pure, no imports: `apps/ui` bundles it.
 *
 * dsh counts are disjoint and `totalTokens` is always their sum:
 * `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` on both
 * routes (pi-ai `parseChunkUsage` for OpenRouter, `dsh-llm-deepseek` for the
 * direct API). Reasoning is folded into `outputTokens`, not added on top.
 *
 * The cache buckets can go missing while `totalTokens` keeps them: dsh omits a
 * zero cache field, and when a step is retried `dsh-headless` sums an optional
 * bucket only if every attempt reported it. A failed attempt reports zeroed
 * usage, so the step's `cacheReadTokens` disappears and only `totalTokens`
 * still carries it. The missing remainder is derived from `totalTokens`.
 */
export interface DshStepUsage {
  /** Prompt tokens not served from cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `output`; only some routes report it. */
  reasoning: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Normalizes one `step_end.usage` object; `null` when the step reported none. */
export function normalizeDshStepUsage(usage: unknown): DshStepUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = count(u.inputTokens);
  const output = count(u.outputTokens);
  const cacheWrite = count(u.cacheWriteTokens);
  const cacheRead =
    typeof u.cacheReadTokens === "number"
      ? count(u.cacheReadTokens)
      : Math.max(0, count(u.totalTokens) - input - output - cacheWrite);
  return { input, output, cacheRead, cacheWrite, reasoning: count(u.reasoningTokens) };
}

export function addDshStepUsage(acc: DshStepUsage | undefined, step: DshStepUsage): DshStepUsage {
  return {
    input: (acc?.input ?? 0) + step.input,
    output: (acc?.output ?? 0) + step.output,
    cacheRead: (acc?.cacheRead ?? 0) + step.cacheRead,
    cacheWrite: (acc?.cacheWrite ?? 0) + step.cacheWrite,
    reasoning: (acc?.reasoning ?? 0) + step.reasoning,
  };
}
