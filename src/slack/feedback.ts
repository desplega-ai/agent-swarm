import { upsertKv } from "../be/db";
import type { AgentTask } from "../types";
import { isEnvFlagEnabled } from "../utils/env-flag";

/** `action_id` of the 👍/👎 element on an outcome card. */
export const SLACK_FEEDBACK_ACTION_ID = "task_feedback";

/**
 * Reserved KV namespace of the votes, one row per task and Slack user at key
 * `<taskId>/<slackUserId>`, so a later click overwrites the earlier one. Only
 * the Slack click handler writes it; only a Lead agent can read it.
 */
export const SLACK_FEEDBACK_NAMESPACE = "slack-feedback";

export type SlackFeedbackVote = "up" | "down";

export function isSlackFeedbackButtonsEnabled(): boolean {
  return isEnvFlagEnabled("SLACK_FEEDBACK_BUTTONS", true);
}

/** Slack's native feedback buttons for `taskId`, or none when `SLACK_FEEDBACK_BUTTONS` is off. */
export function slackFeedbackBlocks(taskId: string): unknown[] {
  if (!isSlackFeedbackButtonsEnabled()) return [];
  return [
    {
      type: "context_actions",
      elements: [
        {
          type: "feedback_buttons",
          action_id: SLACK_FEEDBACK_ACTION_ID,
          positive_button: {
            text: { type: "plain_text", text: "Good answer" },
            accessibility_label: "Mark this answer as good",
            value: `up:${taskId}`,
          },
          negative_button: {
            text: { type: "plain_text", text: "Bad answer" },
            accessibility_label: "Mark this answer as bad",
            value: `down:${taskId}`,
          },
        },
      ],
    },
  ];
}

const VALUE_PATTERN = /^(up|down):([0-9a-f-]{36})$/i;

/** The vote and task of a feedback button value, or null when it is not one of ours. */
export function parseSlackFeedbackValue(
  value: unknown,
): { vote: SlackFeedbackVote; taskId: string } | null {
  const match = typeof value === "string" ? VALUE_PATTERN.exec(value) : null;
  if (!match?.[1] || !match[2]) return null;
  return { vote: match[1].toLowerCase() as SlackFeedbackVote, taskId: match[2].toLowerCase() };
}

/** Stores one person's vote on a task's answer, replacing their earlier vote on it. */
export async function recordSlackFeedbackVote(input: {
  task: AgentTask;
  vote: SlackFeedbackVote;
  slackUserId: string;
  messageTs?: string;
}): Promise<void> {
  const { task } = input;
  await upsertKv({
    namespace: SLACK_FEEDBACK_NAMESPACE,
    key: `${task.id}/${input.slackUserId}`,
    valueType: "json",
    value: {
      taskId: task.id,
      vote: input.vote,
      slackUserId: input.slackUserId,
      votedAt: new Date().toISOString(),
      agentId: task.agentId ?? null,
      profile: task.resolvedProfile ?? task.profile ?? null,
      model: task.resolvedModel ?? task.model ?? null,
      modelTier: task.modelTier ?? null,
      channelId: task.slackChannelId ?? null,
      threadTs: task.slackThreadTs ?? null,
      messageTs: input.messageTs ?? null,
    },
  });
}
