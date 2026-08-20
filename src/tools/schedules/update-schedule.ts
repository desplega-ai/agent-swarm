import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CronExpressionParser } from "cron-parser";
import * as z from "zod";
import { authorizeAssetKeyWrite } from "@/be/asset-key-auth";
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
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import {
  AssetKeySchema,
  ModelTierSchema,
  ScheduledTaskTargetTypeSchema,
  splitLegacyModelAlias,
} from "../../types";

export const updateScheduleInputSchema = z.object({
  key: AssetKeySchema.optional().describe("Move to a logical namespace."),
  scheduleId: z.string().uuid().optional().describe("Schedule ID to update"),
  name: z.string().optional().describe("Schedule name to update (alternative to ID)"),
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
  targetAgentId: z.string().nullable().optional().describe("New target agent ID"),
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

const scheduleDataShape = {
  id: z.string().optional(),
  key: AssetKeySchema.optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  cronExpression: z.string().optional(),
  intervalMs: z.number().optional(),
  taskTemplate: z.string().optional(),
  taskType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().optional(),
  targetAgentId: z.string().optional(),
  enabled: z.boolean().optional(),
  lastRunAt: z.string().optional(),
  nextRunAt: z.string().optional(),
  createdByAgentId: z.string().optional(),
  timezone: z.string().optional(),
  model: z.string().optional(),
  modelTier: ModelTierSchema.optional(),
  scheduleType: z.string().optional(),
  targetType: ScheduledTaskTargetTypeSchema.optional(),
  workflowId: z.string().optional(),
  scriptName: z.string().optional(),
  scriptArgs: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
};

export const registerUpdateScheduleTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-schedule",
    {
      title: "Update Scheduled Task",
      annotations: { idempotentHint: true },
      description: "Update an existing scheduled task. Any registered agent can update schedules.",
      inputSchema: updateScheduleInputSchema,
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        schedule: z.looseObject(scheduleDataShape).optional(),
      }),
    },
    async (
      {
        key,
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
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      // Find the schedule
      const schedule = scheduleId
        ? await getScheduledTaskById(scheduleId)
        : name
          ? await getScheduledTaskByName(name)
          : null;

      if (!schedule) {
        return toolErr("Schedule not found.");
      }

      const caller = await getAgentById(requestInfo.agentId);
      if (!caller) {
        return toolErr("Agent not found.");
      }

      // Reject updates on completed one-time schedules
      if (schedule.scheduleType === "one_time" && !schedule.enabled && schedule.lastRunAt) {
        return toolErr(
          `One-time schedule "${schedule.name}" has already executed. Create a new one instead.`,
        );
      }

      // Validate new cron expression if provided
      if (cronExpression) {
        try {
          CronExpressionParser.parse(cronExpression, {
            tz: timezone || schedule.timezone || "UTC",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Invalid cron expression";
          return toolErr(`Invalid cron expression: ${message}`);
        }
      }

      // Validate targetAgentId if provided and not null
      if (targetAgentId && targetAgentId !== null) {
        const agent = await getAgentById(targetAgentId);
        if (!agent) {
          return toolErr(`Target agent not found: ${targetAgentId}`);
        }
      }

      // Check if new name conflicts with existing
      if (newName && newName !== schedule.name) {
        const existing = await getScheduledTaskByName(newName);
        if (existing) {
          return toolErr(`Schedule with name "${newName}" already exists.`);
        }
      }

      // Cross-field targetType validation — merge patch over existing
      const mergedTargetType = targetType ?? schedule.targetType;
      const mergedTaskTemplate = taskTemplate !== undefined ? taskTemplate : schedule.taskTemplate;
      const mergedWorkflowId = workflowId !== undefined ? workflowId : schedule.workflowId;
      const mergedScriptName = scriptName !== undefined ? scriptName : schedule.scriptName;

      if (mergedTargetType === "agent-task" && !mergedTaskTemplate) {
        return toolErr("taskTemplate is required when targetType is 'agent-task'.");
      }
      if (mergedTargetType === "workflow") {
        if (!mergedWorkflowId) {
          return toolErr("workflowId is required when targetType is 'workflow'.");
        }
        if (!(await getWorkflow(mergedWorkflowId))) {
          return toolErr(`Workflow not found: ${mergedWorkflowId}`);
        }
      }
      if (mergedTargetType === "script") {
        if (!mergedScriptName) {
          return toolErr("scriptName is required when targetType is 'script'.");
        }
        if (!(await getScript({ name: mergedScriptName, scope: "global" }))) {
          return toolErr(`Script not found: ${mergedScriptName}`);
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
            return toolErr(
              "At least one of intervalMs or cronExpression must be set for recurring schedules.",
            );
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
          (await resolveTaskAuditUserId(requestInfo.sourceTaskId, requestInfo.agentId)) ??
          undefined;
        if (key !== undefined) updateData.key = await authorizeAssetKeyWrite(key, updatedBy);
        const updated = await updateScheduledTask(schedule.id, { ...updateData, updatedBy });

        if (!updated) {
          return toolErr("Failed to update schedule.");
        }

        return toolOk(
          `Updated schedule "${updated.name}". Next run: ${updated.nextRunAt || "disabled"}`,
          {
            data: { yourAgentId: requestInfo.agentId, schedule: updated },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to update schedule: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
