import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getTaskById, unassignTaskFromEpic } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerUnassignTaskFromEpicTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "unassign-task-from-epic",
    {
      title: "Unassign Task from Epic",
      description: "Remove a task from its epic. The task is kept but no longer associated.",
      inputSchema: z.object({
        taskId: z.string().uuid().describe("The ID of the task to unassign"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().optional(),
        success: z.boolean(),
        message: z.string(),
        task: z.any().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: { success: false, message: "Agent ID not found." },
        };
      }

      // Only lead agents can unassign tasks from epics
      const agent = getAgentById(requestInfo.agentId);
      if (!agent || !agent.isLead) {
        return {
          content: [{ type: "text", text: "Only lead agents can unassign tasks from epics." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Only lead agents can unassign tasks from epics.",
          },
        };
      }

      try {
        // Validate task exists
        const task = getTaskById(args.taskId);
        if (!task) {
          return {
            content: [{ type: "text", text: `Task not found: ${args.taskId}` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Task not found: ${args.taskId}`,
            },
          };
        }

        if (!task.epicId) {
          return {
            content: [{ type: "text", text: "Task is not assigned to any epic." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Task is not assigned to any epic.",
            },
          };
        }

        const updatedTask = unassignTaskFromEpic(args.taskId);

        if (!updatedTask) {
          return {
            content: [{ type: "text", text: "Failed to unassign task from epic." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Failed to unassign task from epic.",
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Unassigned task "${args.taskId}" from its epic.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: "Task unassigned from epic.",
            task: updatedTask,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to unassign task: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed: ${message}`,
          },
        };
      }
    },
  );
};
