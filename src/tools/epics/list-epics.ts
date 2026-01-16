import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getEpics, getEpicWithProgress } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import type { EpicStatus } from "@/types";

export const registerListEpicsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-epics",
    {
      title: "List Epics",
      description: "List epics with optional filters. Returns epics with progress information.",
      inputSchema: z.object({
        status: z
          .enum(["draft", "active", "paused", "completed", "cancelled"])
          .optional()
          .describe("Filter by status"),
        search: z.string().optional().describe("Search in name, description, or goal"),
        leadAgentId: z.string().uuid().optional().describe("Filter by lead agent"),
        createdByAgentId: z.string().uuid().optional().describe("Filter by creator"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .optional()
          .describe("Max epics to return (default: 25)"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().optional(),
        success: z.boolean(),
        message: z.string(),
        epics: z.array(z.any()).optional(),
        total: z.number().optional(),
      }),
    },
    async (args, requestInfo, _meta) => {
      try {
        const epics = getEpics({
          status: args.status as EpicStatus | undefined,
          search: args.search,
          leadAgentId: args.leadAgentId,
          createdByAgentId: args.createdByAgentId,
          limit: args.limit,
        });

        // Add progress info to each epic
        const epicsWithProgress = epics.map((epic) => {
          const withProgress = getEpicWithProgress(epic.id);
          return withProgress || epic;
        });

        const statusFilter = args.status ? ` (status: ${args.status})` : "";
        return {
          content: [
            {
              type: "text",
              text: `Found ${epics.length} epic(s)${statusFilter}.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Found ${epics.length} epic(s).`,
            epics: epicsWithProgress,
            total: epics.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to list epics: ${message}` }],
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
