import type { IncomingMessage, ServerResponse } from "node:http";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import {
  createScheduledTask,
  createTaskExtended,
  deleteScheduledTask,
  getAgentById,
  getDb,
  getScheduledTaskById,
  getScheduledTaskByName,
  updateScheduledTask,
} from "../be/db";
import { calculateNextRun } from "../scheduler/scheduler";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

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
    taskTemplate: z.string().min(1),
    taskType: z.string().optional(),
    tags: z.array(z.string()).optional(),
    priority: z.number().int().optional(),
    targetAgentId: z.string().uuid().optional(),
    enabled: z.boolean().optional(),
    timezone: z.string().optional(),
    model: z.string().optional(),
    scheduleType: z.enum(["recurring", "one_time"]).optional(),
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
  body: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    cronExpression: z.string().optional(),
    intervalMs: z.number().int().optional(),
    taskTemplate: z.string().optional(),
    taskType: z.string().optional(),
    tags: z.array(z.string()).optional(),
    priority: z.number().int().optional(),
    targetAgentId: z.string().uuid().optional(),
    enabled: z.boolean().optional(),
    timezone: z.string().optional(),
    model: z.string().optional(),
    nextRunAt: z.string().nullable().optional(),
  }),
  responses: {
    200: { description: "Schedule updated" },
    400: { description: "Validation error" },
    404: { description: "Schedule not found" },
    409: { description: "Duplicate name" },
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
  _myAgentId: string | undefined,
): Promise<boolean> {
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
        model: body.model,
        scheduleType: body.scheduleType,
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
      const now = new Date().toISOString();

      const task = getDb().transaction(() => {
        const createdTask = createTaskExtended(schedule.taskTemplate, {
          creatorAgentId: schedule.createdByAgentId,
          taskType: schedule.taskType,
          tags: [...schedule.tags, "scheduled", `schedule:${schedule.name}`, "manual-run"],
          priority: schedule.priority,
          agentId: schedule.targetAgentId,
          model: schedule.model,
          scheduleId: schedule.id,
          source: "schedule",
        });

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

        return createdTask;
      })();

      const updatedSchedule = getScheduledTaskById(parsed.params.id);
      json(res, { schedule: updatedSchedule, task });
    } catch (_error) {
      jsonError(res, "Failed to run schedule", 500);
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

    json(res, schedule);
    return true;
  }

  if (updateSchedule.match(req.method, pathSegments)) {
    const parsed = await updateSchedule.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const body = parsed.body as Record<string, unknown>;

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
        const merged = {
          cronExpression: parsed.body.cronExpression ?? existing.cronExpression,
          intervalMs: parsed.body.intervalMs ?? existing.intervalMs,
          timezone: parsed.body.timezone ?? existing.timezone,
        };
        if (merged.cronExpression || merged.intervalMs) {
          // biome-ignore lint/suspicious/noExplicitAny: need partial ScheduledTask for calculateNextRun
          body.nextRunAt = calculateNextRun(merged as any);
        }
      }
    }

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
