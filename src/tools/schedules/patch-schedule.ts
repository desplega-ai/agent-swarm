import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CronExpressionParser } from "cron-parser";
import * as z from "zod";
import { resolveTaskAuditUserId } from "@/be/audit-user";
import {
  getAgentById,
  getScheduledTaskById,
  getScheduledTaskByName,
  getWorkflow,
  updateScheduledTask,
} from "@/be/db";
import { mergeScheduleTiming, validateRecurringTiming } from "@/be/schedules/validate";
import { getScript } from "@/be/scripts/db";
import { calculateNextRun } from "@/scheduler";
import { createToolRegistrar } from "@/tools/utils";
import { ModelTierSchema, ScheduledTaskTargetTypeSchema, splitLegacyModelAlias } from "../../types";

export const patchScheduleInputSchema = z.object({
  scheduleId: z.string().uuid().optional().describe("Schedule ID to patch"),
  name: z.string().optional().describe("Schedule name to patch (alternative to ID)"),
  newName: z.string().min(1).max(100).optional().describe("New name for the schedule"),
  taskTemplate: z.string().min(1).optional().describe("New task template"),
  targetType: ScheduledTaskTargetTypeSchema.optional().describe(
    "Change the execution target: 'agent-task', 'workflow', or 'script'.",
  ),
  workflowId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe("New workflow ID (required when targetType is 'workflow'; null to clear)"),
  scriptName: z
    .string()
    .nullable()
    .optional()
    .describe("New catalog script name (required when targetType is 'script'; null to clear)"),
  scriptArgs: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe("New JSON args for the script target (null to clear)"),
  cronExpression: z.string().nullable().optional().describe("New cron expression (null to clear)"),
  intervalMs: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("New interval in milliseconds (null to clear)"),
  description: z.string().optional().describe("New description"),
  taskType: z.string().max(50).optional().describe("New task type"),
  tags: z.array(z.string()).optional().describe("New tags"),
  priority: z.number().int().min(0).max(100).optional().describe("New priority"),
  targetAgentId: z.string().uuid().nullable().optional().describe("New target agent ID"),
  timezone: z.string().optional().describe("New timezone"),
  enabled: z.boolean().optional().describe("Enable or disable the schedule"),
  model: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe("Concrete model override for tasks created by this schedule. Set to null to clear."),
  modelTier: ModelTierSchema.nullable()
    .optional()
    .describe("Portable model tier for tasks created by this schedule. Set to null to clear."),
});

export const registerPatchScheduleTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "patch-schedule",
    {
      title: "Patch Scheduled Task",
      annotations: { idempotentHint: true },
      description:
        "Patch an existing scheduled task by shallow-merging provided fields over the current row. Any registered agent can patch schedules.",
      inputSchema: patchScheduleInputSchema,
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
            taskTemplate: z.string().optional(),
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
            modelTier: ModelTierSchema.optional(),
            scheduleType: z.string(),
            targetType: ScheduledTaskTargetTypeSchema.optional(),
            workflowId: z.string().optional(),
            scriptName: z.string().optional(),
            scriptArgs: z.record(z.string(), z.unknown()).optional(),
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
        targetType,
        workflowId,
        scriptName,
        scriptArgs,
        cronExpression,
        intervalMs,
        description,
        taskType,
        tags,
        priority,
        targetAgentId,
        timezone,
        enabled,
        model,
        modelTier,
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

      const caller = getAgentById(requestInfo.agentId);
      if (!caller) {
        return {
          content: [{ type: "text", text: "Agent not found." }],
          structuredContent: {
            success: false,
            message: "Agent not found.",
          },
        };
      }

      // Reject updates on completed one-time schedules
      if (schedule.scheduleType === "one_time" && !schedule.enabled && schedule.lastRunAt) {
        return {
          content: [
            {
              type: "text",
              text: `One-time schedule "${schedule.name}" has already executed. Create a new one instead.`,
            },
          ],
          structuredContent: {
            success: false,
            message: `One-time schedule "${schedule.name}" has already executed. Create a new one instead.`,
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

      // Cross-field targetType validation — merge patch over existing
      const mergedTargetType = targetType ?? schedule.targetType;
      const mergedTaskTemplate = taskTemplate !== undefined ? taskTemplate : schedule.taskTemplate;
      const mergedWorkflowId = workflowId !== undefined ? workflowId : schedule.workflowId;
      const mergedScriptName = scriptName !== undefined ? scriptName : schedule.scriptName;

      if (mergedTargetType === "agent-task" && !mergedTaskTemplate) {
        const message = "taskTemplate is required when targetType is 'agent-task'.";
        return {
          content: [{ type: "text", text: message }],
          structuredContent: { success: false, message },
        };
      }
      if (mergedTargetType === "workflow") {
        if (!mergedWorkflowId) {
          const message = "workflowId is required when targetType is 'workflow'.";
          return {
            content: [{ type: "text", text: message }],
            structuredContent: { success: false, message },
          };
        }
        if (!getWorkflow(mergedWorkflowId)) {
          const message = `Workflow not found: ${mergedWorkflowId}`;
          return {
            content: [{ type: "text", text: message }],
            structuredContent: { success: false, message },
          };
        }
      }
      if (mergedTargetType === "script") {
        if (!mergedScriptName) {
          const message = "scriptName is required when targetType is 'script'.";
          return {
            content: [{ type: "text", text: message }],
            structuredContent: { success: false, message },
          };
        }
        if (!getScript({ name: mergedScriptName, scope: "global" })) {
          const message = `Script not found: ${mergedScriptName}`;
          return {
            content: [{ type: "text", text: message }],
            structuredContent: { success: false, message },
          };
        }
      }

      try {
        // Build update data
        const updateData: Parameters<typeof updateScheduledTask>[1] = {};

        if (newName !== undefined) updateData.name = newName;
        if (taskTemplate !== undefined) updateData.taskTemplate = taskTemplate;
        if (targetType !== undefined) updateData.targetType = targetType;
        if (workflowId !== undefined) updateData.workflowId = workflowId;
        if (scriptName !== undefined) updateData.scriptName = scriptName;
        if (scriptArgs !== undefined) updateData.scriptArgs = scriptArgs;
        if (cronExpression !== undefined) updateData.cronExpression = cronExpression;
        if (intervalMs !== undefined) updateData.intervalMs = intervalMs;
        if (description !== undefined) updateData.description = description;
        if (taskType !== undefined) updateData.taskType = taskType;
        if (tags !== undefined) updateData.tags = tags;
        if (priority !== undefined) updateData.priority = priority;
        if (targetAgentId !== undefined) updateData.targetAgentId = targetAgentId;
        if (timezone !== undefined) updateData.timezone = timezone;
        if (enabled !== undefined) updateData.enabled = enabled;
        if (model !== undefined || modelTier !== undefined) {
          const normalizedModel = splitLegacyModelAlias({ model, modelTier });
          if (model !== undefined) updateData.model = normalizedModel.model ?? null;
          if (modelTier !== undefined || normalizedModel.modelTier) {
            updateData.modelTier = normalizedModel.modelTier ?? null;
          }
        }

        // Recalculate nextRunAt based on schedule type
        if (schedule.scheduleType === "one_time") {
          // One-time schedules: no recalculation of nextRunAt via cron/interval
          if (enabled === false) {
            updateData.nextRunAt = null;
          }
        } else {
          // Validate merged timing before recalc — runs BEFORE the enabled===false
          // skip-recalc branch so disabling cannot bypass the invariant.
          const timing = mergeScheduleTiming(
            {
              cronExpression: schedule.cronExpression ?? null,
              intervalMs: schedule.intervalMs ?? null,
            },
            { cronExpression, intervalMs },
          );
          const timingError = validateRecurringTiming(timing);
          if (timingError) {
            return {
              content: [
                {
                  type: "text",
                  text: "At least one of intervalMs or cronExpression must be set for recurring schedules.",
                },
              ],
              structuredContent: {
                success: false,
                message:
                  "At least one of intervalMs or cronExpression must be set for recurring schedules.",
              },
            };
          }

          const needsNextRunRecalc =
            cronExpression !== undefined ||
            intervalMs !== undefined ||
            timezone !== undefined ||
            (enabled === true && !schedule.enabled);

          if (needsNextRunRecalc && enabled !== false) {
            const mergedTimezone = timezone !== undefined ? timezone : schedule.timezone;
            updateData.nextRunAt = calculateNextRun(
              {
                cronExpression: timing.mergedCron,
                intervalMs: timing.mergedInterval,
                timezone: mergedTimezone,
              } as Parameters<typeof calculateNextRun>[0],
              new Date(),
            );
          } else if (enabled === false) {
            updateData.nextRunAt = null;
          }
        }

        const updatedBy =
          resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId) ?? undefined;
        const updated = updateScheduledTask(schedule.id, { ...updateData, updatedBy });

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
              text: `Patched schedule "${updated.name}". Next run: ${updated.nextRunAt || "disabled"}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Patched schedule "${updated.name}".`,
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
