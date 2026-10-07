/**
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-5.md §5
 *
 * Worker-side rendering of the "Relevant Past Knowledge" memories block that
 * gets appended to a task's initial prompt. Pure string manipulation — no DB
 * imports — so this file stays inside the worker-side boundary enforced by
 * scripts/check-db-boundary.sh.
 *
 * The conditional hint at the end is gated on `MEMORY_RATERS` containing
 * `explicit-self` (part of the default when unset). An explicitly empty value
 * closes the gate and preserves the prompt without rating hints.
 */

import { getMemoryRaterNames } from "../utils/memory-raters";

export type RelevantMemory = {
  id: string;
  name: string;
  content: string;
  similarity: number;
  rawSimilarity?: number;
  /** Memory provenance (`task_completion`, `manual`, ...). Older servers omit it. */
  source?: string;
  summary?: string | null;
  createdAt?: string;
};

const SNIPPET_CHARS = 300;
const OUTPUT_MARKER = "\n\nOutput:\n";
const FAILURE_MARKER = "\n\nFailure reason:\n";
const FAILURE_SUFFIX = "\n\nThis task failed. Learn from this to avoid repeating the mistake.";

/**
 * The text a memory line shows: its `summary` when set, else, for a
 * `task_completion` row, the outcome after `Output:` / `Failure reason:`
 * instead of the start of the old task prompt. The last marker wins because a
 * follow-up task prompt can itself embed an earlier worker's `Output:` block.
 */
export function memorySnippet(memory: RelevantMemory): string {
  const summary = memory.summary?.trim();
  if (summary) return summary;
  const { content } = memory;
  if (memory.source !== "task_completion") return content;

  const outputAt = content.lastIndexOf(OUTPUT_MARKER);
  const failureAt = content.lastIndexOf(FAILURE_MARKER);
  if (outputAt === -1 && failureAt === -1) return content;
  if (outputAt > failureAt) return content.slice(outputAt + OUTPUT_MARKER.length).trim();

  let reason = content.slice(failureAt + FAILURE_MARKER.length);
  if (reason.endsWith(FAILURE_SUFFIX)) reason = reason.slice(0, -FAILURE_SUFFIX.length);
  return `FAILED: ${reason.trim()}`;
}

/** `[2026-09-29, task_completion] ` from whatever of createdAt/source the server sent. */
function memoryLinePrefix(memory: RelevantMemory): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(memory.createdAt ?? "")?.[0];
  const parts = [date, memory.source].filter(Boolean);
  return parts.length > 0 ? `[${parts.join(", ")}] ` : "";
}

/**
 * Minimum pre-boost relevance for a memory to be injected into a task prompt.
 *
 * Compared against `rawSimilarity`, the [0,1] match score every retrieval arm
 * emits before rerank (vec cosine, hybrid fused cosine, graph-derived), never
 * against the composite `similarity`: the reranker's access, source-quality
 * and usefulness multipliers can lift a score up to 4.5x, so a composite
 * threshold admits unrelated rows. 0.55 sits between an unrelated query's best
 * cosine (~0.33 on the production embedding model) and an exact-name hybrid
 * hit (~0.65 fused).
 */
export const SIMILARITY_THRESHOLD = 0.55;

/** The score the injection threshold applies to. Older servers omit `rawSimilarity`. */
export function memoryRelevance(memory: { similarity: number; rawSimilarity?: number }): number {
  return memory.rawSimilarity ?? memory.similarity;
}

const RATE_TOOL_HINT = `

When a memory above genuinely helps you solve this task — or actively
misleads you — call \`memory_rate\` with the memory id and useful=true/false.
This trains the swarm to surface better memories next time. Use sparingly:
2-5 ratings per task is plenty.`;

/**
 * Render the memories prompt section. Returns `null` when there are no
 * memories above `SIMILARITY_THRESHOLD` — the caller should then skip the
 * append entirely (matching pre-step-5 behaviour).
 */
export function renderMemoriesPrompt(memories: RelevantMemory[]): string | null {
  const useful = memories.filter((m) => memoryRelevance(m) > SIMILARITY_THRESHOLD);
  if (useful.length === 0) return null;

  const memoryContext = useful
    .map(
      (m) =>
        `- ${memoryLinePrefix(m)}**${m.name}** (id: ${m.id}): ${memorySnippet(m).substring(0, SNIPPET_CHARS)}`,
    )
    .join("\n");

  let prompt = `\n\n### Relevant Past Knowledge\n\nThese memories from your previous sessions may be useful. Use \`memory-get\` with the memory ID to retrieve full details.\n\n${memoryContext}\n`;

  if (isExplicitSelfRaterEnabled()) {
    prompt += RATE_TOOL_HINT;
  }

  return prompt;
}

/**
 * Exported for tests. Reads `MEMORY_RATERS` lazily so a test can flip the
 * env var between renders without re-importing the module.
 */
export function isExplicitSelfRaterEnabled(): boolean {
  return getMemoryRaterNames().includes("explicit-self");
}
