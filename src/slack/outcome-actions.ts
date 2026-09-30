import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { getTaskById } from "../be/db";
import { recordTaskFeedback } from "../be/db-queries/task-feedback";
import { slackContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { getTaskLink } from "./blocks";
import { resolveSlackUserId } from "./enrich";
import {
  OUTCOME_FEEDBACK_ACTION_ID,
  OUTCOME_FEEDBACK_REASON_CALLBACK_ID,
  type OutcomeRating,
  parseFeedbackValue,
  RETRY_TASK_ACTION_ID,
} from "./outcome-card-blocks";
import { ensureSlackThreadTree, isSlackRenderV2Enabled } from "./render-v2";

type FeedbackModalMetadata = {
  taskId: string;
  rating: OutcomeRating;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
};

// A double click on Retry must not start the same task twice. Process memory
// is enough: the button is a human's click, not a replayed event.
const retriedTaskIds = new Set<string>();

function interactionMessage(body: unknown): {
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
} {
  const payload = body as {
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
    message?: { ts?: string; thread_ts?: string };
  };
  return {
    channelId: payload.channel?.id ?? payload.container?.channel_id,
    messageTs: payload.message?.ts ?? payload.container?.message_ts,
    threadTs: payload.message?.thread_ts ?? payload.container?.thread_ts,
  };
}

async function postEphemeralQuietly(
  client: WebClient,
  channel: string | undefined,
  user: string,
  threadTs: string | undefined,
  text: string,
): Promise<void> {
  if (!channel) return;
  try {
    await client.chat.postEphemeral({
      channel,
      user,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  } catch (error) {
    console.warn("[Slack] Failed to post outcome action receipt:", error);
  }
}

async function recordSlackFeedback(
  client: WebClient,
  slackUserId: string,
  metadata: FeedbackModalMetadata,
  note: string | undefined,
  sampleContext: string,
): Promise<void> {
  const requestedByUserId = await resolveSlackUserId(client, slackUserId, {
    sampleEventType: "block_actions",
    sampleContext,
  });
  await recordTaskFeedback({
    taskId: metadata.taskId,
    rating: metadata.rating === "up" ? 1 : -1,
    note,
    source: "slack",
    sourceRef: {
      channelId: metadata.channelId,
      messageTs: metadata.messageTs,
      threadTs: metadata.threadTs,
      slackUserId,
    },
    requestedByUserId,
  });
}

function feedbackModal(metadata: FeedbackModalMetadata) {
  return {
    type: "modal" as const,
    callback_id: OUTCOME_FEEDBACK_REASON_CALLBACK_ID,
    private_metadata: JSON.stringify(metadata),
    title: {
      type: "plain_text" as const,
      text: metadata.rating === "up" ? "Good answer" : "Bad answer",
    },
    submit: { type: "plain_text" as const, text: "Send" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "feedback_note",
        optional: true,
        label: { type: "plain_text", text: "Quick note (optional)" },
        element: {
          type: "plain_text_input",
          action_id: "feedback_note_text",
          max_length: 500,
          placeholder: {
            type: "plain_text",
            text: metadata.rating === "up" ? "What worked?" : "What was wrong or missing?",
          },
        },
      },
    ],
  };
}

export function registerOutcomeActionHandlers(app: App): void {
  // 👍 / 👎 on the outcome card: open a one-field note modal. Submitting it,
  // with or without a note, records the rating; Cancel records nothing.
  app.action(OUTCOME_FEEDBACK_ACTION_ID, async ({ ack, action, body, client }) => {
    await ack();
    if (action.type !== "feedback_buttons") return;
    const parsed = parseFeedbackValue(action.value);
    if (!parsed) return;
    const metadata: FeedbackModalMetadata = { ...parsed, ...interactionMessage(body) };
    const triggerId = "trigger_id" in body ? body.trigger_id : undefined;
    try {
      if (!triggerId) throw new Error("no trigger_id on the feedback click");
      // biome-ignore lint/suspicious/noExplicitAny: Block Kit view object
      await client.views.open({ trigger_id: triggerId, view: feedbackModal(metadata) as any });
    } catch (error) {
      // The rating must not depend on the modal opening: record it without a note.
      console.warn("[Slack] Feedback modal did not open; recording the rating alone:", error);
      try {
        await recordSlackFeedback(client, body.user.id, metadata, undefined, "outcome_feedback");
      } catch (recordError) {
        console.error("[Slack] Failed to record outcome feedback:", recordError);
      }
    }
  });

  app.view(OUTCOME_FEEDBACK_REASON_CALLBACK_ID, async ({ ack, view, body, client }) => {
    await ack();
    let metadata: FeedbackModalMetadata;
    try {
      metadata = JSON.parse(view.private_metadata) as FeedbackModalMetadata;
    } catch {
      return;
    }
    if (!metadata?.taskId || (metadata.rating !== "up" && metadata.rating !== "down")) return;
    const note = view.state.values.feedback_note?.feedback_note_text?.value ?? undefined;
    try {
      await recordSlackFeedback(client, body.user.id, metadata, note, view.callback_id);
    } catch (error) {
      console.error("[Slack] Failed to record outcome feedback:", error);
      return;
    }
    await postEphemeralQuietly(
      client,
      metadata.channelId,
      body.user.id,
      metadata.threadTs,
      "Thanks, your feedback is recorded.",
    );
  });

  // Retry on a failed or cancelled card: the same prompt, agent and thread.
  app.action(RETRY_TASK_ACTION_ID, async ({ ack, action, body, client }) => {
    await ack();
    if (action.type !== "button" || !action.value) return;
    const original = await getTaskById(action.value);
    if (!original?.slackChannelId) return;
    if (original.status !== "failed" && original.status !== "cancelled") return;
    if (retriedTaskIds.has(original.id)) return;
    retriedTaskIds.add(original.id);

    const requestedByUserId = await resolveSlackUserId(client, body.user.id, {
      sampleEventType: "block_actions",
      sampleContext: RETRY_TASK_ACTION_ID,
    });
    let retry: Awaited<ReturnType<typeof createTaskWithSiblingAwareness>>;
    try {
      retry = await createTaskWithSiblingAwareness(
        original.task,
        {
          agentId: original.agentId ?? undefined,
          routingReason: original.routingReason ?? undefined,
          routingSource: original.routingSource ?? undefined,
          source: "slack",
          taskType: original.taskType ?? undefined,
          tags: original.tags,
          priority: original.priority,
          model: original.model ?? undefined,
          modelTier: original.modelTier ?? undefined,
          parentTaskId: original.parentTaskId ?? undefined,
          slackChannelId: original.slackChannelId,
          slackThreadTs: original.slackThreadTs,
          slackTriggerMessageTs: original.slackTriggerMessageTs,
          slackUserId: body.user.id,
          requestedByUserId,
          contextKey:
            original.contextKey ??
            (original.slackThreadTs
              ? slackContextKey({
                  channelId: original.slackChannelId,
                  threadTs: original.slackThreadTs,
                })
              : undefined),
        },
        { origin: "slack" },
      );
    } catch (error) {
      retriedTaskIds.delete(original.id);
      console.error(`[Slack] Failed to retry task ${original.id}:`, error);
      return;
    }

    if (isSlackRenderV2Enabled()) {
      await ensureSlackThreadTree([retry.id]);
      return;
    }
    await postEphemeralQuietly(
      client,
      original.slackChannelId,
      body.user.id,
      original.slackThreadTs,
      `↻ Retrying as ${getTaskLink(retry.id)}`,
    );
  });
}

export function _resetOutcomeActionsForTests(): void {
  retriedTaskIds.clear();
}
