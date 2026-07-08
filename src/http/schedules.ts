import type { IncomingMessage, ServerResponse } from "node:http";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import {
  createScheduledTask,
  deleteScheduledTask,
  getAgentById,
  getScheduledTaskById,
  getScheduledTaskByName,
  getScheduledTasks,
  getWorkflow,
  updateScheduledTask,
  withFavoriteFlags,
} from "../be/db";
import { mergeScheduleTiming, validateRecurringTiming } from "../be/schedules/validate";
import { getScript } from "../be/scripts/db";
import { calculateNextRun, dispatchScheduleTarget } from "../scheduler/scheduler";
import { ModelTierSchema, ScheduledTaskTargetTypeSchema, splitLegacyModelAlias } from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const scheduleUpdateBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  cronExpression: z.string().nullable().optional(),
  intervalMs: z.number().int().positive().nullable().optional(),
  taskTemplate: z.string().optional(),
  taskType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  targetAgentId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
  timezone: z.string().optional(),
  model: z.string().nullable().optional(),
  modelTier: ModelTierSchema.nullable().optional(),
  nextRunAt: z.string().nullable().optional(),
  targetType: ScheduledTaskTargetTypeSchema.optional(),
  workflowId: z.string().uuid().nullable().optional(),
  scriptName: z.string().nullable().optional(),
  scriptArgs: z.record(z.string(), z.unknown()).nullable().optional(),
});

const createSchedule = route({
  method: "post",
  path: "/api/schedules",
  pattern: ["api", "schedules"],
  summary: "Create a new schedule",
  tags: ["Schedules"],
  body: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    cronExpression: z.string().optional(),
    intervalMs: z.number().int().optional(),
    taskTemplate: z.string().min(1).optional(),
    taskType: z.string().optional(),
    tags: z.array(z.string()).optional(),
    priority: z.number().int().optional(),
    targetAgentId: z.string().uuid().optional(),
    enabled: z.boolean().optional(),
    timezone: z.string().optional(),
    model: z.string().optional(),
    modelTier: ModelTierSchema.optional(),
    scheduleType: z.enum(["recurring", "one_time"]).optional(),
    targetType: ScheduledTaskTargetTypeSchema.optional(),
    workflowId: z.string().uuid().optional(),
    scriptName: z.string().optional(),
    scriptArgs: z.record(z.string(), z.unknown()).optional(),
    delayMs: z.number().int().optional(),
    runAt: z.string().optional(),
  }),
  responses: {
    201: { description: "Schedule created" },
    400: { description: "Validation error" },
    409: { description: "Duplicate name" },
  },
});

const runScheduleNow = route({
  method: "post",
  path: "/api/schedules/{id}/run",
  pattern: ["api", "schedules", null, "run"],
  summary: "Run a schedule immediately",
  tags: ["Schedules"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Schedule run triggered" },
    400: { description: "Schedule is disabled" },
    404: { description: "Schedule not found" },
  },
});

const listSchedules = route({
  method: "get",
  path: "/api/schedules",
  pattern: ["api", "schedules"],
  summary: "List schedules",
  description:
    "Returns schedules with the full `taskTemplate` replaced by a short `taskTemplatePreview` by default — list views never render the full template. Pass `fields=full` to restore `taskTemplate`. Fetch the full template via `GET /api/schedules/{id}`.",
  tags: ["Schedules"],
  query: z.object({
    enabled: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    name: z.string().optional(),
    scheduleType: z.enum(["recurring", "one_time"]).optional(),
    targetType: ScheduledTaskTargetTypeSchema.optional(),
    workflowId: z.string().uuid().optional(),
    scriptName: z.string().optional(),
    hideCompleted: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    consecutiveErrorsMin: z.coerce.number().int().min(0).optional(),
    lastRunStatus: z.enum(["failed", "succeeded"]).optional(),
    /** `full` restores the legacy shape (includes `taskTemplate`); default is slim. */
    fields: z.enum(["full", "slim"]).optional(),
  }),
  responses: {
    200: { description: "List of schedules" },
  },
});

const getSchedule = route({
  method: "get",
  path: "/api/schedules/{id}",
  pattern: ["api", "schedules", null],
  summary: "Get a schedule by ID",
  tags: ["Schedules"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Schedule details" },
    404: { description: "Schedule not found" },
  },
});

const updateSchedule = route({
  method: "put",
  path: "/api/schedules/{id}",
  pattern: ["api", "schedules", null],
  summary: "Update a schedule",
  tags: ["Schedules"],
  params: z.object({ id: z.string() }),
  body: scheduleUpdateBodySchema,
  responses: {
    200: { description: "Schedule updated" },
    400: { description: "Validation error" },
    404: { description: "Schedule not found" },
    409: { description: "Duplicate name" },
  },
});

const patchSchedule = route({
  method: "patch",
  path: "/api/schedules/{id}",
  pattern: ["api", "schedules", null],
  summary: "Patch a schedule",
  description:
    "Partially updates a schedule by shallow-merging provided fields over the existing row.",
  tags: ["Schedules"],
  params: z.object({ id: z.string() }),
  body: scheduleUpdateBodySchema,
  responses: {
    200: { description: "Schedule patched" },
    400: { description: "Validation error" },
    404: { description: "Schedule not found" },
    409: { description: "Duplicate name" },
  },
  rbac: {
    ungated:
      "matches existing schedule update/delete posture: bearer-authenticated agents may manage schedules",
  },
});

const deleteSchedule = route({
  method: "delete",
  path: "/api/schedules/{id}",
  pattern: ["api", "schedules", null],
  summary: "Delete a schedule",
  tags: ["Schedules"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Schedule deleted" },
    404: { description: "Schedule not found" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleSchedules(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (listSchedules.match(req.method, pathSegments)) {
    const parsed = await listSchedules.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const filters = {
      enabled: parsed.query.enabled,
      name: parsed.query.name,
      scheduleType: parsed.query.scheduleType,
      targetType: parsed.query.targetType,
      workflowId: parsed.query.workflowId,
      scriptName: parsed.query.scriptName,
      hideCompleted: parsed.query.hideCompleted,
      consecutiveErrorsMin: parsed.query.consecutiveErrorsMin,
      lastRunStatus: parsed.query.lastRunStatus,
    };
    // List responses default to slim (no full `taskTemplate`); `?fields=full` restores it.
    const schedules =
      parsed.query.fields === "full"
        ? getScheduledTasks(filters)
        : getScheduledTasks(filters, { slim: true });
    const userId = resolveHttpAuditUserId(req, myAgentId);
    const decoratedSchedules = withFavoriteFlags(schedules, { userId, itemType: "schedule" });
    json(res, { schedules: decoratedSchedules, count: decoratedSchedules.length });
    return true;
  }

  if (createSchedule.match(req.method, pathSegments)) {
    const parsed = await createSchedule.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const body = parsed.body;

    const isOneTime = body.scheduleType === "one_time";

    // Cross-field validation
    if (isOneTime) {
      if (body.cronExpression || body.intervalMs) {
        jsonError(
          res,
          "One-time schedules cannot use cronExpression or intervalMs. Use delayMs or runAt.",
          400,
        );
        return true;
      }
      if (!body.delayMs && !body.runAt) {
        jsonError(res, "One-time schedules require either delayMs or runAt.", 400);
        return true;
      }
      if (body.delayMs && body.runAt) {
        jsonError(res, "Provide either delayMs or runAt, not both.", 400);
        return true;
      }
      if (body.runAt && new Date(body.runAt).getTime() <= Date.now()) {
        jsonError(res, "runAt must be in the future.", 400);
        return true;
      }
    } else {
      if (body.delayMs || body.runAt) {
        jsonError(
          res,
          "delayMs and runAt are only for one-time schedules. Set scheduleType to 'one_time'.",
          400,
        );
        return true;
      }
    }

    if (body.cronExpression) {
      try {
        CronExpressionParser.parse(body.cronExpression);
      } catch {
        jsonError(res, "Invalid cron expression", 400);
        return true;
      }
    }

    const existing = getScheduledTaskByName(body.name);
    if (existing) {
      jsonError(res, "Schedule with this name already exists", 409);
      return true;
    }

    if (body.targetAgentId) {
      const agent = getAgentById(body.targetAgentId);
      if (!agent) {
        jsonError(res, "Target agent not found", 400);
        return true;
      }
    }

    const targetType = body.targetType ?? "agent-task";
    if (targetType === "agent-task" && !body.taskTemplate) {
      jsonError(res, "taskTemplate is required when targetType is 'agent-task'.", 400);
      return true;
    }
    if (targetType === "workflow") {
      if (!body.workflowId) {
        jsonError(res, "workflowId is required when targetType is 'workflow'.", 400);
        return true;
      }
      if (!getWorkflow(body.workflowId)) {
        jsonError(res, `Workflow not found: ${body.workflowId}`, 400);
        return true;
      }
    }
    if (targetType === "script") {
      if (!body.scriptName) {
        jsonError(res, "scriptName is required when targetType is 'script'.", 400);
        return true;
      }
      if (!getScript({ name: body.scriptName, scope: "global" })) {
        jsonError(res, `Script not found: ${body.scriptName}`, 400);
        return true;
      }
    }

    try {
      let nextRunAt: string | undefined;
      if (body.enabled === false) {
        nextRunAt = undefined;
      } else if (isOneTime) {
        nextRunAt = body.delayMs ? new Date(Date.now() + body.delayMs).toISOString() : body.runAt;
      } else {
        const tempSchedule = {
          cronExpression: body.cronExpression || null,
          intervalMs: body.intervalMs || null,
          timezone: body.timezone || "UTC",
        };
        if (tempSchedule.cronExpression || tempSchedule.intervalMs) {
          // biome-ignore lint/suspicious/noExplicitAny: need partial ScheduledTask for calculateNextRun
          nextRunAt = calculateNextRun(tempSchedule as any);
        }
      }

      const schedule = createScheduledTask({
        name: body.name,
        description: body.description,
        cronExpression: body.cronExpression,
        intervalMs: body.intervalMs,
        taskTemplate: body.taskTemplate,
        taskType: body.taskType,
        tags: body.tags,
        priority: body.priority,
        targetAgentId: body.targetAgentId,
        enabled: body.enabled,
        nextRunAt,
        timezone: body.timezone,
        ...splitLegacyModelAlias({ model: body.model, modelTier: body.modelTier }),
        scheduleType: body.scheduleType,
        targetType: body.targetType,
        workflowId: body.workflowId,
        scriptName: body.scriptName,
        scriptArgs: body.scriptArgs,
        createdBy: resolveHttpAuditUserId(req, myAgentId) ?? undefined,
      });

      json(res, schedule, 201);
    } catch (_error) {
      jsonError(res, "Failed to create schedule", 500);
    }
    return true;
  }

  if (runScheduleNow.match(req.method, pathSegments)) {
    const parsed = await runScheduleNow.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const schedule = getScheduledTaskById(parsed.params.id);

    if (!schedule) {
      jsonError(res, "Schedule not found", 404);
      return true;
    }

    if (!schedule.enabled) {
      jsonError(res, "Schedule is disabled", 400);
      return true;
    }

    try {
      const { workflowRunIds, task } = await dispatchScheduleTarget(schedule, ["manual-run"]);

      const now = new Date().toISOString();
      if (schedule.scheduleType === "one_time") {
        updateScheduledTask(schedule.id, {
          lastRunAt: now,
          nextRunAt: null,
          enabled: false,
          lastUpdatedAt: now,
        });
      } else {
        updateScheduledTask(schedule.id, {
          lastRunAt: now,
          lastUpdatedAt: now,
        });
      }

      const updatedSchedule = getScheduledTaskById(parsed.params.id);
      json(res, { schedule: updatedSchedule, workflowRunIds, task });
    } catch (error) {
      jsonError(res, error instanceof Error ? error.message : "Failed to run schedule", 500);
    }
    return true;
  }

  if (getSchedule.match(req.method, pathSegments)) {
    const parsed = await getSchedule.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const schedule = getScheduledTaskById(parsed.params.id);

    if (!schedule) {
      jsonError(res, "Schedule not found", 404);
      return true;
    }

    const userId = resolveHttpAuditUserId(req, myAgentId);
    const [decorated] = withFavoriteFlags([schedule], { userId, itemType: "schedule" });
    json(res, decorated ?? schedule);
    return true;
  }

  if (
    updateSchedule.match(req.method, pathSegments) ||
    patchSchedule.match(req.method, pathSegments)
  ) {
    const routeHandle = updateSchedule.match(req.method, pathSegments)
      ? updateSchedule
      : patchSchedule;
    const parsed = await routeHandle.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const body = parsed.body as Record<string, unknown>;
    if (parsed.body.model !== undefined || parsed.body.modelTier !== undefined) {
      const normalizedModel = splitLegacyModelAlias({
        model: parsed.body.model,
        modelTier: parsed.body.modelTier,
      });
      if (parsed.body.model !== undefined) body.model = normalizedModel.model ?? null;
      if (parsed.body.modelTier !== undefined || normalizedModel.modelTier) {
        body.modelTier = normalizedModel.modelTier ?? null;
      }
    }

    const existing = getScheduledTaskById(parsed.params.id);
    if (!existing) {
      jsonError(res, "Schedule not found", 404);
      return true;
    }

    // Reject updates on completed one-time schedules
    if (existing.scheduleType === "one_time" && !existing.enabled && existing.lastRunAt) {
      jsonError(res, "One-time schedule has already executed. Create a new one instead.", 400);
      return true;
    }

    // Validate merged timing state — catches cases where one side is null in the DB
    // and the patch nulls the other, which the schema-level check cannot see.
    if (existing.scheduleType !== "one_time") {
      const timing = mergeScheduleTiming(
        {
          cronExpression: existing.cronExpression ?? null,
          intervalMs: existing.intervalMs ?? null,
        },
        { cronExpression: parsed.body.cronExpression, intervalMs: parsed.body.intervalMs },
      );
      if (validateRecurringTiming(timing)) {
        jsonError(res, "At least one of intervalMs or cronExpression must be set", 400);
        return true;
      }
    }

    if (parsed.body.cronExpression) {
      try {
        CronExpressionParser.parse(parsed.body.cronExpression);
      } catch {
        jsonError(res, "Invalid cron expression", 400);
        return true;
      }
    }

    if (parsed.body.targetAgentId) {
      const agent = getAgentById(parsed.body.targetAgentId);
      if (!agent) {
        jsonError(res, "Target agent not found", 400);
        return true;
      }
    }

    // Cross-field targetType validation — merge patch over existing, then
    // check the target-specific field is present and (for workflow/script)
    // resolves to a real row.
    const mergedTargetType = parsed.body.targetType ?? existing.targetType;
    const mergedTaskTemplate =
      parsed.body.taskTemplate !== undefined ? parsed.body.taskTemplate : existing.taskTemplate;
    const mergedWorkflowId =
      parsed.body.workflowId !== undefined ? parsed.body.workflowId : existing.workflowId;
    const mergedScriptName =
      parsed.body.scriptName !== undefined ? parsed.body.scriptName : existing.scriptName;

    if (mergedTargetType === "agent-task" && !mergedTaskTemplate) {
      jsonError(res, "taskTemplate is required when targetType is 'agent-task'.", 400);
      return true;
    }
    if (mergedTargetType === "workflow") {
      if (!mergedWorkflowId) {
        jsonError(res, "workflowId is required when targetType is 'workflow'.", 400);
        return true;
      }
      if (!getWorkflow(mergedWorkflowId)) {
        jsonError(res, `Workflow not found: ${mergedWorkflowId}`, 400);
        return true;
      }
    }
    if (mergedTargetType === "script") {
      if (!mergedScriptName) {
        jsonError(res, "scriptName is required when targetType is 'script'.", 400);
        return true;
      }
      if (!getScript({ name: mergedScriptName, scope: "global" })) {
        jsonError(res, `Script not found: ${mergedScriptName}`, 400);
        return true;
      }
    }

    if (parsed.body.name && parsed.body.name !== existing.name) {
      const nameConflict = getScheduledTaskByName(parsed.body.name);
      if (nameConflict) {
        jsonError(res, "Schedule with this name already exists", 409);
        return true;
      }
    }

    // Recalculate nextRunAt when timing fields or enabled status changes
    const newEnabled = parsed.body.enabled !== undefined ? parsed.body.enabled : existing.enabled;
    if (existing.scheduleType === "one_time") {
      if (!newEnabled) {
        body.nextRunAt = null;
      }
    } else {
      if (!newEnabled) {
        body.nextRunAt = null;
      } else if (
        parsed.body.cronExpression !== undefined ||
        parsed.body.intervalMs !== undefined ||
        (parsed.body.enabled === true && !existing.enabled)
      ) {
        const timing = mergeScheduleTiming(
          {
            cronExpression: existing.cronExpression ?? null,
            intervalMs: existing.intervalMs ?? null,
          },
          { cronExpression: parsed.body.cronExpression, intervalMs: parsed.body.intervalMs },
        );
        const mergedTimezone =
          parsed.body.timezone !== undefined ? parsed.body.timezone : existing.timezone;
        if (timing.mergedCron || timing.mergedInterval) {
          body.nextRunAt = calculateNextRun({
            cronExpression: timing.mergedCron,
            intervalMs: timing.mergedInterval,
            timezone: mergedTimezone,
            // biome-ignore lint/suspicious/noExplicitAny: need partial ScheduledTask for calculateNextRun
          } as any);
        }
      }
    }

    const updatedBy = resolveHttpAuditUserId(req, myAgentId);
    if (updatedBy !== null) body.updatedBy = updatedBy;
    const schedule = updateScheduledTask(parsed.params.id, body);
    json(res, schedule);
    return true;
  }

  if (deleteSchedule.match(req.method, pathSegments)) {
    const parsed = await deleteSchedule.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const deleted = deleteScheduledTask(parsed.params.id);

    if (!deleted) {
      jsonError(res, "Schedule not found", 404);
      return true;
    }

    json(res, { success: true });
    return true;
  }

  return false;
}
