import type { App } from "@slack/bolt";
import { cancelTask, getAgentById, getLeadAgent, getTaskById, resolveUser } from "../be/db";
import { slackContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { buildCancelledBlocks, getTaskLink } from "./blocks";

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

    if (!taskId || !followUpText) return;

    const originalTask = getTaskById(taskId);
    if (!originalTask || !originalTask.slackChannelId) return;

    const lead = getLeadAgent();
    const requestedByUserId = resolveUser({ slackUserId: body.user.id })?.id;
    const followUpTask = createTaskWithSiblingAwareness(followUpText, {
      agentId: lead?.id,
      source: "slack",
      parentTaskId: taskId,
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
    });

    const taskLink = getTaskLink(followUpTask.id);
    const agentName = lead ? lead.name : "queue";
    const threadTs = originalTask.slackThreadTs;

    try {
      await client.chat.postMessage({
        channel: originalTask.slackChannelId,
        thread_ts: threadTs,
        text: `💬 Follow-up sent to *${agentName}* (${taskLink})`,
      });
    } catch (error) {
      console.error("[Slack] Failed to post follow-up confirmation:", error);
    }
  });

  // "Cancel" — cancel the task and update the message
  app.action("cancel_task", async ({ ack, action, client, body }) => {
    await ack();

    if (action.type !== "button") return;
    const taskId = action.value;
    if (!taskId) return;

    const task = getTaskById(taskId);
    if (!task) return;

    // Cancel the task in DB
    const cancelled = cancelTask(taskId, "Cancelled via Slack");
    if (!cancelled) {
      // Task was already in a terminal state
      return;
    }

    // Update the message to show cancelled state
    if (task.slackChannelId && task.agentId) {
      const agent = getAgentById(task.agentId);
      const agentName = agent?.name || "Unknown";
      const blocks = buildCancelledBlocks({ agentName, taskId: task.id });

      try {
        // body.message?.ts is the message where the button was clicked
        const messageTs = "message" in body && body.message?.ts;
        if (messageTs && typeof messageTs === "string") {
          await client.chat.update({
            channel: task.slackChannelId,
            ts: messageTs,
            text: "Task cancelled",
            // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
            blocks: blocks as any,
          });
        }
      } catch (error) {
        console.error("[Slack] Failed to update cancelled message:", error);
      }
    }
  });
}
