import type { IncomingMessage, ServerResponse } from "node:http";
import { ensure } from "@desplega.ai/business-use";
import { z } from "zod";
import {
  cancelTask,
  completeTask,
  createTaskExtended,
  failTask,
  getAllTasks,
  getDb,
  getLogsByTaskId,
  getPausedTasksForAgent,
  getTaskById,
  getTasksCount,
  pauseTask,
  resumeTask,
  updateAgentStatusFromCapacity,
  updateTaskClaudeSessionId,
  updateTaskProgress,
  updateTaskVcs,
} from "../be/db";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listTasks = route({
  method: "get",
  path: "/api/tasks",
  pattern: ["api", "tasks"],
  summary: "List tasks with filters",
  tags: ["Tasks"],
  query: z.object({
    status: z.string().optional(),
    agentId: z.string().optional(),
    epicId: z.string().optional(),
    scheduleId: z.string().optional(),
    search: z.string().optional(),
    includeHeartbeat: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
  }),
  responses: {
    200: { description: "Paginated task list" },
  },
});

const createTask = route({
  method: "post",
  path: "/api/tasks",
  pattern: ["api", "tasks"],
  summary: "Create a new task",
  tags: ["Tasks"],
  body: z.object({
    task: z.string().min(1),
    agentId: z.string().optional(),
    taskType: z.string().optional(),
    tags: z.array(z.string()).optional(),
    priority: z.number().int().optional(),
    dependsOn: z.array(z.string()).optional(),
    offeredTo: z.string().optional(),
    dir: z.string().optional(),
    parentTaskId: z.string().optional(),
    source: z.string().optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
  responses: {
    201: { description: "Task created" },
    400: { description: "Validation error" },
  },
});

const updateClaudeSession = route({
  method: "put",
  path: "/api/tasks/{id}/claude-session",
  pattern: ["api", "tasks", null, "claude-session"],
  summary: "Update Claude session ID for a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({ claudeSessionId: z.string().min(1) }),
  responses: {
    200: { description: "Session ID updated" },
    404: { description: "Task not found" },
  },
});

const cancelTaskRoute = route({
  method: "post",
  path: "/api/tasks/{id}/cancel",
  pattern: ["api", "tasks", null, "cancel"],
  summary: "Cancel a pending or in-progress task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Task cancelled" },
    400: { description: "Cannot cancel terminal task" },
    404: { description: "Task not found" },
  },
});

const getTask = route({
  method: "get",
  path: "/api/tasks/{id}",
  pattern: ["api", "tasks", null],
  summary: "Get task details with logs",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Task with logs" },
    404: { description: "Task not found" },
  },
});

const updateTaskProgressRoute = route({
  method: "post",
  path: "/api/tasks/{id}/progress",
  pattern: ["api", "tasks", null, "progress"],
  summary: "Update task progress text",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({ progress: z.string().min(1) }),
  responses: {
    200: { description: "Progress updated" },
    404: { description: "Task not found" },
  },
});

const finishTask = route({
  method: "post",
  path: "/api/tasks/{id}/finish",
  pattern: ["api", "tasks", null, "finish"],
  summary: "Mark task as completed or failed (runner endpoint)",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({
    status: z.enum(["completed", "failed"]),
    output: z.string().optional(),
    failureReason: z.string().optional(),
  }),
  auth: { apiKey: true, agentId: true },
  responses: {
    200: { description: "Task finished" },
    400: { description: "Invalid status" },
    403: { description: "Not assigned to this agent" },
    404: { description: "Task not found" },
  },
});

const listPausedTasks = route({
  method: "get",
  path: "/api/paused-tasks",
  pattern: ["api", "paused-tasks"],
  summary: "Get paused tasks for this agent",
  tags: ["Tasks"],
  auth: { apiKey: true, agentId: true },
  responses: {
    200: { description: "Paused task list" },
  },
});

const pauseTaskRoute = route({
  method: "post",
  path: "/api/tasks/{id}/pause",
  pattern: ["api", "tasks", null, "pause"],
  summary: "Pause an in-progress task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Task paused" },
    400: { description: "Task not in_progress" },
    403: { description: "Task belongs to another agent" },
    404: { description: "Task not found" },
  },
});

const resumeTaskRoute = route({
  method: "post",
  path: "/api/tasks/{id}/resume",
  pattern: ["api", "tasks", null, "resume"],
  summary: "Resume a paused task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Task resumed" },
    400: { description: "Task not paused" },
    403: { description: "Task belongs to another agent" },
    404: { description: "Task not found" },
  },
});

const updateTaskVcsRoute = route({
  method: "patch",
  path: "/api/tasks/{id}/vcs",
  pattern: ["api", "tasks", null, "vcs"],
  summary: "Update VCS (PR/MR) info for a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({
    vcsProvider: z.enum(["github", "gitlab"]),
    vcsRepo: z.string(),
    vcsNumber: z.number().int().positive(),
    vcsUrl: z.string().url(),
  }),
  responses: {
    200: { description: "VCS info updated" },
    404: { description: "Task not found" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleTasks(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (listTasks.match(req.method, pathSegments)) {
    const parsed = await listTasks.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const filters = {
      status: (parsed.query.status as import("../types").AgentTaskStatus) || undefined,
      agentId: parsed.query.agentId || undefined,
      epicId: parsed.query.epicId || undefined,
      scheduleId: parsed.query.scheduleId || undefined,
      search: parsed.query.search || undefined,
      includeHeartbeat: parsed.query.includeHeartbeat === "true" || undefined,
      limit: parsed.query.limit,
      offset: parsed.query.offset,
    };
    const tasks = getAllTasks(filters);
    const total = getTasksCount(filters);
    json(res, { tasks, total });
    return true;
  }

  if (createTask.match(req.method, pathSegments)) {
    const parsed = await createTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const task = createTaskExtended(parsed.body.task, {
        agentId: parsed.body.agentId || undefined,
        creatorAgentId: myAgentId || undefined,
        taskType: parsed.body.taskType || undefined,
        tags: parsed.body.tags || undefined,
        priority: parsed.body.priority || 50,
        dependsOn: parsed.body.dependsOn || undefined,
        offeredTo: parsed.body.offeredTo || undefined,
        dir: parsed.body.dir || undefined,
        parentTaskId: parsed.body.parentTaskId || undefined,
        source: (parsed.body.source as import("../types").AgentTaskSource) || "api",
        outputSchema: parsed.body.outputSchema || undefined,
      });

      ensure({
        id: "created",
        flow: "task",
        runId: task.id,
        data: {
          taskId: task.id,
          agentId: task.agentId,
          source: parsed.body.source || "api",
          status: task.status,
          task: task.task.slice(0, 200),
          priority: task.priority,
          tags: task.tags,
          parentTaskId: task.parentTaskId,
          epicId: task.epicId,
        },
      });

      json(res, task, 201);
    } catch (error) {
      console.error("[HTTP] Failed to create task:", error);
      jsonError(res, "Failed to create task", 500);
    }
    return true;
  }

  if (updateClaudeSession.match(req.method, pathSegments)) {
    const parsed = await updateClaudeSession.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = updateTaskClaudeSessionId(parsed.params.id, parsed.body.claudeSessionId);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    json(res, task);
    return true;
  }

  if (cancelTaskRoute.match(req.method, pathSegments)) {
    const parsed = await cancelTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = getTaskById(parsed.params.id);

    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    const terminalStatuses = ["completed", "failed", "cancelled"];
    if (terminalStatuses.includes(task.status)) {
      jsonError(res, `Cannot cancel task with status '${task.status}'`, 400);
      return true;
    }

    // Parse optional reason from body (already consumed by parse if body schema exists,
    // but cancel has no body schema — read raw)
    let reason: string | undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString();
    if (raw) {
      try {
        const body = JSON.parse(raw);
        reason = body.reason;
      } catch {
        // No body or invalid JSON — proceed without reason
      }
    }

    const cancelledTask = cancelTask(parsed.params.id, reason);
    if (!cancelledTask) {
      jsonError(res, "Failed to cancel task", 500);
      return true;
    }

    if (task.status === "pending") {
      ensure({
        id: "cancelled_pending",
        flow: "task",
        runId: parsed.params.id,
        depIds: ["created"],
        data: {
          taskId: parsed.params.id,
          agentId: task.agentId,
          previousStatus: task.status,
          reason,
        },
        validator: (data) => data.previousStatus === "pending",
        // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
        filter: ({}, ctx) => ctx.deps.length > 0,
        conditions: [{ timeout_ms: 86_400_000 }], // 1 day: task may sit pending for a long time
      });
    } else {
      ensure({
        id: "cancelled_in_progress",
        flow: "task",
        runId: parsed.params.id,
        depIds:
          task.status === "paused"
            ? ["started", "paused"]
            : task.wasPaused
              ? ["started", "resumed"]
              : ["started"],
        data: {
          taskId: parsed.params.id,
          agentId: task.agentId,
          previousStatus: task.status,
          reason,
        },
        validator: (data) =>
          data.previousStatus === "in_progress" || data.previousStatus === "paused",
        // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
        filter: ({}, ctx) => ctx.deps.length > 0,
        conditions: [{ timeout_ms: 3_600_000 }], // 1 hour: task running time
      });
    }

    if (task.agentId) {
      updateAgentStatusFromCapacity(task.agentId);
    }

    json(res, { success: true, task: cancelledTask });
    return true;
  }

  if (getTask.match(req.method, pathSegments)) {
    const parsed = await getTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = getTaskById(parsed.params.id);

    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    const logs = getLogsByTaskId(parsed.params.id);
    json(res, { ...task, logs });
    return true;
  }

  if (updateTaskProgressRoute.match(req.method, pathSegments)) {
    const parsed = await updateTaskProgressRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = getTaskById(parsed.params.id);

    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    updateTaskProgress(parsed.params.id, parsed.body.progress);
    json(res, { success: true });
    return true;
  }

  if (finishTask.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }

    const parsed = await finishTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const result = getDb().transaction(() => {
      const task = getTaskById(parsed.params.id);

      if (!task) {
        return { error: "Task not found", status: 404 };
      }

      if (task.agentId && task.agentId !== myAgentId) {
        return { error: "Task is assigned to another agent", status: 403 };
      }

      if (task.status !== "in_progress") {
        return { task, alreadyFinished: true };
      }

      const wasPaused = task.wasPaused;

      let updatedTask: typeof task;
      if (parsed.body.status === "completed") {
        const result = completeTask(
          parsed.params.id,
          parsed.body.output || "Completed by runner wrapper (no explicit output)",
        );
        if (!result) {
          return { error: "Failed to complete task", status: 500 };
        }
        updatedTask = result;
      } else {
        const result = failTask(
          parsed.params.id,
          parsed.body.failureReason || "Process exited without explicit completion",
        );
        if (!result) {
          return { error: "Failed to mark task as failed", status: 500 };
        }
        updatedTask = result;
      }

      if (task.agentId) {
        updateAgentStatusFromCapacity(task.agentId);
      }

      return { task: updatedTask, wasPaused };
    })();

    if ("error" in result && result.error) {
      jsonError(res, result.error, (result as { status?: number }).status ?? 500);
      return true;
    }

    if (result.task && !("alreadyFinished" in result && result.alreadyFinished)) {
      const finishEventId = parsed.body.status === "completed" ? "completed" : "failed";
      ensure({
        id: finishEventId,
        flow: "task",
        runId: parsed.params.id,
        depIds: result.wasPaused ? ["started", "resumed"] : ["started"],
        data: {
          taskId: parsed.params.id,
          agentId: myAgentId,
          previousStatus: "in_progress",
          ...(finishEventId === "completed"
            ? { hasOutput: !!parsed.body.output }
            : { failureReason: parsed.body.failureReason }),
        },
        validator: (data) => data.previousStatus === "in_progress",
        // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
        filter: ({}, ctx) => ctx.deps.length > 0,
        conditions: [{ timeout_ms: 3_600_000 }], // 1 hour: task running time
      });
    }

    json(res, {
      success: true,
      alreadyFinished: "alreadyFinished" in result ? result.alreadyFinished : false,
      task: result.task,
    });
    return true;
  }

  if (listPausedTasks.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }
    const pausedTasks = getPausedTasksForAgent(myAgentId);
    json(res, { tasks: pausedTasks });
    return true;
  }

  if (pauseTaskRoute.match(req.method, pathSegments)) {
    const parsed = await pauseTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = getTaskById(parsed.params.id);

    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    if (myAgentId && task.agentId !== myAgentId) {
      jsonError(res, "Task belongs to another agent", 403);
      return true;
    }

    if (task.status !== "in_progress") {
      jsonError(res, `Task status is '${task.status}', not 'in_progress'`, 400);
      return true;
    }

    const pausedTask = pauseTask(parsed.params.id);
    if (!pausedTask) {
      jsonError(res, "Failed to pause task", 500);
      return true;
    }

    ensure({
      id: "paused",
      flow: "task",
      runId: parsed.params.id,
      depIds: ["started"],
      data: {
        taskId: parsed.params.id,
        agentId: task.agentId,
        previousStatus: task.status,
      },
      validator: (data) => data.previousStatus === "in_progress",
      // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
      filter: ({}, ctx) => ctx.deps.length > 0,
      conditions: [{ timeout_ms: 3_600_000 }], // 1 hour
    });

    json(res, { success: true, task: pausedTask });
    return true;
  }

  if (updateTaskVcsRoute.match(req.method, pathSegments)) {
    const parsed = await updateTaskVcsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = updateTaskVcs(parsed.params.id, parsed.body);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    json(res, task);
    return true;
  }

  if (resumeTaskRoute.match(req.method, pathSegments)) {
    const parsed = await resumeTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = getTaskById(parsed.params.id);

    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    if (myAgentId && task.agentId !== myAgentId) {
      jsonError(res, "Task belongs to another agent", 403);
      return true;
    }

    if (task.status !== "paused") {
      jsonError(res, `Task status is '${task.status}', not 'paused'`, 400);
      return true;
    }

    const resumedTask = resumeTask(parsed.params.id);
    if (!resumedTask) {
      jsonError(res, "Failed to resume task", 500);
      return true;
    }

    ensure({
      id: "resumed",
      flow: "task",
      runId: parsed.params.id,
      depIds: ["paused"],
      data: {
        taskId: parsed.params.id,
        agentId: task.agentId,
        previousStatus: task.status,
      },
      validator: (data) => data.previousStatus === "paused",
      // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
      filter: ({}, ctx) => ctx.deps.length > 0,
      conditions: [{ timeout_ms: 86_400_000 }], // 1 day: tasks may stay paused for extended periods
    });

    json(res, { success: true, task: resumedTask });
    return true;
  }

  return false;
}
