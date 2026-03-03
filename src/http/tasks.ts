import type { IncomingMessage, ServerResponse } from "node:http";
import {
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
  updateAgentStatus,
  updateAgentStatusFromCapacity,
  updateTaskClaudeSessionId,
} from "../be/db";
import type { AgentStatus } from "../types";

export async function handleTasks(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    !pathSegments[2]
  ) {
    const status = queryParams.get("status") as import("./types").AgentTaskStatus | null;
    const agentId = queryParams.get("agentId");
    const epicId = queryParams.get("epicId");
    const scheduleId = queryParams.get("scheduleId");
    const search = queryParams.get("search");
    const includeHeartbeat = queryParams.get("includeHeartbeat") === "true";
    const limit = queryParams.get("limit") ? Number(queryParams.get("limit")) : undefined;
    const offset = queryParams.get("offset") ? Number(queryParams.get("offset")) : undefined;
    const filters = {
      status: status || undefined,
      agentId: agentId || undefined,
      epicId: epicId || undefined,
      scheduleId: scheduleId || undefined,
      search: search || undefined,
      includeHeartbeat: includeHeartbeat || undefined,
      limit,
      offset,
    };
    const tasks = getAllTasks(filters);
    const total = getTasksCount(filters);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks, total }));
    return true;

  }

  // POST /api/tasks - Create a new task
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    !pathSegments[2]
  ) {
    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // Validate required fields
    if (!body.task || typeof body.task !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'task' field" }));
      return true;

    }

    try {
      // Create task with provided options
      const task = createTaskExtended(body.task, {
        agentId: body.agentId || undefined,
        creatorAgentId: myAgentId || undefined,
        taskType: body.taskType || undefined,
        tags: body.tags || undefined,
        priority: body.priority || 50,
        dependsOn: body.dependsOn || undefined,
        offeredTo: body.offeredTo || undefined,
        parentTaskId: body.parentTaskId || undefined,
        source: body.source || "api",
      });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
    } catch (error) {
      console.error("[HTTP] Failed to create task:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to create task" }));
    }
    return true;

  }

  // PUT /api/tasks/:id/claude-session - Update Claude session ID (called by runner)
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "claude-session"
  ) {
    const taskId = pathSegments[2];
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.claudeSessionId || typeof body.claudeSessionId !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'claudeSessionId' field" }));
      return true;

    }

    const task = updateTaskClaudeSessionId(taskId, body.claudeSessionId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return true;

    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(task));
    return true;

  }

  // GET /api/tasks/:id - Get single task with logs
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2]
  ) {
    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return true;

    }

    const logs = getLogsByTaskId(taskId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...task, logs }));
    return true;

  }

  // POST /api/tasks/:id/finish - Mark task as completed or failed (runner wrapper endpoint)
  // This endpoint is called by the runner when a Claude process exits to ensure task status is updated
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "finish"
  ) {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return true;

    }

    const taskId = pathSegments[2];

    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // Validate status field
    if (!body.status || !["completed", "failed"].includes(body.status)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Missing or invalid 'status' field (must be 'completed' or 'failed')",
        }),
      );
      return true;

    }

    const result = getDb().transaction(() => {
      const task = getTaskById(taskId);

      if (!task) {
        return { error: "Task not found", status: 404 };
      }

      // Only allow the assigned agent (or task creator if unassigned) to finish the task
      if (task.agentId && task.agentId !== myAgentId) {
        return { error: "Task is assigned to another agent", status: 403 };
      }

      // Only finish tasks that are in_progress (prevent double-finishing)
      if (task.status !== "in_progress") {
        // Task already finished or not started - return success with current state
        return { task, alreadyFinished: true };
      }

      let updatedTask: typeof task;
      if (body.status === "completed") {
        const result = completeTask(
          taskId,
          body.output || "Completed by runner wrapper (no explicit output)",
        );
        if (!result) {
          return { error: "Failed to complete task", status: 500 };
        }
        updatedTask = result;
      } else {
        const result = failTask(
          taskId,
          body.failureReason || "Process exited without explicit completion",
        );
        if (!result) {
          return { error: "Failed to mark task as failed", status: 500 };
        }
        updatedTask = result;
      }

      // Update agent status based on remaining capacity
      if (task.agentId) {
        updateAgentStatusFromCapacity(task.agentId);
      }

      return { task: updatedTask };
    })();

    if ("error" in result) {
      res.writeHead(result.status ?? 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
      return true;

    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        alreadyFinished: result.alreadyFinished ?? false,
        task: result.task,
      }),
    );
    return true;

  }

  // GET /api/paused-tasks - Get paused tasks for this agent
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "paused-tasks") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return true;

    }

    const pausedTasks = getPausedTasksForAgent(myAgentId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks: pausedTasks }));
    return true;

  }

  // POST /api/tasks/:id/pause - Pause an in-progress task (for graceful shutdown)
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "pause"
  ) {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return true;

    }

    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return true;

    }

    // Only allow the assigned agent to pause their own task
    if (task.agentId !== myAgentId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task belongs to another agent" }));
      return true;

    }

    if (task.status !== "in_progress") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Task status is '${task.status}', not 'in_progress'` }));
      return true;

    }

    const pausedTask = pauseTask(taskId);
    if (!pausedTask) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to pause task" }));
      return true;

    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, task: pausedTask }));
    return true;

  }

  // POST /api/tasks/:id/resume - Resume a paused task
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "tasks" &&
    pathSegments[2] &&
    pathSegments[3] === "resume"
  ) {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
      return true;

    }

    const taskId = pathSegments[2];
    const task = getTaskById(taskId);

    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return true;

    }

    // Only allow the assigned agent to resume their own task
    if (task.agentId !== myAgentId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task belongs to another agent" }));
      return true;

    }

    if (task.status !== "paused") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Task status is '${task.status}', not 'paused'` }));
      return true;

    }

    const resumedTask = resumeTask(taskId);
    if (!resumedTask) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to resume task" }));
      return true;

    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, task: resumedTask }));
    return true;

  }


  return false;
}
