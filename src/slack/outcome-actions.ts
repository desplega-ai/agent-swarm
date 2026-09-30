import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import {
  deleteTask,
  failTask,
  getDbClient,
  getTaskAttachments,
  getTaskById,
  insertTaskAttachment,
  promoteDraftTask,
} from "../be/db";
import { recordTaskFeedback } from "../be/db-queries/task-feedback";
import { can } from "../rbac/can";
import { slackContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import type { AgentTask } from "../types";
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

// Files the requester sent with the ask (Slack or the dashboard composer).
const INPUT_ATTACHMENT_INTENT = "user-upload";

/**
 * `task.action.own` for the Slack user who clicked: only the task's requester
 * may start new work from it (Retry, Follow up). An unmapped clicker has no
 * user principal to check, so it is denied too. Returns the canonical user ID
 * when allowed.
 */
export async function authorizeSlackTaskAction(
  client: WebClient,
  slackUserId: string,
  task: AgentTask,
  eventContext: { sampleEventType: string; sampleContext: string },
): Promise<{ allowed: true; userId: string } | { allowed: false }> {
  const userId = await resolveSlackUserId(client, slackUserId, eventContext);
  if (!userId) return { allowed: false };
  const decision = can({
    principal: { kind: "user", userId },
    verb: "task.action.own",
    resource: {
      kind: "task",
      taskId: task.id,
      requestedByUserId: task.requestedByUserId,
      creatorAgentId: task.creatorAgentId,
      agentId: task.agentId,
    },
    // Slack interactions reach the API server outside MCP; the audit table
    // only admits `mcp` | `http`.
    source: "http",
  });
  return decision.allow ? { allowed: true, userId } : { allowed: false };
}

export function interactionMessage(body: unknown): {
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

export async function postEphemeralQuietly(
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

/**
 * Re-create a failed Slack task as the same work: prompt, agent, thread, and
 * every execution input the original ran with (working dir, output contract,
 * model, effort, repo, asset key, routing affinity, the files the user sent).
 * Outputs of the failed run are not carried over.
 */
async function createRetryTask(
  original: AgentTask,
  slackUserId: string,
  requestedByUserId: string,
): Promise<AgentTask> {
  const inputs = (await getTaskAttachments(original.id)).filter(
    (attachment) => attachment.intent === INPUT_ATTACHMENT_INTENT,
  );
  const slackChannelId = original.slackChannelId as string;
  const retry = await createTaskWithSiblingAwareness(
    original.task,
    {
      key: original.key,
      agentId: original.agentId ?? undefined,
      routingReason: original.routingReason ?? undefined,
      routingSource: original.routingSource ?? undefined,
      routingAffinity: original.routingAffinity,
      source: "slack",
      taskType: original.taskType ?? undefined,
      tags: original.tags,
      priority: original.priority,
      model: original.model ?? undefined,
      modelTier: original.modelTier ?? undefined,
      effort: original.effort,
      dir: original.dir,
      // The original's stored contract is already the resolved one (its own
      // or its parent's), so take it verbatim instead of re-inheriting.
      outputSchema: original.outputSchema,
      inheritParentOutputSchema: false,
      vcsProvider: original.vcsProvider,
      vcsRepo: original.vcsRepo,
      parentTaskId: original.parentTaskId ?? undefined,
      slackChannelId,
      slackThreadTs: original.slackThreadTs,
      slackTriggerMessageTs: original.slackTriggerMessageTs,
      slackUserId,
      requestedByUserId,
      contextKey:
        original.contextKey ??
        (original.slackThreadTs
          ? slackContextKey({ channelId: slackChannelId, threadTs: original.slackThreadTs })
          : undefined),
      // Nobody may claim the retry before its input files are attached (#1240).
      ...(inputs.length > 0 ? { status: "draft" as const } : {}),
    },
    { origin: "slack" },
  );
  if (inputs.length === 0) return retry;
  try {
    // All or nothing: the draft is promoted in the same transaction as the
    // copies, so it only becomes runnable with every input file attached.
    await getDbClient().transaction(async () => {
      for (const attachment of inputs) {
        await insertTaskAttachment({
          taskId: retry.id,
          agentId: attachment.agentId,
          name: attachment.name,
          kind: attachment.kind,
          url: attachment.url,
          path: attachment.path,
          pageId: attachment.pageId,
          providerId: attachment.providerId,
          providerKey: attachment.providerKey,
          capabilities: attachment.capabilities,
          orgId: attachment.orgId,
          driveId: attachment.driveId,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          sha256: attachment.sha256,
          intent: attachment.intent,
          description: attachment.description,
          isPrimary: attachment.isPrimary,
          createdBy: attachment.createdBy,
        });
      }
      if (!(await promoteDraftTask(retry.id))) {
        throw new Error(`retry ${retry.id} left draft before its inputs were attached`);
      }
    });
  } catch (error) {
    throw new RetryInputsError(retry.id, await discardRetryDraft(retry.id), error);
  }
  return (await getTaskById(retry.id)) ?? retry;
}

/** The retry's input files could not be copied; `settled` says no draft is left behind. */
class RetryInputsError extends Error {
  constructor(
    readonly retryTaskId: string,
    readonly settled: boolean,
    cause: unknown,
  ) {
    super(`could not copy the input files to retry ${retryTaskId}`, { cause });
  }
}

/**
 * Remove a retry draft whose inputs did not copy. It was never claimable, so
 * deleting it leaves no trace of work. If the delete fails, fail the draft
 * instead: the abandoned-draft sweep would otherwise promote it, runnable and
 * missing its files. Returns false when neither landed.
 */
async function discardRetryDraft(retryTaskId: string): Promise<boolean> {
  try {
    await deleteTask(retryTaskId);
    return true;
  } catch (error) {
    console.error(`[Slack] Failed to delete retry draft ${retryTaskId}:`, error);
  }
  try {
    return (
      (await failTask(retryTaskId, "Retry aborted: the input files could not be copied")) !== null
    );
  } catch (error) {
    console.error(`[Slack] Failed to fail retry draft ${retryTaskId}:`, error);
    return false;
  }
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
    const { threadTs } = interactionMessage(body);
    const auth = await authorizeSlackTaskAction(client, body.user.id, original, {
      sampleEventType: "block_actions",
      sampleContext: RETRY_TASK_ACTION_ID,
    });
    if (!auth.allowed) {
      await postEphemeralQuietly(
        client,
        original.slackChannelId,
        body.user.id,
        threadTs ?? original.slackThreadTs,
        "Only the person who asked for this task can retry it.",
      );
      return;
    }
    if (retriedTaskIds.has(original.id)) return;
    retriedTaskIds.add(original.id);

    let retry: AgentTask;
    try {
      retry = await createRetryTask(original, body.user.id, auth.userId);
    } catch (error) {
      // Reopen the guard only when no retry is left that could still run.
      if (!(error instanceof RetryInputsError) || error.settled) {
        retriedTaskIds.delete(original.id);
      }
      console.error(`[Slack] Failed to retry task ${original.id}:`, error);
      if (error instanceof RetryInputsError) {
        await postEphemeralQuietly(
          client,
          original.slackChannelId,
          body.user.id,
          threadTs ?? original.slackThreadTs,
          error.settled
            ? "Retry did not start: the files from your ask could not be copied. Try again."
            : "Retry did not start: the files from your ask could not be copied.",
        );
      }
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
