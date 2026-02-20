import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createTaskExtended,
  getAgentById,
  getInboxMessageById,
  markInboxMessageDelegated,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

export const registerInboxDelegateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "inbox-delegate",
    {
      title: "Delegate inbox message to worker",
      description:
        "Delegate an inbox message to a worker agent by creating a task. The task inherits Slack context for replies.",
      inputSchema: z.object({
        inboxMessageId: z.uuid().describe("The inbox message ID to delegate."),
        agentId: z.uuid().describe("The worker agent to delegate to."),
        taskDescription: z
          .string()
          .min(1)
          .optional()
          .describe("Custom task description. If omitted, uses the original message."),
        offerMode: z
          .boolean()
          .default(false)
          .describe("If true, offer the task instead of direct assign."),
        parentTaskId: z
          .uuid()
          .optional()
          .describe(
            "Parent task ID. If the Slack message is a follow-up to a previous task, pass the parent task ID so the worker continues in the same session.",
          ),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
      }),
    },
    async (
      { inboxMessageId, agentId, taskDescription, offerMode, parentTaskId },
      requestInfo,
      _meta,
    ) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      const leadAgent = getAgentById(requestInfo.agentId);
      if (!leadAgent || !leadAgent.isLead) {
        return {
          content: [{ type: "text", text: "Only leads can delegate inbox messages." }],
          structuredContent: { success: false, message: "Only leads can delegate inbox messages." },
        };
      }

      const inboxMsg = getInboxMessageById(inboxMessageId);
      if (!inboxMsg) {
        return {
          content: [{ type: "text", text: "Inbox message not found." }],
          structuredContent: { success: false, message: "Inbox message not found." },
        };
      }

      if (inboxMsg.agentId !== requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "This inbox message is not yours." }],
          structuredContent: { success: false, message: "This inbox message is not yours." },
        };
      }

      const targetAgent = getAgentById(agentId);
      if (!targetAgent) {
        return {
          content: [{ type: "text", text: "Target agent not found." }],
          structuredContent: { success: false, message: "Target agent not found." },
        };
      }

      if (targetAgent.isLead) {
        return {
          content: [{ type: "text", text: "Cannot delegate to another lead." }],
          structuredContent: { success: false, message: "Cannot delegate to another lead." },
        };
      }

      // Create task for the worker
      const task = createTaskExtended(taskDescription || inboxMsg.content, {
        agentId: offerMode ? undefined : agentId,
        offeredTo: offerMode ? agentId : undefined,
        creatorAgentId: requestInfo.agentId,
        source: "slack",
        slackChannelId: inboxMsg.slackChannelId,
        slackThreadTs: inboxMsg.slackThreadTs,
        slackUserId: inboxMsg.slackUserId,
        parentTaskId,
      });

      // Mark inbox as delegated
      markInboxMessageDelegated(inboxMessageId, task.id);

      return {
        content: [
          {
            type: "text",
            text: `Delegated to ${targetAgent.name}. Task ID: ${task.id.slice(0, 8)}`,
          },
        ],
        structuredContent: {
          success: true,
          message: `Task created and ${offerMode ? "offered to" : "assigned to"} ${targetAgent.name}.`,
          task,
        },
      };
    },
  );
};
