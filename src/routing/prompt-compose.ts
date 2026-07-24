import type { AgentTask, RoutingDirectives } from "../types";
import { buildRoutingCtx } from "./ctx";
import { hasHandlersForVia, runPromptCompose } from "./engine";

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
  const directives = [...(task.routingDirectives?.directives ?? []), ...decision.promptDirectives];
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
