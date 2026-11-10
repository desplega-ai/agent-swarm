import type { App } from "@slack/bolt";
import type { ChatUpdateArguments, WebClient } from "@slack/web-api";
import { cancelTask, getAgentById, getLeadAgent, getTaskById } from "../be/db";
import { slackContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { runTaskUiAction, type TaskUiActionResult } from "../ui-spec/actions";
import { UI_SPEC_ACTION_PREFIX } from "../utils/task-ui-spec";
import { buildCancelledBlocks, getTaskLink } from "./blocks";
import { resolveSlackUserId } from "./enrich";
import { EXTERNAL_CHANNEL_BLOCKED_REPLY, shouldBlockChannel } from "./external-channel";
import { ignoreSlackInbound, noteSlackInboundSideEffect } from "./inbound-dispatch";
import { ensureSlackThreadPresentation, isSlackRenderV2Enabled } from "./render-v2";
import { getAgentDisplayName, getAgentSlackIcon } from "./responses";

/** The ephemeral reply to a card click, or `null` when the click needs none. */
function uiActionReply(result: TaskUiActionResult, renderV2: boolean): string | null {
  switch (result.status) {
    case "started":
      return null;
    // v2 edits the outcome card in place; v1 keeps no record of the message.
    case "refreshed":
      return renderV2 ? null : "Card refreshed in the dashboard.";
    case "forbidden":
      return "Only the person who asked for this task can use its buttons.";
    case "already_done":
      return "This button already ran.";
    case "disabled":
      return "Card buttons are turned off on this swarm.";
    case "unknown_action":
      return "This button has no action.";
    case "not_allowlisted":
      return "This button's script is not allowlisted for card buttons.";
    case "script_changed":
      return "This button's script changed since it was allowlisted. An admin must re-pin it.";
    case "running":
      return "This button is already running. Try again in a moment.";
    case "rate_limited":
      return `This button ran recently. Try again in ${result.retryAfterSec}s.`;
    case "script_failed":
    case "invalid_output":
      return `Refresh failed: ${result.error}`;
  }
}

type ChatUpdatePayload = ChatUpdateArguments & {
  unfurl_links: false;
  unfurl_media: false;
};

async function postExternalChannelNotice(
  client: WebClient,
  channelId: string,
  userId: string,
): Promise<void> {
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: EXTERNAL_CHANNEL_BLOCKED_REPLY,
    });
  } catch (error) {
    console.error("[Slack] Failed to post external channel notice:", error);
  }
}

export function registerActionHandlers(app: App): void {
  // "View Full Logs" — URL button, just ack (Slack opens the link automatically)
  app.action("view_task_logs", async ({ ack }) => {
    await ack();
  });

  // "Follow-up" — open a modal to send a follow-up message to the same agent
  app.action("follow_up_task", async ({ ack, action, body, client }) => {
    await ack();

    if (action.type !== "button") return;
    const taskId = action.value;
    if (!taskId) return;

    const triggerId = "trigger_id" in body ? body.trigger_id : undefined;
    if (!triggerId) return;

    const channelId = "channel" in body ? body.channel?.id : undefined;
    if (channelId && (await shouldBlockChannel(client, channelId))) {
      await postExternalChannelNotice(client, channelId, body.user.id);
      return ignoreSlackInbound("external_channel");
    }

    try {
      await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: "follow_up_submit",
          private_metadata: taskId,
          title: { type: "plain_text", text: "Follow-up" },
          submit: { type: "plain_text", text: "Send" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "follow_up_input",
              label: { type: "plain_text", text: "Follow-up message" },
              element: {
                type: "plain_text_input",
                action_id: "follow_up_text",
                multiline: true,
                placeholder: {
                  type: "plain_text",
                  text: "What would you like the agent to do next?",
                },
              },
            },
          ],
        },
      });
    } catch (error) {
      console.error("[Slack] Failed to open follow-up modal:", error);
    }
  });

  // Handle follow-up modal submission
  app.view("follow_up_submit", async ({ ack, view, body, client }) => {
    await ack();

    const taskId = view.private_metadata;
    const followUpText = view.state.values.follow_up_input?.follow_up_text?.value || "";

    if (!taskId || !followUpText) return ignoreSlackInbound("empty_follow_up");

    const originalTask = await getTaskById(taskId);
    if (!originalTask || !originalTask.slackChannelId) {
      return ignoreSlackInbound("follow_up_target_missing");
    }

    if (await shouldBlockChannel(client, originalTask.slackChannelId)) {
      await postExternalChannelNotice(client, originalTask.slackChannelId, body.user.id);
      return ignoreSlackInbound("external_channel");
    }

    const lead = await getLeadAgent();
    // Resolve via the shared cascade. Sample context = the modal callback ID
    // so operators can see *which* modal-submit triggered an unmapped entry.
    const requestedByUserId = await resolveSlackUserId(client, body.user.id, {
      sampleEventType: "view_submission",
      sampleContext: view.callback_id || "follow_up_submit",
      userTeam: body.user.team_id,
    });
    noteSlackInboundSideEffect("task_created");
    const followUpTask = await createTaskWithSiblingAwareness(
      followUpText,
      {
        agentId: lead?.id,
        routingReason: lead ? "skill" : undefined,
        routingSource: lead ? "engine_default" : undefined,
        source: "slack",
        parentTaskId: taskId,
        // A human follow-up from the modal: never answer it in the original
        // task's structured-output contract.
        inheritParentOutputSchema: false,
        slackChannelId: originalTask.slackChannelId,
        slackThreadTs: originalTask.slackThreadTs,
        slackUserId: body.user.id,
        requestedByUserId,
        contextKey: originalTask.slackThreadTs
          ? slackContextKey({
              channelId: originalTask.slackChannelId,
              threadTs: originalTask.slackThreadTs,
            })
          : undefined,
      },
      { origin: "slack" },
    );

    if (isSlackRenderV2Enabled()) {
      await ensureSlackThreadPresentation([followUpTask.id]);
      return;
    }

    const taskLink = getTaskLink(followUpTask.id);
    const agentName = lead ? lead.name : "queue";
    try {
      await client.chat.postMessage({
        channel: originalTask.slackChannelId,
        thread_ts: originalTask.slackThreadTs,
        text: `💬 Follow-up sent to *${agentName}* (${taskLink})`,
        unfurl_links: false,
        unfurl_media: false,
        ...(lead ? { username: getAgentDisplayName(lead), ...getAgentSlackIcon(lead) } : {}),
      });
    } catch (error) {
      console.error("[Slack] Failed to post follow-up confirmation:", error);
    }
  });

  // A task card Button: run its declared action once, for the task requester.
  app.action(new RegExp(`^${UI_SPEC_ACTION_PREFIX}`), async ({ ack, action, body, client }) => {
    await ack();

    // Block Kit buttons only; a legacy attachment ButtonClick has no action_id.
    if (action.type !== "button" || !("action_id" in action)) return;
    const taskId = action.value;
    const actionId = action.action_id.slice(UI_SPEC_ACTION_PREFIX.length);
    if (!taskId || !actionId) return ignoreSlackInbound("ui_action_malformed");

    const channelId = "channel" in body ? body.channel?.id : undefined;
    if (channelId && (await shouldBlockChannel(client, channelId))) {
      await postExternalChannelNotice(client, channelId, body.user.id);
      return ignoreSlackInbound("external_channel");
    }

    const actorUserId = await resolveSlackUserId(client, body.user.id, {
      sampleEventType: "block_actions",
      sampleContext: action.action_id,
      userTeam: body.user.team_id,
    });
    noteSlackInboundSideEffect("ui_action");
    const result = await runTaskUiAction({
      taskId,
      actionId,
      surface: "slack",
      actorUserId,
      slackUserId: body.user.id,
    });

    if (result.status === "started") {
      if (isSlackRenderV2Enabled()) await ensureSlackThreadPresentation([result.taskId]);
      return;
    }
    const reply = uiActionReply(result, isSlackRenderV2Enabled());
    if (!channelId || !reply) return;
    try {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: reply,
      });
    } catch (error) {
      console.error("[Slack] Failed to post card button reply:", error);
    }
  });

  // "Cancel" — cancel the task and update the message
  app.action("cancel_task", async ({ ack, action, client, body }) => {
    await ack();

    if (action.type !== "button") return;
    const taskId = action.value;
    if (!taskId) return;

    const task = await getTaskById(taskId);
    if (!task) return;

    // Cancel the task in DB
    const cancelled = await cancelTask(taskId, "Cancelled via Slack");
    if (!cancelled) {
      // Task was already in a terminal state
      return;
    }

    // Update the message to show cancelled state
    if (task.slackChannelId && task.agentId) {
      const agent = await getAgentById(task.agentId);
      const agentName = agent?.name || "Unknown";
      const blocks = buildCancelledBlocks({ agentName, taskId: task.id });

      try {
        // body.message?.ts is the message where the button was clicked
        const messageTs = "message" in body && body.message?.ts;
        if (messageTs && typeof messageTs === "string") {
          const updatePayload = {
            channel: task.slackChannelId,
            ts: messageTs,
            text: "Task cancelled",
            unfurl_links: false,
            unfurl_media: false,
            // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
            blocks: blocks as any,
          } satisfies ChatUpdatePayload;
          await client.chat.update(updatePayload);
        }
      } catch (error) {
        console.error("[Slack] Failed to update cancelled message:", error);
      }
    }
  });
}
