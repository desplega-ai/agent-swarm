import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getEpicById, getEpicByName, getEpicWithProgress, getTasksByEpicId } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerGetEpicDetailsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-epic-details",
    {
      title: "Get Epic Details",
      description:
        "Get detailed information about a specific epic, including progress and associated tasks.",
      inputSchema: z.object({
        epicId: z.string().uuid().optional().describe("The ID of the epic"),
        name: z.string().optional().describe("The name of the epic (alternative to ID)"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        epic: z.any().optional(),
        tasks: z.array(z.any()).optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      if (!args.epicId && !args.name) {
        return {
          content: [{ type: "text", text: "Either epicId or name must be provided." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Either epicId or name must be provided.",
          },
        };
      }

      try {
        // Find epic by ID or name
        let epic = args.epicId ? getEpicById(args.epicId) : null;
        if (!epic && args.name) {
          epic = getEpicByName(args.name);
        }

        if (!epic) {
          const identifier = args.epicId || args.name;
          return {
            content: [{ type: "text", text: `Epic not found: ${identifier}` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Epic not found: ${identifier}`,
            },
          };
        }

        // Get epic with progress
        const epicWithProgress = getEpicWithProgress(epic.id);

        // Get associated tasks
        const tasks = getTasksByEpicId(epic.id);

        return {
          content: [
            {
              type: "text",
              text: `Epic "${epic.name}" (${epic.status}): ${epicWithProgress?.progress ?? 0}% complete, ${tasks.length} task(s)`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Retrieved epic "${epic.name}".`,
            epic: epicWithProgress,
            tasks,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to get epic: ${message}` }],
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
