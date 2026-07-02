/**
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-5.md §5
 *
 * Worker-side rendering of the "Relevant Past Knowledge" memories block that
 * gets appended to a task's initial prompt. Pure string manipulation — no DB
 * imports — so this file stays inside the worker-side boundary enforced by
 * scripts/check-db-boundary.sh.
 *
 * The conditional hint at the end is gated on `MEMORY_RATERS` containing
 * `explicit-self`. When the gate is closed (the default), the rendered
 * prompt is byte-identical to pre-rater builds — strict backward compat.
 */

export type RelevantMemory = {
  id: string;
  name: string;
  content: string;
  similarity: number;
};

const SIMILARITY_THRESHOLD = 0.4;

const RATE_TOOL_HINT = `

When a memory above genuinely helps you solve this task — or actively
misleads you — call \`memory_rate\` with the memory id and useful=true/false.
This trains the swarm to surface better memories next time. Use sparingly:
2-5 ratings per task is plenty.`;

/**
 * Render the memories prompt section. Returns `null` when there are no
 * memories with `similarity > 0.4` — the caller should then skip the
 * append entirely (matching pre-step-5 behaviour).
 */
export function renderMemoriesPrompt(memories: RelevantMemory[]): string | null {
  const useful = memories.filter((m) => m.similarity > SIMILARITY_THRESHOLD);
  if (useful.length === 0) return null;

  const memoryContext = useful
    .map((m) => `- **${m.name}** (id: ${m.id}): ${m.content.substring(0, 300)}`)
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
  const ratersEnabled = (process.env.MEMORY_RATERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ratersEnabled.includes("explicit-self");
}
