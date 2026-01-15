import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getScheduledTasks } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerListSchedulesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-schedules",
    {
      title: "List Scheduled Tasks",
      description:
        "View all scheduled tasks with optional filters. Use this to discover existing schedules.",
      inputSchema: z.object({
        enabled: z.boolean().optional().describe("Filter by enabled status"),
        name: z.string().optional().describe("Filter by name (partial match)"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        schedules: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
            cronExpression: z.string().optional(),
            intervalMs: z.number().optional(),
            taskTemplate: z.string(),
            taskType: z.string().optional(),
            tags: z.array(z.string()),
            priority: z.number(),
            targetAgentId: z.string().optional(),
            enabled: z.boolean(),
            lastRunAt: z.string().optional(),
            nextRunAt: z.string().optional(),
            createdByAgentId: z.string().optional(),
            timezone: z.string(),
            createdAt: z.string(),
            lastUpdatedAt: z.string(),
          }),
        ),
        count: z.number(),
      }),
    },
    async ({ enabled, name }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
            schedules: [],
            count: 0,
          },
        };
      }

      try {
        const schedules = getScheduledTasks({ enabled, name });
        const count = schedules.length;
        const statusSummary =
          count === 0 ? "No schedules found." : `Found ${count} schedule${count === 1 ? "" : "s"}.`;

        // Format for text output
        const scheduleList = schedules
          .map((s) => {
            const schedule = s.cronExpression || `every ${s.intervalMs}ms`;
            const status = s.enabled ? "enabled" : "disabled";
            const nextRun = s.nextRunAt ? `next: ${s.nextRunAt}` : "not scheduled";
            return `- ${s.name} (${status}) [${schedule}] ${nextRun}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: count === 0 ? statusSummary : `${statusSummary}\n\n${scheduleList}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: statusSummary,
            schedules,
            count,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to list schedules: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to list schedules: ${message}`,
            schedules: [],
            count: 0,
          },
        };
      }
    },
  );
};
