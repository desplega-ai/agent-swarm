import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CronExpressionParser } from "cron-parser";
import * as z from "zod";
import {
  getAgentById,
  getScheduledTaskById,
  getScheduledTaskByName,
  updateScheduledTask,
} from "@/be/db";
import { calculateNextRun } from "@/scheduler";
import { createToolRegistrar } from "@/tools/utils";

export const registerUpdateScheduleTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-schedule",
    {
      title: "Update Scheduled Task",
      description:
        "Update an existing scheduled task. Only the creator or lead agent can update schedules.",
      inputSchema: z.object({
        scheduleId: z.string().uuid().optional().describe("Schedule ID to update"),
        name: z.string().optional().describe("Schedule name to update (alternative to ID)"),
        newName: z.string().min(1).max(100).optional().describe("New name for the schedule"),
        taskTemplate: z.string().min(1).optional().describe("New task template"),
        cronExpression: z.string().optional().describe("New cron expression"),
        intervalMs: z.number().int().positive().optional().describe("New interval in milliseconds"),
        description: z.string().optional().describe("New description"),
        taskType: z.string().max(50).optional().describe("New task type"),
        tags: z.array(z.string()).optional().describe("New tags"),
        priority: z.number().int().min(0).max(100).optional().describe("New priority"),
        targetAgentId: z.string().uuid().nullable().optional().describe("New target agent ID"),
        timezone: z.string().optional().describe("New timezone"),
        enabled: z.boolean().optional().describe("Enable or disable the schedule"),
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
            createdAt: z.string(),
            lastUpdatedAt: z.string(),
          })
          .optional(),
      }),
    },
    async (
      {
        scheduleId,
        name,
        newName,
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

      // Find the schedule
      const schedule = scheduleId
        ? getScheduledTaskById(scheduleId)
        : name
          ? getScheduledTaskByName(name)
          : null;

      if (!schedule) {
        return {
          content: [{ type: "text", text: "Schedule not found." }],
          structuredContent: {
            success: false,
            message: "Schedule not found.",
          },
        };
      }

      // Check authorization (creator or lead)
      const caller = getAgentById(requestInfo.agentId);
      const isCreator = schedule.createdByAgentId === requestInfo.agentId;
      const isLead = caller?.isLead === true;

      if (!isCreator && !isLead) {
        return {
          content: [{ type: "text", text: "Only the creator or lead can update this schedule." }],
          structuredContent: {
            success: false,
            message: "Only the creator or lead can update this schedule.",
          },
        };
      }

      // Validate new cron expression if provided
      if (cronExpression) {
        try {
          CronExpressionParser.parse(cronExpression, {
            tz: timezone || schedule.timezone || "UTC",
          });
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

      // Validate targetAgentId if provided and not null
      if (targetAgentId && targetAgentId !== null) {
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

      // Check if new name conflicts with existing
      if (newName && newName !== schedule.name) {
        const existing = getScheduledTaskByName(newName);
        if (existing) {
          return {
            content: [{ type: "text", text: `Schedule with name "${newName}" already exists.` }],
            structuredContent: {
              success: false,
              message: `Schedule with name "${newName}" already exists.`,
            },
          };
        }
      }

      try {
        // Build update data
        const updateData: Parameters<typeof updateScheduledTask>[1] = {};

        if (newName !== undefined) updateData.name = newName;
        if (taskTemplate !== undefined) updateData.taskTemplate = taskTemplate;
        if (cronExpression !== undefined) updateData.cronExpression = cronExpression;
        if (intervalMs !== undefined) updateData.intervalMs = intervalMs;
        if (description !== undefined) updateData.description = description;
        if (taskType !== undefined) updateData.taskType = taskType;
        if (tags !== undefined) updateData.tags = tags;
        if (priority !== undefined) updateData.priority = priority;
        if (targetAgentId !== undefined) updateData.targetAgentId = targetAgentId;
        if (timezone !== undefined) updateData.timezone = timezone;
        if (enabled !== undefined) updateData.enabled = enabled;

        // Recalculate nextRunAt if cron/interval/timezone changes or schedule is re-enabled
        const needsNextRunRecalc =
          cronExpression !== undefined ||
          intervalMs !== undefined ||
          timezone !== undefined ||
          (enabled === true && !schedule.enabled);

        if (needsNextRunRecalc && enabled !== false) {
          const tempSchedule = {
            cronExpression: cronExpression ?? schedule.cronExpression,
            intervalMs: intervalMs ?? schedule.intervalMs,
            timezone: timezone ?? schedule.timezone,
          } as Parameters<typeof calculateNextRun>[0];
          updateData.nextRunAt = calculateNextRun(tempSchedule, new Date());
        } else if (enabled === false) {
          // When disabling, clear nextRunAt
          updateData.nextRunAt = undefined;
        }

        const updated = updateScheduledTask(schedule.id, updateData);

        if (!updated) {
          return {
            content: [{ type: "text", text: "Failed to update schedule." }],
            structuredContent: {
              success: false,
              message: "Failed to update schedule.",
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Updated schedule "${updated.name}". Next run: ${updated.nextRunAt || "disabled"}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Updated schedule "${updated.name}".`,
            schedule: updated,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to update schedule: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to update schedule: ${message}`,
          },
        };
      }
    },
  );
};
