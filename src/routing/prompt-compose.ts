import type { AgentTask, RoutingDirectives } from "../types";
import { buildRoutingCtx } from "./ctx";
import { hasHandlersForVia, runPromptCompose } from "./engine";
import { MAX_PROMPT_DIRECTIVES } from "./types";

/**
 * Aggregate cap across ALL prompt.compose handlers plus the task's durable
 * directives. Deliberately the same as the per-handler cap: the composed set is
 * what actually reaches the system prompt, so N handlers must not multiply the
 * budget. Worst case stays ~40 KB against base-prompt's 120 KB.
 */
const MAX_COMPOSED_PROMPT_DIRECTIVES = MAX_PROMPT_DIRECTIVES;

/**
 * Resolve per-task guidance immediately before handing a task to its receiving
 * agent. This stays server-side because lifecycle handlers are database-owned;
 * workers receive only the resulting prompt data.
 */
export async function composeTaskRoutingDirectives(
  task: AgentTask,
  proposedAgentId: string,
): Promise<RoutingDirectives | undefined> {
  if (!hasHandlersForVia("prompt.compose", "prompt")) return task.routingDirectives;

  const decision = await runPromptCompose(buildRoutingCtx("prompt", task, { proposedAgentId }));
  // The per-handler cap is not enough on its own: N matching handlers can each
  // return the full allowance, and this set merges with the task's DURABLE
  // directives on every compose. Unbounded, that pushes protected system-prompt
  // text past base-prompt's budget (which is computed after this) and stops the
  // task starting at all. Dedupe first — repeat composes otherwise accumulate
  // the same lines — then apply the aggregate cap.
  const directives = [
    ...new Set([...(task.routingDirectives?.directives ?? []), ...decision.promptDirectives]),
  ].slice(0, MAX_COMPOSED_PROMPT_DIRECTIVES);
  if (directives.length === 0 && !task.routingDirectives) return undefined;

  return {
    directives,
    suggestions: task.routingDirectives?.suggestions ?? [],
    routingRunId:
      decision.promptDirectives.length > 0
        ? decision.routingRunId
        : task.routingDirectives?.routingRunId,
  };
}
