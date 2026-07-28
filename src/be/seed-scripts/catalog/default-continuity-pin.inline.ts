import { z } from "zod";
import type { RoutingCtx, RoutingResult, ScriptContext } from "swarm-sdk";

export const argsSchema = z.object({}).passthrough();

/**
 * Built-in, advisory continuity policy for delegated follow-ups. The final
 * fallback remains in send-task so disabling or failing this script preserves
 * the prior pinning behavior.
 */
export default async function defaultContinuityPin(
  args: RoutingCtx,
  ctx: ScriptContext,
): Promise<RoutingResult> {
  const parent = args.continuity.parent;
  if (!parent?.agentId) return {};

  // An explicit upstream selection is authoritative. Do not suggest that the
  // parent session should replace a deliberately different proposed agent.
  if (args.proposedAgentId && args.proposedAgentId !== parent.agentId) return {};

  let label: string | undefined;
  try {
    const response = await ctx.swarm.classify(
      {
        question:
          "An agent session just performed the parent task. Should the follow-up run in the SAME agent session (it continues the same type of activity, using the same skills and tools), or is it a SWITCH to a different type of activity (different skills/tools — e.g. from researching to publishing into an external tool, from coding to outreach) that would be better dispatched fresh?",
        parentTaskDescription: parent.description,
        followUpTaskDescription: args.task.description,
        parentAgentRole: parent.agentRole,
      },
      ["continue-same-activity", "switch-to-different-activity"],
      { timeoutMs: 3000 },
    );
    label = response.data?.result?.label;
  } catch {
    // Classification is deliberately fail-open-to-continuity. The historical
    // pin remains the safest fallback when this advisory check is unavailable.
  }

  if (label === "switch-to-different-activity") {
    const parentAgent =
      args.candidates.find((candidate) => candidate.id === parent.agentId)?.name ??
      parent.agentRole ??
      parent.agentId;
    // The quoted description feeds a prompt directive that
    // RoutingResultSchema caps at MAX_PROMPT_DIRECTIVE_CHARS (2000). An
    // untruncated long task description would push the directive over the
    // cap, fail the parse of the WHOLE result, and silently drop the
    // unassign — breaking this policy exactly on long tasks.
    const intent =
      args.task.description.length > 300
        ? `${args.task.description.slice(0, 300)}…`
        : args.task.description;
    // `unassign` — not advice alone. Callers default the child's agentId to
    // the parent worker BEFORE routing runs, so returning only directives
    // would leave the follow-up pinned to that worker and merely show it a
    // note telling someone else to dispatch fresh.
    return {
      unassign: true,
      promptDirectives: [
        `Routing: the follow-up's intent (${intent}) differs from what ${parentAgent} was doing — sent to the pool for a fresh assignment instead of continuing the session.`,
      ],
      note: "continuity pin broken: intent mismatch",
    };
  }

  return { assignTo: parent.agentId };
}
