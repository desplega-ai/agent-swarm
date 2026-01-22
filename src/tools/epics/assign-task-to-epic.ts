import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { assignTaskToEpic, getAgentById, getEpicById, getEpicByName, getTaskById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerAssignTaskToEpicTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "assign-task-to-epic",
    {
      title: "Assign Task to Epic",
      description: "Assign an existing task to an epic.",
      inputSchema: z.object({
        taskId: z.string().uuid().describe("The ID of the task to assign"),
        epicId: z.string().uuid().optional().describe("The ID of the epic"),
        epicName: z.string().optional().describe("Epic name (alternative to ID)"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
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

      // Only lead agents can assign tasks to epics
      const agent = getAgentById(requestInfo.agentId);
      if (!agent || !agent.isLead) {
        return {
          content: [{ type: "text", text: "Only lead agents can assign tasks to epics." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Only lead agents can assign tasks to epics.",
          },
        };
      }

      if (!args.epicId && !args.epicName) {
        return {
          content: [{ type: "text", text: "Either epicId or epicName must be provided." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Either epicId or epicName must be provided.",
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

        // Find epic by ID or name
        let epic = args.epicId ? getEpicById(args.epicId) : null;
        if (!epic && args.epicName) {
          epic = getEpicByName(args.epicName);
        }

        if (!epic) {
          const identifier = args.epicId || args.epicName;
          return {
            content: [{ type: "text", text: `Epic not found: ${identifier}` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Epic not found: ${identifier}`,
            },
          };
        }

        const updatedTask = assignTaskToEpic(args.taskId, epic.id);

        if (!updatedTask) {
          return {
            content: [{ type: "text", text: "Failed to assign task to epic." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Failed to assign task to epic.",
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Assigned task "${args.taskId}" to epic "${epic.name}".`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Assigned task to epic "${epic.name}".`,
            task: updatedTask,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to assign task: ${message}` }],
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
