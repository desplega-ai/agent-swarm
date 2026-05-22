import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import {
  cancelTask,
  getAgentById,
  getDb,
  getTaskById,
  updateAgentStatusFromCapacity,
} from "@/be/db";
import { assertOwnsTask, ownerCtx, type ToolCtx } from "@/tools/task-tool-ctx";
import { createToolRegistrar } from "@/tools/utils";
import type { AgentTask } from "@/types";
import { AgentTaskSchema } from "@/types";

export const cancelTaskInputSchema = z.object({
  taskId: z.uuid().describe("The ID of the task to cancel."),
  reason: z.string().optional().describe("Reason for cancellation."),
});

export const cancelTaskOutputSchema = z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  task: AgentTaskSchema.optional(),
});

type CancelTaskArgs = z.infer<typeof cancelTaskInputSchema>;

export async function cancelTaskHandler(
  ctx: ToolCtx,
  { taskId, reason }: CancelTaskArgs,
): Promise<CallToolResult> {
  if (ctx.kind === "owner" && !ctx.agentId) {
    return {
      content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
      structuredContent: {
        success: false,
        message: 'Agent ID not found. Set the "X-Agent-ID" header.',
      },
    };
  }

  const agentId = ctx.kind === "owner" ? ctx.agentId : undefined;

  const txn = getDb().transaction(() => {
    if (ctx.kind === "owner") {
      const ownerAgentId = ctx.agentId;
      if (!ownerAgentId) {
        return {
          success: false,
          message: 'Agent ID not found. Set the "X-Agent-ID" header.',
        };
      }
      const callerAgent = getAgentById(ownerAgentId);

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
      const canCancel = callerAgent.isLead || existingTask.creatorAgentId === ownerAgentId;
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
    }

    const existingTask = getTaskById(taskId);

    if (!existingTask) {
      return {
        success: false,
        message: `Task "${taskId}" not found.`,
      };
    }

    const ownershipError = assertOwnsTask(ctx, existingTask);
    if (ownershipError) return ownershipError;

    const cancelled = cancelTask(taskId, reason);

    if (!cancelled) {
      return {
        success: false,
        message: `Cannot cancel task in status "${existingTask.status}". Only pending/in_progress tasks can be cancelled.`,
      };
    }

    if (cancelled.agentId) {
      updateAgentStatusFromCapacity(cancelled.agentId);
    }

    return {
      success: true,
      message: `Task "${taskId}" has been cancelled.`,
      task: cancelled,
    };
  });

  const result = txn() as
    | {
        success: boolean;
        message: string;
        task?: AgentTask;
      }
    | CallToolResult;

  if ("content" in result) return result;

  return {
    content: [{ type: "text", text: result.message }],
    structuredContent: {
      yourAgentId: agentId,
      ...result,
    },
  };
}

export const registerCancelTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "cancel-task",
    {
      title: "Cancel Task",
      description:
        "Cancel a task that is pending or in progress. Only the lead or task creator can cancel tasks. The worker will be notified via hooks.",
      annotations: { destructiveHint: true },
      inputSchema: cancelTaskInputSchema,
      outputSchema: cancelTaskOutputSchema,
    },
    async (args, info, _meta) => cancelTaskHandler(ownerCtx(info), args),
  );
};
