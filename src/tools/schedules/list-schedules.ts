import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getScheduledTasks } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { AssetKeySchema } from "@/types";

const scheduleRowShape = {
  id: z.string().optional(),
  key: AssetKeySchema.optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  cronExpression: z.string().optional(),
  intervalMs: z.number().optional(),
  // Slim rows carry `taskTemplatePreview`; `includeFull` rows carry `taskTemplate`.
  taskTemplate: z.string().optional(),
  taskTemplatePreview: z.string().optional(),
  taskType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().optional(),
  targetAgentId: z.string().optional(),
  enabled: z.boolean().optional(),
  lastRunAt: z.string().optional(),
  nextRunAt: z.string().optional(),
  createdByAgentId: z.string().optional(),
  timezone: z.string().optional(),
  consecutiveErrors: z.number().optional(),
  lastErrorAt: z.string().optional(),
  lastErrorMessage: z.string().optional(),
  scheduleType: z.string().optional(),
  createdAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
};

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
        key: AssetKeySchema.optional().describe("Filter by exact namespace."),
        keyPrefix: AssetKeySchema.optional().describe("Filter by namespace subtree."),
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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        schedules: z.array(z.looseObject(scheduleRowShape)).optional(),
        count: z.number().optional(),
      }),
    },
    async (
      {
        enabled,
        name,
        key,
        keyPrefix,
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
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.', {
          data: { schedules: [], count: 0 },
        });
      }

      try {
        const filters = {
          enabled,
          name,
          key,
          keyPrefix,
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

        return toolOk(statusSummary, {
          details: count === 0 ? undefined : scheduleList,
          data: { yourAgentId: requestInfo.agentId, schedules, count },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to list schedules: ${message}`, {
          data: { yourAgentId: requestInfo.agentId, schedules: [], count: 0 },
        });
      }
    },
  );
};
