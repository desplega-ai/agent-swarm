import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  cancelTask,
  getAgentById,
  getDb,
  getTaskById,
  updateAgentStatusFromCapacity,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import type { AgentTask } from "@/types";
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
        yourAgentId: z.string().uuid().optional(),
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

      const txn = getDb().transaction(() => {
        const callerAgent = getAgentById(agentId);

        if (!callerAgent) {
          return {
            success: false,
            message: "Caller agent not found.",
          };
        }

        const existingTask = getTaskById(taskId);

        if (!existingTask) {
          return {
            success: false,
            message: `Task "${taskId}" not found.`,
          };
        }

        // Verify the requester has permission (lead or task creator)
        const canCancel = callerAgent.isLead || existingTask.creatorAgentId === agentId;
        if (!canCancel) {
          return {
            success: false,
            message: "Only the lead or task creator can cancel tasks.",
          };
        }

        const cancelled = cancelTask(taskId, reason);

        if (!cancelled) {
          return {
            success: false,
            message: `Cannot cancel task in status "${existingTask.status}". Only pending/in_progress tasks can be cancelled.`,
          };
        }

        // Update agent status based on capacity
        if (cancelled.agentId) {
          updateAgentStatusFromCapacity(cancelled.agentId);
        }

        return {
          success: true,
          message: `Task "${taskId}" has been cancelled.`,
          task: cancelled,
        };
      });

      const result = txn() as {
        success: boolean;
        message: string;
        task?: AgentTask;
      };

      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: {
          yourAgentId: agentId,
          ...result,
        },
      };
    },
  );
};
