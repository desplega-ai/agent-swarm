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
      annotations: { destructiveHint: false },
      description:
        "Create a new scheduled task. For recurring: provide cronExpression or intervalMs. For one-time: provide delayMs or runAt with scheduleType 'one_time'.",
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
        scheduleType: z
          .enum(["recurring", "one_time"])
          .default("recurring")
          .optional()
          .describe("Schedule type: 'recurring' (default) or 'one_time'"),
        cronExpression: z
          .string()
          .optional()
          .describe("Cron expression for recurring schedules (e.g., '0 9 * * *')"),
        intervalMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Interval in milliseconds for recurring schedules (e.g., 3600000 for hourly)"),
        delayMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Delay in milliseconds for one-time schedules (e.g., 1800000 for 30 min)"),
        runAt: z
          .string()
          .datetime()
          .optional()
          .describe("ISO datetime for one-time schedules (e.g., '2026-03-06T15:00:00Z')"),
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
        model: z
          .enum(["haiku", "sonnet", "opus"])
          .optional()
          .describe(
            "Model to use for tasks created by this schedule ('haiku', 'sonnet', or 'opus'). If not set, uses agent/global config or defaults to 'opus'.",
          ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
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
            model: z.string().optional(),
            scheduleType: z.string(),
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
        scheduleType,
        cronExpression,
        intervalMs,
        delayMs,
        runAt,
        description,
        taskType,
        tags,
        priority,
        targetAgentId,
        timezone,
        enabled,
        model,
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

      const isOneTime = scheduleType === "one_time";

      // Validate params based on schedule type
      if (isOneTime) {
        if (cronExpression || intervalMs) {
          return {
            content: [
              {
                type: "text",
                text: "One-time schedules cannot use cronExpression or intervalMs. Use delayMs or runAt instead.",
              },
            ],
            structuredContent: {
              success: false,
              message:
                "One-time schedules cannot use cronExpression or intervalMs. Use delayMs or runAt instead.",
            },
          };
        }
        if (!delayMs && !runAt) {
          return {
            content: [
              {
                type: "text",
                text: "One-time schedules require either delayMs or runAt.",
              },
            ],
            structuredContent: {
              success: false,
              message: "One-time schedules require either delayMs or runAt.",
            },
          };
        }
        if (delayMs && runAt) {
          return {
            content: [
              {
                type: "text",
                text: "Provide either delayMs or runAt, not both.",
              },
            ],
            structuredContent: {
              success: false,
              message: "Provide either delayMs or runAt, not both.",
            },
          };
        }
        if (runAt && new Date(runAt).getTime() <= Date.now()) {
          return {
            content: [{ type: "text", text: "runAt must be in the future." }],
            structuredContent: {
              success: false,
              message: "runAt must be in the future.",
            },
          };
        }
      } else {
        if (delayMs || runAt) {
          return {
            content: [
              {
                type: "text",
                text: "delayMs and runAt are only for one-time schedules. Set scheduleType to 'one_time'.",
              },
            ],
            structuredContent: {
              success: false,
              message:
                "delayMs and runAt are only for one-time schedules. Set scheduleType to 'one_time'.",
            },
          };
        }
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
        let nextRunAt: string | undefined;
        if (enabled === false) {
          nextRunAt = undefined;
        } else if (isOneTime) {
          nextRunAt = delayMs ? new Date(Date.now() + delayMs).toISOString() : runAt!;
        } else {
          const tempSchedule = {
            cronExpression,
            intervalMs,
            timezone: timezone || "UTC",
          } as Parameters<typeof calculateNextRun>[0];
          nextRunAt = calculateNextRun(tempSchedule, new Date());
        }

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
          model,
          scheduleType: scheduleType ?? "recurring",
        });

        const scheduleDesc = isOneTime
          ? `one-time at ${schedule.nextRunAt}`
          : cronExpression || `every ${intervalMs}ms`;
        return {
          content: [
            {
              type: "text",
              text: `Created schedule "${name}" (${scheduleDesc}). Next run: ${schedule.nextRunAt || "disabled"}`,
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
