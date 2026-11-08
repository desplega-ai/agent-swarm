import { getLeadAgent, getTaskById } from "../be/db";
import {
  getTaskUiSpec,
  releaseTaskUiActionRun,
  reserveTaskUiActionRun,
  setTaskUiActionResult,
  type TaskUiActionSurface,
} from "../be/task-ui-spec";
import { slackContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { isEnvFlagEnabled } from "../utils/env-flag";

export type TaskUiActionResult =
  | { status: "started"; taskId: string }
  | { status: "already_done" | "disabled" | "unknown_action" | "forbidden" };

/**
 * Runs the action a spec Button names, once per task and action. The Slack
 * click and the web route both call it. Only the task requester may run it.
 */
export async function runTaskUiAction({
  taskId,
  actionId,
  surface,
  actorUserId,
  slackUserId,
}: {
  taskId: string;
  actionId: string;
  surface: TaskUiActionSurface;
  actorUserId: string | undefined;
  slackUserId?: string;
}): Promise<TaskUiActionResult> {
  if (!isEnvFlagEnabled("UI_SPEC_ACTIONS_ENABLED", false)) return { status: "disabled" };

  const task = await getTaskById(taskId);
  const stored = task ? await getTaskUiSpec(taskId) : null;
  const action =
    stored?.actions && Object.hasOwn(stored.actions, actionId)
      ? stored.actions[actionId]
      : undefined;
  if (!task || !action) return { status: "unknown_action" };

  if (!actorUserId || actorUserId !== task.requestedByUserId) return { status: "forbidden" };

  const reserved = await reserveTaskUiActionRun({
    taskId,
    actionId,
    surface,
    slackUserId,
    userId: actorUserId,
  });
  if (reserved === "exists") return { status: "already_done" };

  // The same task the Slack follow-up modal creates. A failed create releases
  // the reservation, so a later click can retry.
  let followUp: Awaited<ReturnType<typeof createTaskWithSiblingAwareness>>;
  try {
    const lead = await getLeadAgent();
    followUp = await createTaskWithSiblingAwareness(
      action.prompt,
      {
        agentId: lead?.id,
        routingReason: lead ? "skill" : undefined,
        routingSource: lead ? "engine_default" : undefined,
        source: surface === "slack" ? "slack" : "ui",
        parentTaskId: taskId,
        inheritParentOutputSchema: false,
        slackChannelId: task.slackChannelId,
        slackThreadTs: task.slackThreadTs,
        slackUserId,
        requestedByUserId: actorUserId,
        contextKey:
          task.slackChannelId && task.slackThreadTs
            ? slackContextKey({ channelId: task.slackChannelId, threadTs: task.slackThreadTs })
            : undefined,
      },
      { origin: surface === "slack" ? "slack" : "rest" },
    );
  } catch (error) {
    await releaseTaskUiActionRun(taskId, actionId);
    throw error;
  }
  await setTaskUiActionResult(taskId, actionId, followUp.id);
  return { status: "started", taskId: followUp.id };
}
