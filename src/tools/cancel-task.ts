import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { cancelTask, getAgentById, getTaskById, updateAgentStatusFromCapacity } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

export const registerCancelTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "cancel-task",
    {
      title: "Cancel Task",
      description:
        "Cancel a task that is pending or in progress. Only the lead or task creator can cancel tasks. The worker will be notified via hooks.",
      inputSchema: z.object({
        taskId: z.uuid().describe("The ID of the task to cancel."),
        reason: z.string().optional().describe("Reason for cancellation."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
      }),
    },
    async (input, requestInfo, _meta) => {
      const { taskId, reason } = input;

      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      const agentId = requestInfo.agentId;
      const callerAgent = getAgentById(agentId);

      if (!callerAgent) {
        return {
          content: [{ type: "text", text: "Caller agent not found." }],
          structuredContent: {
            success: false,
            message: "Caller agent not found.",
          },
        };
      }

      const existingTask = getTaskById(taskId);

      if (!existingTask) {
        return {
          content: [{ type: "text", text: `Task "${taskId}" not found.` }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: `Task "${taskId}" not found.`,
          },
        };
      }

      // Verify the requester has permission (lead or task creator)
      const canCancel = callerAgent.isLead || existingTask.creatorAgentId === agentId;
      if (!canCancel) {
        return {
          content: [{ type: "text", text: "Only the lead or task creator can cancel tasks." }],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: "Only the lead or task creator can cancel tasks.",
          },
        };
      }

      const cancelled = cancelTask(taskId, reason);

      if (!cancelled) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot cancel task in status "${existingTask.status}". Only pending/in_progress tasks can be cancelled.`,
            },
          ],
          structuredContent: {
            yourAgentId: agentId,
            success: false,
            message: `Cannot cancel task in status "${existingTask.status}". Only pending/in_progress tasks can be cancelled.`,
          },
        };
      }

      // Update agent status based on capacity
      if (cancelled.agentId) {
        updateAgentStatusFromCapacity(cancelled.agentId);
      }

      return {
        content: [{ type: "text", text: `Task "${taskId}" has been cancelled.` }],
        structuredContent: {
          yourAgentId: agentId,
          success: true,
          message: `Task "${taskId}" has been cancelled.`,
          task: cancelled,
        },
      };
    },
  );
};
