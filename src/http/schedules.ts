import type { IncomingMessage, ServerResponse } from "node:http";
import { CronExpressionParser } from "cron-parser";
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
import { matchRoute } from "./utils";

export async function handleSchedules(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  _queryParams: URLSearchParams,
  _myAgentId: string | undefined,
): Promise<boolean> {
  // POST /api/schedules — Create a new schedule
  if (matchRoute(req.method, pathSegments, "POST", ["api", "schedules"], true)) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.name) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required field: name" }));
      return true;
    }

    if (!body.taskTemplate) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required field: taskTemplate" }));
      return true;
    }

    const isOneTime = body.scheduleType === "one_time";

    // Validate params based on schedule type
    if (isOneTime) {
      if (body.cronExpression || body.intervalMs) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "One-time schedules cannot use cronExpression or intervalMs. Use delayMs or runAt.",
          }),
        );
        return true;
      }
      if (!body.delayMs && !body.runAt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "One-time schedules require either delayMs or runAt." }));
        return true;
      }
      if (body.delayMs && body.runAt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Provide either delayMs or runAt, not both." }));
        return true;
      }
      if (body.runAt && new Date(body.runAt).getTime() <= Date.now()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "runAt must be in the future." }));
        return true;
      }
    } else {
      if (body.delayMs || body.runAt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "delayMs and runAt are only for one-time schedules. Set scheduleType to 'one_time'.",
          }),
        );
        return true;
      }
    }

    // Validate cron expression
    if (body.cronExpression) {
      try {
        CronExpressionParser.parse(body.cronExpression);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid cron expression" }));
        return true;
      }
    }

    // Check for duplicate name
    const existing = getScheduledTaskByName(body.name);
    if (existing) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Schedule with this name already exists" }));
      return true;
    }

    // Validate target agent if provided
    if (body.targetAgentId) {
      const agent = getAgentById(body.targetAgentId);
      if (!agent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Target agent not found" }));
        return true;
      }
    }

    try {
      // Calculate nextRunAt before creation
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

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(schedule));
    } catch (_error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to create schedule" }));
    }
    return true;
  }

  // POST /api/schedules/:id/run — Run a schedule immediately
  if (matchRoute(req.method, pathSegments, "POST", ["api", "schedules", null, "run"])) {
    const scheduleId = pathSegments[2]!;
    const schedule = getScheduledTaskById(scheduleId);

    if (!schedule) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Schedule not found" }));
      return true;
    }

    if (!schedule.enabled) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Schedule is disabled" }));
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

      const updatedSchedule = getScheduledTaskById(scheduleId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ schedule: updatedSchedule, task }));
    } catch (_error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to run schedule" }));
    }
    return true;
  }

  // GET /api/schedules/:id — Get single schedule
  if (matchRoute(req.method, pathSegments, "GET", ["api", "schedules", null])) {
    const scheduleId = pathSegments[2]!;
    const schedule = getScheduledTaskById(scheduleId);

    if (!schedule) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Schedule not found" }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(schedule));
    return true;
  }

  // PUT /api/schedules/:id — Update a schedule
  if (matchRoute(req.method, pathSegments, "PUT", ["api", "schedules", null])) {
    const scheduleId = pathSegments[2]!;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    const existing = getScheduledTaskById(scheduleId);
    if (!existing) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Schedule not found" }));
      return true;
    }

    // Reject updates on completed one-time schedules
    if (existing.scheduleType === "one_time" && !existing.enabled && existing.lastRunAt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "One-time schedule has already executed. Create a new one instead.",
        }),
      );
      return true;
    }

    // Validate new cron expression if provided
    if (body.cronExpression) {
      try {
        CronExpressionParser.parse(body.cronExpression);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid cron expression" }));
        return true;
      }
    }

    // Validate new target agent if provided
    if (body.targetAgentId) {
      const agent = getAgentById(body.targetAgentId);
      if (!agent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Target agent not found" }));
        return true;
      }
    }

    // Validate name uniqueness if changing name
    if (body.name && body.name !== existing.name) {
      const nameConflict = getScheduledTaskByName(body.name);
      if (nameConflict) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Schedule with this name already exists" }));
        return true;
      }
    }

    // Recalculate nextRunAt when timing fields or enabled status changes
    const newEnabled = body.enabled !== undefined ? body.enabled : existing.enabled;
    if (existing.scheduleType === "one_time") {
      // One-time schedules: no recalculation via cron/interval
      if (!newEnabled) {
        body.nextRunAt = null;
      }
    } else {
      if (!newEnabled) {
        body.nextRunAt = null;
      } else if (
        body.cronExpression !== undefined ||
        body.intervalMs !== undefined ||
        (body.enabled === true && !existing.enabled)
      ) {
        const merged = {
          cronExpression: body.cronExpression ?? existing.cronExpression,
          intervalMs: body.intervalMs ?? existing.intervalMs,
          timezone: body.timezone ?? existing.timezone,
        };
        if (merged.cronExpression || merged.intervalMs) {
          // biome-ignore lint/suspicious/noExplicitAny: need partial ScheduledTask for calculateNextRun
          body.nextRunAt = calculateNextRun(merged as any);
        }
      }
    }

    const schedule = updateScheduledTask(scheduleId, body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(schedule));
    return true;
  }

  // DELETE /api/schedules/:id — Delete a schedule
  if (matchRoute(req.method, pathSegments, "DELETE", ["api", "schedules", null])) {
    const scheduleId = pathSegments[2]!;
    const deleted = deleteScheduledTask(scheduleId);

    if (!deleted) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Schedule not found" }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return true;
  }

  return false;
}
