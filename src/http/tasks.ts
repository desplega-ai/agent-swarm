import type { IncomingMessage, ServerResponse } from "node:http";
import { ensure } from "@desplega.ai/business-use";
import { z } from "zod";
import { AssetKeyAuthorizationError, authorizeAssetKeyWrite } from "../be/asset-key-auth";
import { resolveHttpAuditUserId } from "../be/audit-user";
import {
  backfillSupersedeTaskResumeTaskId,
  cancelTask,
  completeTask,
  failTask,
  getAgentById,
  getAllTasks,
  getDbClient,
  getLeadAgent,
  getLogsByTaskId,
  getPausedTasksForAgent,
  getPendingSteeringForAgent,
  getPendingSteeringForTask,
  getSteeringMessageById,
  getSteeringMessagesForTask,
  getTaskAttachments,
  getTaskById,
  getTasksCount,
  markSteeringDelivered,
  markSteeringHandled,
  pauseTask,
  promoteDraftTask,
  resumeTask,
  supersedeTask,
  updateAgentStatusFromCapacity,
  updateTaskClaudeSessionId,
  updateTaskProgress,
  updateTaskTitle,
  updateTaskVcs,
} from "../be/db";
import {
  getTaskSteeringFields,
  markSteeringUndeliverable,
  requestSteering,
  SteeringRequestError,
} from "../be/steering";
import { findUserById } from "../be/users";
import { can, type RbacPrincipal, type RbacResource } from "../rbac";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { guardTerminalTaskResultWrite } from "../tasks/terminal-result-guard";
import { createResumeFollowUp, createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import {
  AgentLogSchema,
  type AgentTask,
  AgentTaskSchema,
  type AgentTaskSource,
  AgentTaskSourceSchema,
  type AgentTaskStatus,
  AgentTaskStatusSchema,
  AssetKeySchema,
  isTerminalTaskStatus,
  ModelTierSchema,
  OnUnsupportedSchema,
  ProviderNameSchema,
  ReasoningEffortSchema,
  ResumeReasonSchema,
  SteeringMessageSchema,
  SteeringSourceSchema,
  SteerModeSchema,
  SteerResultSchema,
  splitLegacyModelAlias,
  TaskAttachmentSchema,
} from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { scrubSecrets } from "../utils/secret-scrubber";
import { route } from "./route-def";
import { jsonError, parseBody } from "./utils";

// ─── Response Schemas ────────────────────────────────────────────────────────

/**
 * `/api/tasks` + `/api/sessions` list item shape — mirrors the `AgentTaskSummary`
 * TS type in ../types (a strict field subset of `AgentTask`): the `task` text
 * truncated to a bounded preview and completion/integration/context blobs
 * dropped. Kept in lock-step with that type's `Pick<...>` field list.
 */
const AgentTaskSummarySchema = AgentTaskSchema.pick({
  id: true,
  key: true,
  agentId: true,
  creatorAgentId: true,
  task: true,
  title: true,
  status: true,
  source: true,
  taskType: true,
  tags: true,
  priority: true,
  dependsOn: true,
  offeredTo: true,
  acceptedAt: true,
  parentTaskId: true,
  scheduleId: true,
  model: true,
  modelTier: true,
  effort: true,
  provider: true,
  requestedByUserId: true,
  progress: true,
  createdAt: true,
  lastUpdatedAt: true,
  finishedAt: true,
  peakContextPercent: true,
  totalCostUsd: true,
});

/** Shared by cancel/pause/resume — each sends `{ success: true, task }` on success. */
const TaskActionResultSchema = z.object({
  success: z.literal(true),
  task: AgentTaskSchema,
});

/** Shared by the steering-message delivered/handled callbacks — `{ message }`. */
const SteeringMessageEnvelopeSchema = z.object({ message: SteeringMessageSchema });

/** Shared by the steering-message list routes — `{ messages }`. */
const SteeringMessagesListSchema = z.object({ messages: z.array(SteeringMessageSchema) });

/** `POST /api/steering-messages/{id}/undeliverable` — promotion result. */
const SteeringUndeliverableResponseSchema = z.object({
  message: SteeringMessageSchema,
  promotedTaskId: z.string().optional(),
});

/** `GET /api/tasks/{id}` — full task decorated with steering + logs + attachments. */
const GetTaskResponseSchema = AgentTaskSchema.extend({
  isLeadTask: z.boolean(),
  supportedSteerModes: z.array(SteerModeSchema),
  logs: z.array(AgentLogSchema),
  attachments: z.array(TaskAttachmentSchema),
});

const FinishTaskSuccessSchema = z.object({
  success: z.literal(true),
  alreadyFinished: z.boolean(),
  task: AgentTaskSchema,
  message: z.string().optional(),
  wasNoOp: z.literal(true).optional(),
  wasForcedOverwrite: z.literal(true).optional(),
});

const FinishTaskConflictSchema = z.object({
  success: z.literal(false),
  message: z.string(),
  task: AgentTaskSchema,
  alreadyFinished: z.literal(true),
  error: z.string(),
});

const SupersedeTaskResponseSchema = z.object({
  success: z.literal(true),
  kind: z.enum(["alreadyFinished", "workflow-failed", "resumed"]),
  task: AgentTaskSchema.nullable(),
  resumeTaskId: z.string().nullable(),
  resumeTaskStatus: AgentTaskStatusSchema.optional(),
});

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
    key: AssetKeySchema.optional(),
    keyPrefix: AssetKeySchema.optional(),
    search: z.string().optional(),
    includeHeartbeat: z.enum(["true", "false"]).optional(),
    /** ISO 8601 — return only tasks created on/after this timestamp. */
    createdAfter: z.string().datetime().optional(),
    /** ISO 8601 — return only tasks created before this timestamp. */
    createdBefore: z.string().datetime().optional(),
    /** Comma-separated source filter (e.g. `ui,slack`). Omit to include all. */
    source: z.string().optional(),
    /**
     * When present, restrict results to tasks where `agent_tasks.requestedByUserId`
     * equals this value. The sentinel `none` matches rows where it IS NULL
     * instead. Omit to return every task regardless of requester.
     */
    requestedByUserId: z.string().min(1).optional(),
    /** `createdAt` enables stable time-axis paging; default preserves table freshness ordering. */
    orderBy: z.enum(["lastUpdatedAt", "createdAt"]).optional(),
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
    /** `full` restores the legacy shape (full `task` text + all fields); default is slim. */
    fields: z.enum(["full", "slim"]).optional(),
  }),
  responses: {
    200: {
      description: "Paginated task list",
      schema: z.object({
        tasks: z.union([z.array(AgentTaskSchema), z.array(AgentTaskSummarySchema)]),
        total: z.number().int(),
      }),
    },
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
    priority: z.number().int().min(0).max(100).optional(),
    dependsOn: z.array(z.string()).optional(),
    offeredTo: z.string().optional(),
    dir: z.string().optional(),
    parentTaskId: z.string().optional(),
    key: AssetKeySchema.optional(),
    source: AgentTaskSourceSchema.optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    contextKey: z.string().optional(),
    requestedByUserId: z.string().optional(),
    model: z.string().optional(),
    modelTier: ModelTierSchema.optional(),
    effort: ReasoningEffortSchema.optional(),
    /**
     * Create in `draft` status instead of the normal pending/unassigned/offered
     * status (#1240) — the task exists and is visible to its owner, but is not
     * dispatch-eligible. Used by the UI composer while attachments are still
     * uploading; the caller MUST promote it via `POST /api/tasks/{id}/promote-draft`
     * once the upload batch settles (or it self-promotes on a timeout).
     */
    draft: z.boolean().optional(),
  }),
  responses: {
    201: { description: "Task created", schema: AgentTaskSchema },
    400: { description: "Validation error" },
  },
});

const promoteDraftTaskRoute = route({
  method: "post",
  path: "/api/tasks/{id}/promote-draft",
  pattern: ["api", "tasks", null, "promote-draft"],
  summary: "Promote a draft task out of the pre-dispatch draft state",
  description:
    "Transitions a `draft` task (#1240 — created with attachments still uploading) to its normal dispatch-eligible status: `offered` if it was offered to an agent, `pending` if it has an owning agent (the common case — UI-composer tasks default to Lead), otherwise `unassigned`. Called by the UI composer once its attachment upload batch settles, whether every file uploaded, some failed, or all failed — a draft must never be stranded by an upload error. Idempotent: calling it on a task that already left `draft` returns the current task unchanged rather than erroring, so a retried request is safe.",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  rbac: { permission: "task.action.own" },
  responses: {
    200: { description: "Task promoted (or already out of draft)", schema: AgentTaskSchema },
    403: { description: "Caller does not own this task" },
    404: { description: "Task not found" },
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
    200: { description: "Session ID updated", schema: AgentTaskSchema },
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
    200: { description: "Task cancelled", schema: TaskActionResultSchema },
    400: { description: "Cannot cancel terminal task" },
    404: { description: "Task not found" },
  },
});

const steerTaskRoute = route({
  method: "post",
  path: "/api/tasks/{id}/steer",
  pattern: ["api", "tasks", null, "steer"],
  summary: "Deliver a steering message to a running task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({
    message: z.string().min(1),
    mode: SteerModeSchema.default("queue"),
    onUnsupported: OnUnsupportedSchema,
    // Which surface the message came from. Defaults to "api" for raw callers;
    // the UI, Slack and the script SDK identify themselves so the activity
    // feed can say where a steer originated.
    source: SteeringSourceSchema.optional(),
    requestedByUserId: z.string().optional(),
  }),
  rbac: { permission: "task.steer.own" },
  responses: {
    200: {
      description: "Steering accepted (see `outcome` for what actually happened)",
      schema: SteerResultSchema,
    },
    400: { description: "Validation error" },
    403: { description: "Caller cannot steer this task" },
    404: { description: "Task not found" },
    422: {
      description: "Requested mode unsupported by the target harness and onUnsupported=fail",
    },
  },
});

const getTaskSteeringMessagesRoute = route({
  method: "get",
  path: "/api/tasks/{id}/steering-messages",
  pattern: ["api", "tasks", null, "steering-messages"],
  summary: "List steering messages for a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Steering messages", schema: SteeringMessagesListSchema },
    404: { description: "Task not found" },
  },
});

const getPendingSteeringMessagesRoute = route({
  method: "get",
  path: "/api/steering-messages",
  pattern: ["api", "steering-messages"],
  summary: "List pending steering messages for the current worker",
  tags: ["Tasks"],
  query: z.object({ taskId: z.string().optional() }),
  auth: { apiKey: true, agentId: true },
  responses: {
    200: { description: "Pending steering messages", schema: SteeringMessagesListSchema },
    400: { description: "Missing X-Agent-ID header" },
    404: { description: "Agent not found" },
  },
});

const markSteeringDeliveredRoute = route({
  method: "post",
  path: "/api/steering-messages/{id}/delivered",
  pattern: ["api", "steering-messages", null, "delivered"],
  summary: "Mark a steering message delivered",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({ mode: SteerModeSchema }),
  auth: { apiKey: true, agentId: true },
  rbac: {
    ungated:
      "worker callback scoped by required X-Agent-ID and verified against the steering message task assignee",
  },
  responses: {
    200: {
      description: "Steering message delivery recorded",
      schema: SteeringMessageEnvelopeSchema,
    },
    400: { description: "Missing X-Agent-ID header or validation error" },
    403: { description: "Steering message task is assigned to another agent" },
    404: { description: "Agent or steering message not found" },
  },
});

const markSteeringHandledRoute = route({
  method: "post",
  path: "/api/steering-messages/{id}/handled",
  pattern: ["api", "steering-messages", null, "handled"],
  summary: "Mark a steering message handled",
  description:
    "Optionally accepts a JSON body `{ note?: string }` — a short acceptance note describing how the steering was incorporated, persisted as `handledNote`.",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  auth: { apiKey: true, agentId: true },
  rbac: {
    ungated:
      "worker acknowledgement scoped by required X-Agent-ID and verified against the steering message task assignee",
  },
  responses: {
    200: {
      description: "Steering message acknowledgement recorded",
      schema: SteeringMessageEnvelopeSchema,
    },
    400: { description: "Missing X-Agent-ID header or validation error" },
    403: { description: "Steering message task is assigned to another agent" },
    404: { description: "Agent or steering message not found" },
  },
});

const markSteeringUndeliverableRoute = route({
  method: "post",
  path: "/api/steering-messages/{id}/undeliverable",
  pattern: ["api", "steering-messages", null, "undeliverable"],
  summary: "Promote an undeliverable steering message",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({ reason: z.string().min(1) }),
  auth: { apiKey: true, agentId: true },
  rbac: {
    ungated:
      "worker callback scoped by required X-Agent-ID and verified against the steering message task assignee",
  },
  responses: {
    200: {
      description: "Steering message promoted to a follow-up task",
      schema: SteeringUndeliverableResponseSchema,
    },
    400: { description: "Missing X-Agent-ID header or validation error" },
    403: { description: "Steering message task is assigned to another agent" },
    404: { description: "Agent or steering message not found" },
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
    200: { description: "Task with logs and attachments", schema: GetTaskResponseSchema },
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
    200: { description: "Progress updated", schema: z.object({ success: z.literal(true) }) },
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
    force: z.boolean().optional(),
  }),
  auth: { apiKey: true, agentId: true },
  responses: {
    200: { description: "Task finished", schema: FinishTaskSuccessSchema },
    400: { description: "Invalid status" },
    403: { description: "Not assigned to this agent" },
    404: { description: "Task not found" },
    409: {
      description: "Differing terminal result text was discarded",
      schema: FinishTaskConflictSchema,
    },
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
    200: {
      description: "Paused task list",
      schema: z.object({ tasks: z.array(AgentTaskSchema) }),
    },
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
    200: { description: "Task paused", schema: TaskActionResultSchema },
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
    200: { description: "Task resumed", schema: TaskActionResultSchema },
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
    200: {
      description: "Task superseded (or workflow-failed)",
      schema: SupersedeTaskResponseSchema,
    },
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
    200: { description: "VCS info updated", schema: AgentTaskSchema },
    404: { description: "Task not found" },
  },
  auth: { apiKey: true },
});

const updateTaskTitleRoute = route({
  method: "patch",
  path: "/api/tasks/{id}/title",
  pattern: ["api", "tasks", null, "title"],
  summary: "Set or clear a task's display title (session rename)",
  description:
    "Sets a human-facing display title override on a task. The sessions UI only reads this from root tasks (session list items), but titles on child tasks are harmless. Pass `title: null` (or an empty string) to clear the override and fall back to the task prompt.",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({
    title: z.string().trim().max(120).nullable(),
  }),
  responses: {
    200: { description: "Title updated", schema: z.object({ task: AgentTaskSchema }) },
    404: { description: "Task not found" },
  },
  auth: { apiKey: true },
  rbac: {
    ungated: "mirrors the pre-RBAC PATCH /api/tasks/{id}/vcs sibling route: bearer auth only",
  },
});

async function canSteerTask(
  req: IncomingMessage,
  myAgentId: string | undefined,
  task: AgentTask,
): Promise<boolean> {
  const resource: RbacResource = {
    kind: "task",
    taskId: task.id,
    requestedByUserId: task.requestedByUserId,
    creatorAgentId: task.creatorAgentId,
    agentId: task.agentId,
  };
  let principal: RbacPrincipal;
  let verb: "task.steer.any" | "task.steer.own";

  const auth = getRequestAuth(req);
  if (auth?.kind === "operator") {
    principal = { kind: "operator" };
    verb = "task.steer.own";
  } else if (auth?.kind === "user") {
    principal = { kind: "user", userId: auth.userId };
    verb = "task.steer.own";
  } else {
    if (!myAgentId) return false;
    const agent = await getAgentById(myAgentId);
    if (!agent) return false;
    principal = { kind: "agent", agentId: myAgentId, isLead: agent.isLead };
    verb = "task.steer.any";
  }

  return can({ principal, verb, resource, source: "http" }).allow;
}

/**
 * Ownership gate for `task.action.own` — single verb, no `.any` counterpart:
 * the underlying `requester-owns-task` policy already lets any non-user
 * principal (agent/operator) through, so agent-side callers never need a
 * separate escalated verb. User principals must match the task's
 * `requestedByUserId`. Used by `POST /api/tasks/{id}/promote-draft`.
 */
async function canActOnOwnTask(
  req: IncomingMessage,
  myAgentId: string | undefined,
  task: AgentTask,
): Promise<boolean> {
  const resource: RbacResource = {
    kind: "task",
    taskId: task.id,
    requestedByUserId: task.requestedByUserId,
    creatorAgentId: task.creatorAgentId,
    agentId: task.agentId,
  };
  let principal: RbacPrincipal;

  const auth = getRequestAuth(req);
  if (auth?.kind === "operator") {
    principal = { kind: "operator" };
  } else if (auth?.kind === "user") {
    principal = { kind: "user", userId: auth.userId };
  } else {
    if (!myAgentId) return false;
    const agent = await getAgentById(myAgentId);
    if (!agent) return false;
    principal = { kind: "agent", agentId: myAgentId, isLead: agent.isLead };
  }

  return can({ principal, verb: "task.action.own", resource, source: "http" }).allow;
}

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
      key: parsed.query.key,
      keyPrefix: parsed.query.keyPrefix,
      search: parsed.query.search || undefined,
      includeHeartbeat: parsed.query.includeHeartbeat === "true" || undefined,
      createdAfter: parsed.query.createdAfter || undefined,
      createdBefore: parsed.query.createdBefore || undefined,
      source,
      requestedByUserId:
        parsed.query.requestedByUserId && parsed.query.requestedByUserId !== "none"
          ? parsed.query.requestedByUserId
          : undefined,
      requestedByUserIdIsNull: parsed.query.requestedByUserId === "none" || undefined,
      orderBy: parsed.query.orderBy,
      limit: parsed.query.limit,
      offset: parsed.query.offset,
    };
    // List responses default to slim (full `task` text → bounded `taskPreview`,
    // heavy blobs dropped); `?fields=full` restores the full `AgentTask`.
    const tasks =
      parsed.query.fields === "full"
        ? await getAllTasks(filters)
        : await getAllTasks(filters, { slim: true });
    const total = await getTasksCount(filters);
    listTasks.respond(res, 200, { tasks, total });
    return true;
  }

  if (createTask.match(req.method, pathSegments)) {
    const parsed = await createTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    // Prefer trusted server-side identity: an authenticated request user, or
    // the caller's own ownership-gated task context (`X-Source-Task-Id` /
    // ambient current task) — same as every other audited write site. This
    // is the upstream #939 anti-spoofing behavior.
    //
    // TRUST_BODY_REQUESTED_BY_USER_ID (default ON) accepts a body-supplied
    // `requestedByUserId` as a last resort — only when the caller could not be
    // bound to a user (shared operator key), and only after validating it
    // names a real user. Typical single-tenant deployments share ONE operator
    // key, so without this the UI and API callers can never attribute tasks.
    // Set TRUST_BODY_REQUESTED_BY_USER_ID=false anywhere holders of the
    // shared/global key are NOT all equally trusted — with it on, any such
    // caller can attribute a task to any user.
    const trustedUserId = await resolveHttpAuditUserId(req, myAgentId);
    let requestedByUserId = trustedUserId ?? undefined;
    const trustBodyRequestedByUserId = process.env.TRUST_BODY_REQUESTED_BY_USER_ID !== "false";
    if (trustBodyRequestedByUserId && !requestedByUserId && parsed.body.requestedByUserId) {
      const candidate = await findUserById(parsed.body.requestedByUserId);
      if (candidate) requestedByUserId = candidate.id;
    }

    // Default agent for ingress-created tasks: when no explicit `agentId` is
    // provided, route to the lead so the task has an owner immediately
    // (regardless of whether it's a root or a follow-up under a parentTaskId).
    // Without this, UI composer follow-ups land unassigned and never get
    // picked up. Mirrors Slack's pattern (slack/actions.ts uses lead?.id when
    // there's no working agent).
    let defaultAgentId = parsed.body.agentId || undefined;
    if (!defaultAgentId) {
      const lead = await getLeadAgent();
      if (lead) defaultAgentId = lead.id;
    }

    // Session UI follow-ups always continue with the Lead. They may inherit a
    // worker-specific affinity from their parent, which would reject the Lead
    // during direct-assignment validation. Mark the UI route explicitly
    // Lead-only so the continuation replaces that ordinary worker affinity.
    const uiLeadRouting =
      parsed.body.source === "ui" && !parsed.body.agentId && parsed.body.parentTaskId
        ? { capabilities: [], leadOnly: true }
        : undefined;

    let assetKey: string | undefined;
    try {
      const inheritedKey = parsed.body.parentTaskId
        ? (await getTaskById(parsed.body.parentTaskId))?.key
        : undefined;
      const requestedKey = parsed.body.key ?? inheritedKey;
      assetKey = requestedKey
        ? await authorizeAssetKeyWrite(requestedKey, trustedUserId)
        : undefined;
    } catch (error) {
      if (error instanceof AssetKeyAuthorizationError) {
        jsonError(res, error.message, error.statusCode);
        return true;
      }
      throw error;
    }

    try {
      const task = await createTaskWithSiblingAwareness(parsed.body.task, {
        key: assetKey,
        agentId: defaultAgentId,
        creatorAgentId: myAgentId || undefined,
        taskType: parsed.body.taskType || undefined,
        tags: parsed.body.tags || undefined,
        priority: parsed.body.priority,
        dependsOn: parsed.body.dependsOn || undefined,
        offeredTo: parsed.body.offeredTo || undefined,
        dir: parsed.body.dir || undefined,
        parentTaskId: parsed.body.parentTaskId || undefined,
        source: parsed.body.source || "api",
        routingAffinity: uiLeadRouting,
        outputSchema: parsed.body.outputSchema || undefined,
        contextKey: parsed.body.contextKey || undefined,
        requestedByUserId,
        status: parsed.body.draft ? "draft" : undefined,
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

      createTask.respond(res, 201, task);
    } catch (error) {
      console.error("[HTTP] Failed to create task:", error);
      jsonError(res, "Failed to create task", 500);
    }
    return true;
  }

  if (promoteDraftTaskRoute.match(req.method, pathSegments)) {
    const parsed = await promoteDraftTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const existingTask = await getTaskById(parsed.params.id);
    if (!existingTask) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    const allowed = await canActOnOwnTask(req, myAgentId, existingTask);
    if (!allowed) {
      jsonError(res, "Not authorized to act on this task", 403);
      return true;
    }

    // Idempotent: a task already out of `draft` (already promoted, or a
    // retried request) is returned as-is rather than erroring — the UI calls
    // this exactly once per upload batch but must stay safe under retry.
    const promoted =
      existingTask.status === "draft" ? await promoteDraftTask(parsed.params.id) : existingTask;
    if (!promoted) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    promoteDraftTaskRoute.respond(res, 200, promoted);
    return true;
  }

  if (updateSession.match(req.method, pathSegments)) {
    const parsed = await updateSession.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await updateTaskClaudeSessionId(
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
    updateSession.respond(res, 200, task);
    return true;
  }

  if (cancelTaskRoute.match(req.method, pathSegments)) {
    const parsed = await cancelTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.id);

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

    const cancelledTask = await cancelTask(parsed.params.id, reason);
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
      await updateAgentStatusFromCapacity(task.agentId);
    }

    cancelTaskRoute.respond(res, 200, { success: true, task: cancelledTask });
    return true;
  }

  if (steerTaskRoute.match(req.method, pathSegments)) {
    const parsed = await steerTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.id);

    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    if (!(await canSteerTask(req, myAgentId, task))) {
      jsonError(res, "Forbidden: caller cannot steer this task", 403);
      return true;
    }

    const trustedUserId = await await resolveHttpAuditUserId(req, myAgentId);
    let requestedByUserId = trustedUserId ?? undefined;
    if (
      process.env.TRUST_BODY_REQUESTED_BY_USER_ID !== "false" &&
      !requestedByUserId &&
      parsed.body.requestedByUserId
    ) {
      requestedByUserId = (await findUserById(parsed.body.requestedByUserId))?.id;
    }

    try {
      const auth = getRequestAuth(req);
      const createdByAgentId =
        !auth && myAgentId && (await getAgentById(myAgentId)) ? myAgentId : undefined;
      const result = await requestSteering({
        taskId: task.id,
        message: parsed.body.message,
        mode: parsed.body.mode,
        onUnsupported: parsed.body.onUnsupported,
        source: parsed.body.source ?? "api",
        createdByKind:
          auth?.kind === "user" || requestedByUserId
            ? "user"
            : createdByAgentId
              ? "agent"
              : "system",
        createdByAgentId,
        createdByUserId: requestedByUserId,
      });
      steerTaskRoute.respond(res, 200, result);
    } catch (error) {
      if (error instanceof SteeringRequestError) {
        jsonError(res, error.message, error.statusCode);
        return true;
      }
      throw error;
    }
    return true;
  }

  if (getTaskSteeringMessagesRoute.match(req.method, pathSegments)) {
    // Keep history readable after a kill-switch flip so past steering remains auditable.
    const parsed = await getTaskSteeringMessagesRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await getTaskById(parsed.params.id))) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    getTaskSteeringMessagesRoute.respond(res, 200, {
      messages: await getSteeringMessagesForTask(parsed.params.id),
    });
    return true;
  }

  if (getPendingSteeringMessagesRoute.match(req.method, pathSegments)) {
    // Keep read-only worker history available while disabled; only new requests are blocked.
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }
    const parsed = await getPendingSteeringMessagesRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await getAgentById(myAgentId))) {
      jsonError(res, "Agent not found", 404);
      return true;
    }

    if (parsed.query.taskId) {
      const task = await getTaskById(parsed.query.taskId);
      const messages =
        task?.agentId === myAgentId ? await getPendingSteeringForTask(parsed.query.taskId) : [];
      getPendingSteeringMessagesRoute.respond(res, 200, { messages });
      return true;
    }

    getPendingSteeringMessagesRoute.respond(res, 200, {
      messages: await getPendingSteeringForAgent(myAgentId),
    });
    return true;
  }

  if (markSteeringDeliveredRoute.match(req.method, pathSegments)) {
    // Do not gate drain callbacks: messages in flight must still reach a terminal state.
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }
    const parsed = await markSteeringDeliveredRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await getAgentById(myAgentId))) {
      jsonError(res, "Agent not found", 404);
      return true;
    }

    const message = await getSteeringMessageById(parsed.params.id);
    if (!message) {
      jsonError(res, "Steering message not found", 404);
      return true;
    }
    const task = await getTaskById(message.taskId);
    if (task?.agentId !== myAgentId) {
      jsonError(res, "Steering message task is assigned to another agent", 403);
      return true;
    }
    if (message.status !== "pending") {
      markSteeringDeliveredRoute.respond(res, 200, { message });
      return true;
    }

    const delivered =
      (await markSteeringDelivered(message.id, parsed.body.mode)) ??
      (await getSteeringMessageById(message.id));
    if (!delivered) {
      jsonError(res, "Failed to mark steering message delivered", 500);
      return true;
    }
    markSteeringDeliveredRoute.respond(res, 200, { message: delivered });
    return true;
  }

  if (markSteeringHandledRoute.match(req.method, pathSegments)) {
    // Do not gate drain callbacks: messages in flight must still reach a terminal state.
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }
    const parsed = await markSteeringHandledRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await getAgentById(myAgentId))) {
      jsonError(res, "Agent not found", 404);
      return true;
    }

    const message = await getSteeringMessageById(parsed.params.id);
    if (!message) {
      jsonError(res, "Steering message not found", 404);
      return true;
    }
    const task = await getTaskById(message.taskId);
    if (task?.agentId !== myAgentId) {
      jsonError(res, "Steering message task is assigned to another agent", 403);
      return true;
    }
    if (message.status !== "delivered") {
      markSteeringHandledRoute.respond(res, 200, { message });
      return true;
    }

    // Optional acceptance note ("how the steering was incorporated"). Read
    // tolerantly — existing callers post an empty body, which must stay valid.
    let note: string | undefined;
    try {
      const raw = await parseBody<{ note?: unknown }>(req);
      if (raw && typeof raw.note === "string" && raw.note.trim().length > 0) {
        note = scrubSecrets(raw.note.slice(0, 500));
      }
    } catch {
      // No/invalid JSON body — the note is optional.
    }

    const handled =
      (await markSteeringHandled(message.id, note)) ?? (await getSteeringMessageById(message.id));
    if (!handled) {
      jsonError(res, "Failed to mark steering message handled", 500);
      return true;
    }
    markSteeringHandledRoute.respond(res, 200, { message: handled });
    return true;
  }

  if (markSteeringUndeliverableRoute.match(req.method, pathSegments)) {
    // Do not gate drain callbacks: messages in flight must still reach a terminal state.
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }
    const parsed = await markSteeringUndeliverableRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await getAgentById(myAgentId))) {
      jsonError(res, "Agent not found", 404);
      return true;
    }

    const message = await getSteeringMessageById(parsed.params.id);
    if (!message) {
      jsonError(res, "Steering message not found", 404);
      return true;
    }
    const task = await getTaskById(message.taskId);
    if (task?.agentId !== myAgentId) {
      jsonError(res, "Steering message task is assigned to another agent", 403);
      return true;
    }
    if (message.status !== "pending") {
      markSteeringUndeliverableRoute.respond(res, 200, {
        message,
        promotedTaskId: message.promotedTaskId,
      });
      return true;
    }

    try {
      markSteeringUndeliverableRoute.respond(
        res,
        200,
        await markSteeringUndeliverable(message.id, parsed.body.reason),
      );
    } catch (error) {
      if (error instanceof SteeringRequestError) {
        jsonError(res, error.message, error.statusCode);
        return true;
      }
      throw error;
    }
    return true;
  }

  if (getTask.match(req.method, pathSegments)) {
    const parsed = await getTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.id);

    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    const logs = await getLogsByTaskId(parsed.params.id, parsed.query.logsLimit ?? 200);
    const attachments = await getTaskAttachments(parsed.params.id);
    getTask.respond(res, 200, {
      ...task,
      ...(await getTaskSteeringFields(task)),
      logs,
      attachments,
    });
    return true;
  }

  if (updateTaskProgressRoute.match(req.method, pathSegments)) {
    const parsed = await updateTaskProgressRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.id);

    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    await updateTaskProgress(parsed.params.id, parsed.body.progress);
    updateTaskProgressRoute.respond(res, 200, { success: true });
    return true;
  }

  if (finishTask.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }

    const parsed = await finishTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    // Explicit (plain, non-derived) return type: without it TS infers a merged
    // shape across these branches and the `"success" in result` / `"error" in
    // result` narrowing below stops working. A `Pick`/`Extract`-derived alias
    // for the middle (guard-handled) variant was tried and also defeated
    // narrowing, so its fields are spelled out by hand here — keep in sync
    // with the `handled: true` branch of `TerminalResultGuardResult`
    // (../tasks/terminal-result-guard) minus the `handled` discriminant.
    type FinishTaskTransactionResult =
      | { error: string; status: number }
      | {
          success: boolean;
          message: string;
          task: AgentTask;
          wasNoOp?: boolean;
          wasForcedOverwrite?: boolean;
          alreadyFinished: true;
        }
      | { success: true; task: AgentTask; alreadyFinished: true }
      | { task: AgentTask; wasPaused: boolean };

    // User-defined type guards (rather than inline `"x" in r && r.x` checks)
    // so TS narrows both branches of each condition — plain `&&`/`!(...)`
    // guards only narrow the true-branch (or don't narrow at all when negated),
    // leaving `result` unnarrowed (and e.g. `.task` inaccessible) for the rest
    // of this handler. Each predicate below evaluates the exact same runtime
    // condition the inline checks used to.
    const hasFinishError = (
      r: FinishTaskTransactionResult,
    ): r is Extract<FinishTaskTransactionResult, { error: string }> => "error" in r && !!r.error;
    const isFinishConflict = (
      r: FinishTaskTransactionResult,
    ): r is {
      success: false;
      message: string;
      task: AgentTask;
      wasNoOp?: boolean;
      wasForcedOverwrite?: boolean;
      alreadyFinished: true;
    } => "success" in r && r.success === false;
    const isFreshFinishResult = (
      r: FinishTaskTransactionResult,
    ): r is Extract<FinishTaskTransactionResult, { task: AgentTask; wasPaused: boolean }> =>
      !("alreadyFinished" in r && r.alreadyFinished);

    const result = await getDbClient().transaction(
      async (): Promise<FinishTaskTransactionResult> => {
        const task = await getTaskById(parsed.params.id);

        if (!task) {
          return { error: "Task not found", status: 404 };
        }

        if (task.agentId && task.agentId !== myAgentId) {
          return { error: "Task is assigned to another agent", status: 403 };
        }

        const terminalResultGuard = await guardTerminalTaskResultWrite(task, parsed.body);
        if (terminalResultGuard.handled) {
          const { handled: _handled, ...guardResult } = terminalResultGuard;
          return { ...guardResult, alreadyFinished: true };
        }

        if (task.status !== "in_progress") {
          return { success: true, task, alreadyFinished: true };
        }

        const wasPaused = task.wasPaused;

        let updatedTask: typeof task;
        if (parsed.body.status === "completed") {
          const result = await completeTask(
            parsed.params.id,
            parsed.body.output || "Completed by runner wrapper (no explicit output)",
          );
          if (!result) {
            return { error: "Failed to complete task", status: 500 };
          }
          updatedTask = result;
        } else {
          const result = await failTask(
            parsed.params.id,
            parsed.body.failureReason || "Process exited without explicit completion",
          );
          if (!result) {
            return { error: "Failed to mark task as failed", status: 500 };
          }
          updatedTask = result;
        }

        if (task.agentId) {
          await updateAgentStatusFromCapacity(task.agentId);
        }

        return { task: updatedTask, wasPaused };
      },
    );

    if (hasFinishError(result)) {
      jsonError(res, result.error, result.status ?? 500);
      return true;
    }

    if (isFinishConflict(result)) {
      finishTask.respond(res, 409, {
        ...result,
        error: "message" in result ? result.message : "Terminal result write was discarded",
      });
      return true;
    }

    if (result.task && isFreshFinishResult(result)) {
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
        const followUp = await createWorkerTaskFollowUp({
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

    finishTask.respond(res, 200, {
      success: true,
      alreadyFinished: "alreadyFinished" in result ? result.alreadyFinished : false,
      task: result.task,
      ...("message" in result ? { message: result.message } : {}),
      ...("wasNoOp" in result && result.wasNoOp ? { wasNoOp: true } : {}),
      ...("wasForcedOverwrite" in result && result.wasForcedOverwrite
        ? { wasForcedOverwrite: true }
        : {}),
    });
    return true;
  }

  if (listPausedTasks.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }
    const pausedTasks = await getPausedTasksForAgent(myAgentId);
    listPausedTasks.respond(res, 200, { tasks: pausedTasks });
    return true;
  }

  if (pauseTaskRoute.match(req.method, pathSegments)) {
    const parsed = await pauseTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.id);

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

    const pausedTask = await pauseTask(parsed.params.id);
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

    pauseTaskRoute.respond(res, 200, { success: true, task: pausedTask });
    return true;
  }

  if (updateTaskVcsRoute.match(req.method, pathSegments)) {
    const parsed = await updateTaskVcsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await updateTaskVcs(parsed.params.id, parsed.body);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    updateTaskVcsRoute.respond(res, 200, task);
    return true;
  }

  if (updateTaskTitleRoute.match(req.method, pathSegments)) {
    const parsed = await updateTaskTitleRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await updateTaskTitle(parsed.params.id, parsed.body.title);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    updateTaskTitleRoute.respond(res, 200, { task });
    return true;
  }

  if (resumeTaskRoute.match(req.method, pathSegments)) {
    const parsed = await resumeTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.id);

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

    const resumedTask = await resumeTask(parsed.params.id);
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

    resumeTaskRoute.respond(res, 200, { success: true, task: resumedTask });
    return true;
  }

  if (supersedeTaskRoute.match(req.method, pathSegments)) {
    const parsed = await supersedeTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.id);

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
      supersedeTaskRoute.respond(res, 200, {
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
      const failed = await failTask(parsed.params.id, "superseded_workflow_task");
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
      supersedeTaskRoute.respond(res, 200, {
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
    const superseded = await supersedeTask(parsed.params.id, {
      reason: parsed.body.reason,
      // resumeTaskId is attached AFTER the child is created. Lost race here
      // means no child is created at all, so the log entry's null is accurate.
      resumeTaskId: null,
    });
    if (!superseded) {
      // Worker won the race (terminal transition between status check and
      // this UPDATE). Treat as `alreadyFinished` — no resume child is created.
      const fresh = await getTaskById(parsed.params.id);
      supersedeTaskRoute.respond(res, 200, {
        success: true,
        kind: "alreadyFinished",
        task: fresh,
        resumeTaskId: null,
      });
      return true;
    }

    // Parent is now superseded. Create the resume child.
    const followUp = await createResumeFollowUp({
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
      supersedeTaskRoute.respond(res, 200, {
        success: true,
        kind: "resumed",
        task: superseded,
        resumeTaskId: null,
      });
      return true;
    }

    const resumeTaskId = followUp.task.id;
    await backfillSupersedeTaskResumeTaskId(parsed.params.id, resumeTaskId);

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

    supersedeTaskRoute.respond(res, 200, {
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
