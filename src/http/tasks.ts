import type { IncomingMessage, ServerResponse } from "node:http";
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
} from "../be/db";
import { route } from "./route-def";
import { json, jsonError, parseBody } from "./utils";

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

      return { task: updatedTask };
    })();

    if ("error" in result && result.error) {
      jsonError(res, result.error, (result as { status?: number }).status ?? 500);
      return true;
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

    json(res, { success: true, task: pausedTask });
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

    json(res, { success: true, task: resumedTask });
    return true;
  }

  return false;
}
