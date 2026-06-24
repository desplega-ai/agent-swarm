import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  insertTaskAttachment,
  pauseTask,
  resumeTask,
  supersedeTask,
  updateAgentStatusFromCapacity,
  updateTaskClaudeSessionId,
  updateTaskProgress,
  updateTaskVcs,
} from "../be/db";
import { ModelTierSchema, splitLegacyModelAlias } from "../model-tiers";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { createResumeFollowUp, createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import {
  type AgentTaskSource,
  AgentTaskSourceSchema,
  type AgentTaskStatus,
  AgentTaskStatusSchema,
  isTerminalTaskStatus,
  ProviderNameSchema,
  ResumeReasonSchema,
  type TaskAttachment,
} from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const createTaskBodySchema = z.object({
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
});

type CreateTaskBody = z.infer<typeof createTaskBodySchema>;

const USER_UPLOAD_ATTACHMENT_MARKER = "\n\n---\nUser-uploaded attachments:\n";
const MAX_USER_UPLOAD_FILES = 5;
const MAX_USER_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_CREATE_TASK_BYTES = MAX_USER_UPLOAD_FILES * MAX_USER_UPLOAD_BYTES + 1024 * 1024;

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
  body: createTaskBodySchema,
  responses: {
    201: { description: "Task created" },
    400: { description: "Validation error" },
    413: { description: "Multipart request body too large" },
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

// ─── User Upload Helpers ─────────────────────────────────────────────────────

interface MultipartCreateTaskRequest {
  body: CreateTaskBody;
  files: UserUploadFile[];
}

interface UserUploadFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface UploadedTaskFile {
  name: string;
  path: string;
  orgId?: string;
  driveId?: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
}

interface AgentFsTarget {
  orgId?: string;
  driveId?: string;
}

interface AgentFsDriveListEntry {
  orgId?: string;
  drives?: Array<{ id?: string; isDefault?: boolean }>;
}

let agentFsTargetCache: AgentFsTarget | null = null;

function getHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function isMultipartRequest(req: IncomingMessage): boolean {
  return getHeader(req, "content-type").toLowerCase().includes("multipart/form-data");
}

function sanitizeUploadFileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() || "attachment";
  const ascii = base
    .normalize("NFKD")
    .replace(/[^\w.() -]+/g, "_")
    .replace(/\s+/g, "-")
    .replace(/_+/g, "_")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return ascii || "attachment";
}

function isUserUploadFile(value: unknown): value is UserUploadFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    "size" in value &&
    typeof (value as { size?: unknown }).size === "number"
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

class MultipartRequestTooLargeError extends Error {}

function multipartRequestTooLargeError(): MultipartRequestTooLargeError {
  return new MultipartRequestTooLargeError(
    `Multipart task creation request is too large (max ${formatBytes(
      MAX_MULTIPART_CREATE_TASK_BYTES,
    )})`,
  );
}

function sha256Hex(bytes: ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(bytes));
  return hasher.digest("hex");
}

async function readRequestBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(getHeader(req, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw multipartRequestTooLargeError();
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        req.pause();
        settle(() => reject(multipartRequestTooLargeError()));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      settle(() => resolve(Buffer.concat(chunks, totalBytes)));
    };
    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

async function parseMultipartCreateTask(req: IncomingMessage): Promise<MultipartCreateTaskRequest> {
  const body = await readRequestBuffer(req, MAX_MULTIPART_CREATE_TASK_BYTES);
  const request = new Request("http://localhost/api/tasks", {
    method: "POST",
    headers: { "content-type": getHeader(req, "content-type") },
    body,
  });
  const form = await request.formData();
  const rawPayload = form.get("payload");
  if (typeof rawPayload !== "string") {
    throw new Error("Multipart task creation requires a JSON 'payload' field");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    throw new Error("Multipart task creation payload must be valid JSON");
  }

  const files: UserUploadFile[] = [];
  for (const value of form.getAll("files")) {
    if (isUserUploadFile(value)) files.push(value);
  }
  if (files.length > MAX_USER_UPLOAD_FILES) {
    throw new Error(`Too many attachments (max ${MAX_USER_UPLOAD_FILES})`);
  }
  for (const file of files) {
    if (file.size > MAX_USER_UPLOAD_BYTES) {
      throw new Error(
        `Attachment '${file.name || "attachment"}' is too large (max ${formatBytes(
          MAX_USER_UPLOAD_BYTES,
        )})`,
      );
    }
  }

  return { body: createTaskBodySchema.parse(payload), files };
}

/** Exported for upload-limit regression tests; production callers use handleTasks. */
export const taskUploadTestHooks: {
  maxMultipartCreateTaskBytes: number;
  parseMultipartCreateTask: (req: IncomingMessage) => Promise<unknown>;
} = {
  maxMultipartCreateTaskBytes: MAX_MULTIPART_CREATE_TASK_BYTES,
  parseMultipartCreateTask,
};

async function runAgentFsJson(args: string[]): Promise<unknown> {
  const binary = process.env.AGENT_FS_BINARY || "agent-fs";
  const proc = Bun.spawn([binary, "--json", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const message = (stderr || stdout || "unknown error").trim().slice(0, 500);
    throw new Error(`agent-fs failed: ${message}`);
  }
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

async function resolveAgentFsTarget(): Promise<AgentFsTarget> {
  if (agentFsTargetCache) return agentFsTargetCache;

  const requestedOrgId = process.env.AGENT_FS_SHARED_ORG_ID || process.env.AGENT_FS_DEFAULT_ORG_ID;
  const requestedDriveId = process.env.AGENT_FS_DEFAULT_DRIVE_ID;
  if (requestedOrgId && requestedDriveId) {
    agentFsTargetCache = { orgId: requestedOrgId, driveId: requestedDriveId };
    return agentFsTargetCache;
  }

  const raw = await runAgentFsJson(["drive", "list"]);
  const entries = Array.isArray(raw) ? (raw as AgentFsDriveListEntry[]) : [];
  const matchedOrgEntry = requestedOrgId
    ? entries.find((entry) => entry.orgId === requestedOrgId)
    : undefined;
  const orgEntry = matchedOrgEntry ?? entries[0];
  const defaultDrive = orgEntry?.drives?.find((drive) => drive.isDefault) ?? orgEntry?.drives?.[0];

  agentFsTargetCache = {
    orgId: matchedOrgEntry?.orgId ?? orgEntry?.orgId ?? requestedOrgId,
    driveId: requestedDriveId || defaultDrive?.id,
  };
  return agentFsTargetCache;
}

function agentFsArgs(target: AgentFsTarget): string[] {
  return [
    ...(target.orgId ? ["--org", target.orgId] : []),
    ...(target.driveId ? ["--drive", target.driveId] : []),
  ];
}

async function uploadFilesToAgentFs(files: UserUploadFile[]): Promise<UploadedTaskFile[]> {
  if (files.length === 0) return [];

  const target = await resolveAgentFsTarget();
  const batchId = crypto.randomUUID();
  const tempDir = await mkdtemp(join(tmpdir(), "swarm-task-upload-"));
  const uploaded: UploadedTaskFile[] = [];

  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      const safeName = sanitizeUploadFileName(file.name);
      const bytes = await file.arrayBuffer();
      const sha256 = sha256Hex(bytes);
      const path = `misc/user-uploads/${batchId}/${String(index + 1).padStart(2, "0")}-${safeName}`;
      const tmpPath = join(tempDir, `${index}-${safeName}`);
      await Bun.write(tmpPath, bytes);
      await runAgentFsJson([
        ...agentFsArgs(target),
        "write",
        path,
        "--file",
        tmpPath,
        "-m",
        `User upload for task composer: ${safeName}`,
      ]);
      uploaded.push({
        name: safeName,
        path,
        orgId: target.orgId,
        driveId: target.driveId,
        mimeType: file.type || undefined,
        sizeBytes: file.size,
        sha256,
      });
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return uploaded;
}

function buildAgentFsLiveUrl(file: UploadedTaskFile): string | null {
  if (!file.orgId || !file.driveId) return null;
  const host = (process.env.AGENT_FS_LIVE_URL || "https://live.agent-fs.dev").replace(/\/+$/, "");
  return `${host}/file/~/${file.orgId}/${file.driveId}/${file.path}`;
}

function appendUserUploadAttachmentBlock(taskText: string, files: UploadedTaskFile[]): string {
  if (files.length === 0) return taskText;
  const lines = files.map((file) => {
    const meta = [file.mimeType, formatBytes(file.sizeBytes)].filter(Boolean).join(", ");
    const liveUrl = buildAgentFsLiveUrl(file);
    return `- ${file.name}${meta ? ` (${meta})` : ""}: agent-fs:${file.path}${
      liveUrl ? ` (${liveUrl})` : ""
    }`;
  });
  return `${taskText.trimEnd()}${USER_UPLOAD_ATTACHMENT_MARKER}${lines.join(
    "\n",
  )}\n\nThe user uploaded these files with this message. Use \`agent-fs download <path> --out <local-file>\` to inspect binary files, or \`agent-fs cat <path>\` for text files.`;
}

function insertUploadedTaskAttachments(
  taskId: string,
  files: UploadedTaskFile[],
): TaskAttachment[] {
  return files.map((file) =>
    insertTaskAttachment({
      taskId,
      agentId: null,
      name: file.name,
      kind: "agent-fs",
      path: file.path,
      orgId: file.orgId,
      driveId: file.driveId,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      intent: "user-upload",
      description: "Uploaded by the user from the sessions composer",
    }),
  );
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
    let body: CreateTaskBody;
    let uploadedFiles: UploadedTaskFile[] = [];

    if (isMultipartRequest(req)) {
      let parsedMultipart: MultipartCreateTaskRequest;
      try {
        parsedMultipart = await parseMultipartCreateTask(req);
      } catch (error) {
        const message =
          error instanceof z.ZodError
            ? `Validation error: ${error.issues
                .map((e) => `${e.path.join(".")}: ${e.message}`)
                .join(", ")}`
            : error instanceof Error
              ? error.message
              : "Invalid multipart task creation request";
        jsonError(res, message, error instanceof MultipartRequestTooLargeError ? 413 : 400);
        return true;
      }

      body = parsedMultipart.body;
      try {
        uploadedFiles = await uploadFilesToAgentFs(parsedMultipart.files);
      } catch (error) {
        console.error("[HTTP] Failed to upload task attachments:", error);
        jsonError(
          res,
          error instanceof Error ? error.message : "Failed to upload task attachments",
          500,
        );
        return true;
      }
    } else {
      const parsed = await createTask.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      body = parsed.body;
    }

    // Tolerant `requestedByUserId`: prevent the deleted-user race from
    // becoming a 500 — if the referenced user doesn't exist, log and drop
    // the field rather than letting the FK fail at INSERT.
    const auth = getRequestAuth(req);
    let requestedByUserId =
      auth?.kind === "user" ? auth.userId : body.requestedByUserId || undefined;
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
    let defaultAgentId = body.agentId || undefined;
    if (!defaultAgentId) {
      const lead = getLeadAgent();
      if (lead) defaultAgentId = lead.id;
    }

    try {
      const taskText = appendUserUploadAttachmentBlock(body.task, uploadedFiles);
      const task = createTaskWithSiblingAwareness(taskText, {
        agentId: defaultAgentId,
        creatorAgentId: myAgentId || undefined,
        taskType: body.taskType || undefined,
        tags: body.tags || undefined,
        priority: body.priority || 50,
        dependsOn: body.dependsOn || undefined,
        offeredTo: body.offeredTo || undefined,
        dir: body.dir || undefined,
        parentTaskId: body.parentTaskId || undefined,
        source: body.source || "api",
        outputSchema: body.outputSchema || undefined,
        contextKey: body.contextKey || undefined,
        requestedByUserId,
        ...splitLegacyModelAlias({
          model: body.model,
          modelTier: body.modelTier,
        }),
      });
      const attachments = insertUploadedTaskAttachments(task.id, uploadedFiles);

      ensure({
        id: "created",
        flow: "task",
        runId: task.id,
        data: {
          taskId: task.id,
          agentId: task.agentId,
          source: body.source || "api",
          status: task.status,
          task: task.task.slice(0, 200),
          priority: task.priority,
          tags: task.tags,
          parentTaskId: task.parentTaskId,
        },
      });

      json(res, { ...task, attachments }, 201);
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
