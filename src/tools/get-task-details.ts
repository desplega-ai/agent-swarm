import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getLogsByTaskIdChronological, getTaskById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentLogSchema, AgentTaskSchema } from "@/types";

export const registerGetTaskDetailsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-task-details",
    {
      title: "Get task details",
      description:
        "Returns detailed information about a specific task, including output, failure reason, and log history.",
      inputSchema: z.object({
        taskId: z.uuid().describe("The ID of the task to get details for."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
        logs: z.array(AgentLogSchema).optional(),
      }),
    },
    async ({ taskId }, requestInfo, _meta) => {
      const task = getTaskById(taskId);

      if (!task) {
        return {
          content: [{ type: "text", text: `Task with ID "${taskId}" not found.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Task with ID "${taskId}" not found.`,
          },
        };
      }

      const logs = getLogsByTaskIdChronological(taskId);

      return {
        content: [{ type: "text", text: `Task "${taskId}" details retrieved.` }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Task "${taskId}" details retrieved.`,
          task,
          logs,
        },
      };
    },
  );
};
