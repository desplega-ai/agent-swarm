import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CronExpressionParser } from "cron-parser";
import * as z from "zod";
import { createScheduledTask, getAgentById, getScheduledTaskByName } from "@/be/db";
import { calculateNextRun } from "@/scheduler";
import { createToolRegistrar } from "@/tools/utils";

export const registerCreateScheduleTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "create-schedule",
    {
      title: "Create Scheduled Task",
      description:
        "Create a new scheduled task that will automatically create agent tasks at specified intervals. Either cronExpression or intervalMs must be provided.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(100)
          .describe("Unique name for the schedule (e.g., 'daily-cleanup')"),
        taskTemplate: z
          .string()
          .min(1)
          .describe("The task description that will be created each time"),
        cronExpression: z
          .string()
          .optional()
          .describe("Cron expression (e.g., '0 9 * * *' for daily at 9 AM)"),
        intervalMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Interval in milliseconds (e.g., 3600000 for hourly)"),
        description: z.string().optional().describe("Human-readable description of the schedule"),
        taskType: z
          .string()
          .max(50)
          .optional()
          .describe("Task type (e.g., 'maintenance', 'report')"),
        tags: z.array(z.string()).optional().describe("Tags to apply to created tasks"),
        priority: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(50)
          .optional()
          .describe("Task priority 0-100 (default: 50)"),
        targetAgentId: z
          .string()
          .uuid()
          .optional()
          .describe("Agent to assign tasks to (omit for task pool)"),
        timezone: z.string().default("UTC").optional().describe("Timezone for cron schedules"),
        enabled: z
          .boolean()
          .default(true)
          .optional()
          .describe("Whether the schedule is enabled (default: true)"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        schedule: z
          .object({
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
          })
          .optional(),
      }),
    },
    async (
      {
        name,
        taskTemplate,
        cronExpression,
        intervalMs,
        description,
        taskType,
        tags,
        priority,
        targetAgentId,
        timezone,
        enabled,
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
          },
        };
      }

      // Validate that either cronExpression or intervalMs is provided
      if (!cronExpression && !intervalMs) {
        return {
          content: [
            { type: "text", text: "Either cronExpression or intervalMs must be provided." },
          ],
          structuredContent: {
            success: false,
            message: "Either cronExpression or intervalMs must be provided.",
          },
        };
      }

      // Validate cron expression syntax
      if (cronExpression) {
        try {
          CronExpressionParser.parse(cronExpression, { tz: timezone || "UTC" });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Invalid cron expression";
          return {
            content: [{ type: "text", text: `Invalid cron expression: ${message}` }],
            structuredContent: {
              success: false,
              message: `Invalid cron expression: ${message}`,
            },
          };
        }
      }

      // Check for duplicate name
      const existing = getScheduledTaskByName(name);
      if (existing) {
        return {
          content: [{ type: "text", text: `Schedule with name "${name}" already exists.` }],
          structuredContent: {
            success: false,
            message: `Schedule with name "${name}" already exists.`,
          },
        };
      }

      // Validate targetAgentId if provided
      if (targetAgentId) {
        const agent = getAgentById(targetAgentId);
        if (!agent) {
          return {
            content: [{ type: "text", text: `Target agent not found: ${targetAgentId}` }],
            structuredContent: {
              success: false,
              message: `Target agent not found: ${targetAgentId}`,
            },
          };
        }
      }

      try {
        // Calculate initial nextRunAt
        const tempSchedule = {
          cronExpression,
          intervalMs,
          timezone: timezone || "UTC",
        } as Parameters<typeof calculateNextRun>[0];

        const nextRunAt =
          enabled !== false ? calculateNextRun(tempSchedule, new Date()) : undefined;

        const schedule = createScheduledTask({
          name,
          taskTemplate,
          cronExpression,
          intervalMs,
          description,
          taskType,
          tags,
          priority,
          targetAgentId,
          timezone,
          enabled,
          nextRunAt,
          createdByAgentId: requestInfo.agentId,
        });

        const scheduleType = cronExpression || `every ${intervalMs}ms`;
        return {
          content: [
            {
              type: "text",
              text: `Created schedule "${name}" (${scheduleType}). Next run: ${schedule.nextRunAt || "disabled"}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Created schedule "${name}".`,
            schedule,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to create schedule: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to create schedule: ${message}`,
          },
        };
      }
    },
  );
};
