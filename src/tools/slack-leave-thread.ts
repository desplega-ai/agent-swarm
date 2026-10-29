import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getTaskById } from "@/be/db";
import { can } from "@/rbac";
import {
  isSlackLeaveThreadDisabled,
  leaveSlackThread,
  SLACK_LEAVE_THREAD_DISABLE,
} from "@/slack/left-threads";
import { parseSlackTs } from "@/slack/message-text";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerSlackLeaveThreadTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "slack-leave-thread",
    {
      title: "Leave a Slack thread",
      description:
        "Stop following a Slack thread until someone @mentions the bot there again. Messages in the thread that do not @mention the bot are then ignored, with no task and no reply. Posts nothing to Slack. Pass taskId for the thread of your Slack-originated task, or (lead only) channelId and threadTs.",
      annotations: { openWorldHint: true, idempotentHint: true },

      inputSchema: z.object({
        taskId: z.uuid().optional().describe("A task whose Slack thread to leave."),
        channelId: z.string().min(1).optional().describe("The Slack channel ID of the thread."),
        threadTs: z
          .string()
          .min(1)
          .optional()
          .describe("Timestamp of the thread root (dotted, 'p' deep-link, or full permalink URL)."),
      }),
      outputSchema: swarmToolOutputSchema({
        channelId: z.string().optional(),
        threadTs: z.string().optional(),
      }),
    },
    async ({ taskId, channelId, threadTs }, requestInfo, _meta) => {
      // Sessions created before the flag was set still list the tool.
      if (isSlackLeaveThreadDisabled()) {
        return toolErr(`slack-leave-thread is disabled by ${SLACK_LEAVE_THREAD_DISABLE}.`);
      }

      if (!requestInfo.agentId) {
        return toolErr("Agent ID not found.");
      }

      const agent = await getAgentById(requestInfo.agentId);
      if (!agent) {
        return toolErr("Agent not found.");
      }

      // Any thread is open to leads, like slack-post. Task Slack context and
      // source can be set by any agent (send-task, POST /api/tasks), so a non-lead
      // may only leave the thread of a task assigned to it that Slack ingress
      // created: only the Slack handlers write slackTriggerMessageTs.
      const mayLeaveAnyThread = can({
        principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
        verb: "integration.slack.post",
        resource: { kind: "none" },
        source: "mcp",
      }).allow;

      let slackChannelId: string | undefined;
      let slackThreadTs: string | undefined;

      if (taskId) {
        if (channelId || threadTs) {
          return toolErr("Provide either taskId or channelId and threadTs, not both.");
        }
        const task = await getTaskById(taskId);
        if (!task) {
          return toolErr("Task not found.");
        }
        if (
          !mayLeaveAnyThread &&
          (task.agentId !== agent.id || task.source !== "slack" || !task.slackTriggerMessageTs)
        ) {
          return toolErr(
            "Only a lead or the agent assigned a Slack-originated task can leave its thread.",
          );
        }
        slackChannelId = task.slackChannelId;
        slackThreadTs = task.slackThreadTs;
      } else if (channelId && threadTs) {
        if (!mayLeaveAnyThread) {
          return toolErr("Leaving a thread by channelId and threadTs requires lead privileges.");
        }
        slackChannelId = channelId;
        slackThreadTs = parseSlackTs(threadTs);
      } else {
        return toolErr("Must provide taskId, or both channelId and threadTs.");
      }

      if (!slackChannelId || !slackThreadTs) {
        return toolErr("No Slack thread context available.");
      }

      await leaveSlackThread(slackChannelId, slackThreadTs, agent.id);
      return toolOk(
        `Left Slack thread ${slackChannelId}/${slackThreadTs}. Messages there are ignored until someone @mentions the bot.`,
        { data: { channelId: slackChannelId, threadTs: slackThreadTs } },
      );
    },
  );
};
