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
        "View all scheduled tasks with optional filters. Use this to discover existing schedules. Rows are slim by default — the full `taskTemplate` is replaced with a short `taskTemplatePreview`; pass includeFull:true (or call `get-schedule` by id) for the full template.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        enabled: z.boolean().optional().describe("Filter by enabled status"),
        name: z.string().optional().describe("Filter by name (partial match)"),
        scheduleType: z
          .enum(["recurring", "one_time"])
          .optional()
          .describe("Filter by schedule type"),
        hideCompleted: z
          .boolean()
          .default(true)
          .optional()
          .describe("Hide completed one-time schedules (default: true)"),
        consecutiveErrorsMin: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Only return schedules with at least this many consecutive errors."),
        lastRunStatus: z
          .enum(["failed", "succeeded"])
          .optional()
          .describe(
            "Filter by derived last run status. `failed` means consecutiveErrors > 0; `succeeded` means lastRunAt is set and consecutiveErrors is 0.",
          ),
        includeFull: z
          .boolean()
          .optional()
          .describe(
            "Return the full `taskTemplate` instead of a short `taskTemplatePreview`. Default false.",
          ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        schedules: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
            cronExpression: z.string().optional(),
            intervalMs: z.number().optional(),
            // Slim rows carry `taskTemplatePreview`; `includeFull` rows carry `taskTemplate`.
            taskTemplate: z.string().optional(),
            taskTemplatePreview: z.string().optional(),
            taskType: z.string().optional(),
            tags: z.array(z.string()),
            priority: z.number(),
            targetAgentId: z.string().optional(),
            enabled: z.boolean(),
            lastRunAt: z.string().optional(),
            nextRunAt: z.string().optional(),
            createdByAgentId: z.string().optional(),
            timezone: z.string(),
            consecutiveErrors: z.number().optional(),
            lastErrorAt: z.string().optional(),
            lastErrorMessage: z.string().optional(),
            scheduleType: z.string(),
            createdAt: z.string(),
            lastUpdatedAt: z.string(),
          }),
        ),
        count: z.number(),
      }),
    },
    async (
      {
        enabled,
        name,
        scheduleType,
        hideCompleted,
        consecutiveErrorsMin,
        lastRunStatus,
        includeFull,
      },
      requestInfo,
      _meta,
    ) => {
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
        const filters = {
          enabled,
          name,
          scheduleType,
          hideCompleted,
          consecutiveErrorsMin,
          lastRunStatus,
        };
        const schedules = includeFull
          ? getScheduledTasks(filters)
          : getScheduledTasks(filters, { slim: true });
        const count = schedules.length;
        const statusSummary =
          count === 0 ? "No schedules found." : `Found ${count} schedule${count === 1 ? "" : "s"}.`;

        // Format for text output
        const scheduleList = schedules
          .map((s) => {
            const type = s.scheduleType === "one_time" ? "one-time" : "recurring";
            const schedule =
              s.scheduleType === "one_time"
                ? `runs at ${s.nextRunAt || s.lastRunAt || "unknown"}`
                : s.cronExpression || `every ${s.intervalMs}ms`;
            const status = s.enabled ? "enabled" : "disabled";
            const nextRun = s.nextRunAt ? `next: ${s.nextRunAt}` : "not scheduled";
            return `- ${s.name} (${status}, ${type}) [${schedule}] ${nextRun}`;
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
