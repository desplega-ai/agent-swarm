import type { IncomingMessage, ServerResponse } from "node:http";
import { ensure } from "@desplega.ai/business-use";
import { z } from "zod";
import {
  backfillSupersedeTaskResumeTaskId,
  cancelTask,
  completeTask,
  failTask,
  getAllTasks,
  getDb,
  getLeadAgent,
  getLogsByTaskId,
  getPausedTasksForAgent,
  getTaskAttachments,
  getTaskById,
  getTasksCount,
  getUserById,
  pauseTask,
  resumeTask,
  supersedeTask,
  updateAgentStatusFromCapacity,
  updateTaskClaudeSessionId,
  updateTaskProgress,
  updateTaskVcs,
} from "../be/db";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { createResumeFollowUp, createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import {
  type AgentTaskSource,
  AgentTaskSourceSchema,
  type AgentTaskStatus,
  AgentTaskStatusSchema,
  isTerminalTaskStatus,
  ModelTierSchema,
  ProviderNameSchema,
  ReasoningEffortSchema,
  ResumeReasonSchema,
  splitLegacyModelAlias,
} from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listTasks = route({
  method: "get",
  path: "/api/tasks",
  pattern: ["api", "tasks"],
  summary: "List tasks with filters",
  description:
    "Returns tasks with the full `task` text replaced by a bounded `taskPreview` and completion/integration blobs dropped by default — list views only need the preview. Pass `fields=full` to restore the full `AgentTask`. Fetch a single task in full via `GET /api/tasks/{id}`.",
  tags: ["Tasks"],
  query: z.object({
    /** Single status, or comma-separated list (e.g. "failed,cancelled"). */
    status: z.string().optional(),
    agentId: z.string().optional(),
    scheduleId: z.string().optional(),
    search: z.string().optional(),
    includeHeartbeat: z.enum(["true", "false"]).optional(),
    /** ISO 8601 — return only tasks created on/after this timestamp. */
    createdAfter: z.string().datetime().optional(),
    /** Comma-separated source filter (e.g. `ui,slack`). Omit to include all. */
    source: z.string().optional(),
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
    /** `full` restores the legacy shape (full `task` text + all fields); default is slim. */
    fields: z.enum(["full", "slim"]).optional(),
  }),
  responses: {
    200: { description: "Paginated task list" },
    400: { description: "Validation error (e.g. unknown status token)" },
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
    source: AgentTaskSourceSchema.optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    contextKey: z.string().optional(),
    requestedByUserId: z.string().optional(),
    model: z.string().optional(),
    modelTier: ModelTierSchema.optional(),
    effort: ReasoningEffortSchema.optional(),
  }),
  responses: {
    201: { description: "Task created" },
    400: { description: "Validation error" },
  },
});

const updateSession = route({
  method: "put",
  path: "/api/tasks/{id}/session",
  pattern: ["api", "tasks", null, "session"],
  summary: "Update provider session ID and harness metadata for a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.union([
    z.object({
      claudeSessionId: z.string().min(1),
      provider: z.literal("devin"),
      model: z.string().optional(),
      providerMeta: z.object({
        sessionUrl: z.string(),
        maxAcuLimit: z.number().optional(),
        acuCostUsd: z.number().optional(),
      }),
    }),
    z.object({
      claudeSessionId: z.string().min(1),
      provider: ProviderNameSchema.exclude(["devin"]).optional(),
      model: z.string().optional(),
      providerMeta: z.object({}).optional(),
      harnessVariant: z.string().optional(),
      harnessVariantMeta: z.record(z.string(), z.unknown()).optional(),
    }),
  ]),
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
  summary: "Get task details with logs and attachments",
  description:
    "Returns the full `AgentTask` row decorated with `logs` (capped by `logsLimit`) and `attachments` (pointer-based artifacts stored on the task, ordered by `created_at`).",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  query: z.object({
    /** Max number of log entries to return (newest-first). Default 200. */
    logsLimit: z.coerce.number().int().min(1).max(1000).optional(),
  }),
  responses: {
    200: { description: "Task with logs and attachments" },
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

const supersedeTaskRoute = route({
  method: "post",
  path: "/api/tasks/{id}/supersede",
  pattern: ["api", "tasks", null, "supersede"],
  summary: "Supersede an in-progress task (terminate + spawn resume follow-up)",
  description:
    'Marks the original task `superseded` (terminal) and creates a fresh `taskType="resume"` follow-up so a worker can pick up the work in a new provider session. Workflow-step tasks (those with `workflowRunStepId`) are carved out: the original is marked `failed` with reason `superseded_workflow_task` and no follow-up is created — the workflow engine\'s retry/failure policy applies.',
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({ reason: ResumeReasonSchema }),
  auth: { apiKey: true, agentId: true },
  responses: {
    200: { description: "Task superseded (or workflow-failed)" },
    400: { description: "Task not in_progress" },
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

    // Multi-status CSV: split on `,` and validate each token against the
    // canonical enum. Empty / single-status callers still work.
    let status: AgentTaskStatus | AgentTaskStatus[] | undefined;
    if (parsed.query.status) {
      const tokens = parsed.query.status
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const validated: AgentTaskStatus[] = [];
      for (const tok of tokens) {
        const result = AgentTaskStatusSchema.safeParse(tok);
        if (!result.success) {
          jsonError(res, `Invalid status token: ${tok}`, 400);
          return true;
        }
        validated.push(result.data);
      }
      status = validated.length === 1 ? validated[0] : validated;
    }

    let source: AgentTaskSource[] | undefined;
    if (parsed.query.source) {
      const tokens = parsed.query.source
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const validated: AgentTaskSource[] = [];
      for (const tok of tokens) {
        const result = AgentTaskSourceSchema.safeParse(tok);
        if (!result.success) {
          jsonError(res, `Invalid source token: ${tok}`, 400);
          return true;
        }
        validated.push(result.data);
      }
      if (validated.length > 0) source = validated;
    }

    const filters = {
      status,
      agentId: parsed.query.agentId || undefined,
      scheduleId: parsed.query.scheduleId || undefined,
      search: parsed.query.search || undefined,
      includeHeartbeat: parsed.query.includeHeartbeat === "true" || undefined,
      createdAfter: parsed.query.createdAfter || undefined,
      source,
      limit: parsed.query.limit,
      offset: parsed.query.offset,
    };
    // List responses default to slim (full `task` text → bounded `taskPreview`,
    // heavy blobs dropped); `?fields=full` restores the full `AgentTask`.
    const tasks =
      parsed.query.fields === "full" ? getAllTasks(filters) : getAllTasks(filters, { slim: true });
    const total = getTasksCount(filters);
    json(res, { tasks, total });
    return true;
  }

  if (createTask.match(req.method, pathSegments)) {
    const parsed = await createTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    // Tolerant `requestedByUserId`: prevent the deleted-user race from
    // becoming a 500 — if the referenced user doesn't exist, log and drop
    // the field rather than letting the FK fail at INSERT.
    const auth = getRequestAuth(req);
    let requestedByUserId =
      auth?.kind === "user" ? auth.userId : parsed.body.requestedByUserId || undefined;
    if (requestedByUserId && !getUserById(requestedByUserId)) {
      console.warn(
        `[tasks] requestedByUserId ${requestedByUserId} does not exist — coercing to NULL`,
      );
      requestedByUserId = undefined;
    }

    // Default agent for ingress-created tasks: when no explicit `agentId` is
    // provided, route to the lead so the task has an owner immediately
    // (regardless of whether it's a root or a follow-up under a parentTaskId).
    // Without this, UI composer follow-ups land unassigned and never get
    // picked up. Mirrors Slack's pattern (slack/actions.ts uses lead?.id when
    // there's no working agent).
    let defaultAgentId = parsed.body.agentId || undefined;
    if (!defaultAgentId) {
      const lead = getLeadAgent();
      if (lead) defaultAgentId = lead.id;
    }

    try {
      const task = createTaskWithSiblingAwareness(parsed.body.task, {
        agentId: defaultAgentId,
        creatorAgentId: myAgentId || undefined,
        taskType: parsed.body.taskType || undefined,
        tags: parsed.body.tags || undefined,
        priority: parsed.body.priority || 50,
        dependsOn: parsed.body.dependsOn || undefined,
        offeredTo: parsed.body.offeredTo || undefined,
        dir: parsed.body.dir || undefined,
        parentTaskId: parsed.body.parentTaskId || undefined,
        source: parsed.body.source || "api",
        outputSchema: parsed.body.outputSchema || undefined,
        contextKey: parsed.body.contextKey || undefined,
        requestedByUserId,
        ...splitLegacyModelAlias({
          model: parsed.body.model,
          modelTier: parsed.body.modelTier,
        }),
        effort: parsed.body.effort,
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
        },
      });

      json(res, task, 201);
    } catch (error) {
      console.error("[HTTP] Failed to create task:", error);
      jsonError(res, "Failed to create task", 500);
    }
    return true;
  }

  if (updateSession.match(req.method, pathSegments)) {
    const parsed = await updateSession.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = updateTaskClaudeSessionId(
      parsed.params.id,
      parsed.body.claudeSessionId,
      parsed.body.provider,
      parsed.body.providerMeta,
      parsed.body.model,
      "harnessVariant" in parsed.body ? parsed.body.harnessVariant : undefined,
      "harnessVariantMeta" in parsed.body ? parsed.body.harnessVariantMeta : undefined,
    );
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

    if (isTerminalTaskStatus(task.status)) {
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

    const logs = getLogsByTaskId(parsed.params.id, parsed.query.logsLimit ?? 200);
    const attachments = getTaskAttachments(parsed.params.id);
    json(res, { ...task, logs, attachments });
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

      try {
        const followUp = createWorkerTaskFollowUp({
          task: result.task,
          status: parsed.body.status,
          output: parsed.body.output,
          failureReason: parsed.body.failureReason,
        });
        if (followUp) {
          console.log(
            `[tasks.finish] Created follow-up task ${followUp.id.slice(0, 8)} for ${parsed.body.status} task ${parsed.params.id.slice(0, 8)}`,
          );
        }
      } catch (err) {
        console.warn(`[tasks.finish] Failed to create follow-up task: ${err}`);
      }
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

  if (supersedeTaskRoute.match(req.method, pathSegments)) {
    const parsed = await supersedeTaskRoute.parse(req, res, pathSegments, queryParams);
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

    // Idempotency: if already terminal, return the alreadyFinished-shaped
    // response (mirrors finishTask). Caller treats this as a successful
    // supersede.
    if (isTerminalTaskStatus(task.status)) {
      json(res, {
        success: true,
        kind: "alreadyFinished",
        task,
        resumeTaskId: null,
      });
      return true;
    }

    if (task.status !== "in_progress") {
      jsonError(res, `Task status is '${task.status}', not 'in_progress'`, 400);
      return true;
    }

    // Workflow-step tasks: fail back to the engine instead of superseding.
    // Check this BEFORE the supersede UPDATE so we don't leave a workflow
    // step in `superseded` if the engine expects `failed`.
    if (task.workflowRunStepId != null) {
      const failed = failTask(parsed.params.id, "superseded_workflow_task");
      ensure({
        id: "task.workflow_step_failed_on_supersede",
        flow: "task",
        runId: parsed.params.id,
        data: {
          taskId: parsed.params.id,
          agentId: task.agentId,
          stepId: task.workflowRunStepId,
          reason: parsed.body.reason,
        },
      });
      json(res, {
        success: true,
        kind: "workflow-failed",
        task: failed,
        resumeTaskId: null,
      });
      return true;
    }

    // Supersede FIRST (atomic + idempotent in db.ts) so we don't orphan a
    // resume child if a worker races to complete/fail/cancel between the
    // pre-read status check and the supersede UPDATE.
    const superseded = supersedeTask(parsed.params.id, {
      reason: parsed.body.reason,
      // resumeTaskId is attached AFTER the child is created. Lost race here
      // means no child is created at all, so the log entry's null is accurate.
      resumeTaskId: null,
    });
    if (!superseded) {
      // Worker won the race (terminal transition between status check and
      // this UPDATE). Treat as `alreadyFinished` — no resume child is created.
      const fresh = getTaskById(parsed.params.id);
      json(res, {
        success: true,
        kind: "alreadyFinished",
        task: fresh,
        resumeTaskId: null,
      });
      return true;
    }

    // Parent is now superseded. Create the resume child.
    const followUp = createResumeFollowUp({
      parentId: parsed.params.id,
      reason: parsed.body.reason,
    });

    // `workflow-skip` is unreachable here (workflow-step path branched above).
    // `skipped` covers parent_not_found / lead_not_found edge cases — the
    // supersede already landed, so log + roll forward without a resume task.
    if (followUp.kind !== "created") {
      console.warn(
        `[Supersede] Task ${parsed.params.id.slice(0, 8)} superseded but resume creation skipped (${
          followUp.kind === "skipped" ? followUp.reason : followUp.kind
        })`,
      );
      json(res, {
        success: true,
        kind: "resumed",
        task: superseded,
        resumeTaskId: null,
      });
      return true;
    }

    const resumeTaskId = followUp.task.id;
    backfillSupersedeTaskResumeTaskId(parsed.params.id, resumeTaskId);

    ensure({
      id: "task.superseded",
      flow: "task",
      runId: parsed.params.id,
      data: {
        taskId: parsed.params.id,
        agentId: task.agentId,
        reason: parsed.body.reason,
        resumeTaskId,
      },
    });

    json(res, {
      success: true,
      kind: "resumed",
      task: superseded,
      resumeTaskId,
      resumeTaskStatus: followUp.task.status,
    });
    return true;
  }

  return false;
}
