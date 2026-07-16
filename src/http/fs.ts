import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  deleteTaskAttachment,
  getAgentById,
  getTaskAttachments,
  getTaskById,
  insertTaskAttachment,
} from "../be/db";
import {
  ensureAgentFsCredentialsForAgent,
  inviteEmailToSharedOrg,
} from "../be/seed/agent-fs-provision";
import { type FileObject, type FileScope, FilesError, normalizeFilesError } from "../fs/provider";
import { getFileStorageProvider } from "../fs/registry";
import { can, type RbacPrincipal, type RbacResource } from "../rbac";
import type { TaskAttachment } from "../types";
import { getCurrentRequestAuth, getRequestAuth } from "../utils/request-auth-context";
import { scrubSecrets } from "../utils/secret-scrubber";
import { route } from "./route-def";
import { BODY_TOO_LARGE, enforceContentLengthCap, json, jsonError } from "./utils";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const taskParams = z.object({ taskId: z.uuid() });
const attachmentParams = z.object({ taskId: z.uuid(), attachmentId: z.uuid() });

const uploadQuery = z.object({
  name: z.string().min(1),
  intent: z.string().optional(),
  description: z.string().optional(),
  isPrimary: z.enum(["true", "false"]).optional(),
});

const signedUrlQuery = z.object({
  expiresIn: z.coerce.number().int().positive().max(3600).optional(),
});

const capabilitiesRoute = route({
  method: "get",
  path: "/api/fs/capabilities",
  pattern: ["api", "fs", "capabilities"],
  summary: "Get active file-storage provider capabilities",
  tags: ["FS"],
  responses: {
    200: { description: "Active provider capabilities" },
    401: { description: "Unauthorized" },
  },
});

const ensureAgentCredentialsRoute = route({
  method: "post",
  path: "/api/fs/agent-credentials",
  pattern: ["api", "fs", "agent-credentials"],
  summary: "Ensure agent-scoped agent-fs credentials for the current agent",
  description:
    "Internal runner endpoint. The API server owns agent-fs bootstrap credentials, registers/invites the caller to the shared org when needed, and stores the generated key as an agent-scoped secret. The API key is never returned.",
  tags: ["FS"],
  body: z.object({}).optional(),
  responses: {
    200: { description: "Credential state" },
    400: { description: "Missing agent id" },
    500: { description: "Provisioning failed" },
  },
  auth: { apiKey: true, agentId: true },
});

const inviteMemberRoute = route({
  method: "post",
  path: "/api/fs/members/invite",
  pattern: ["api", "fs", "members", "invite"],
  summary: "Invite an external member into the agent-fs shared org",
  description:
    "The API server performs the invite with its own bootstrap credentials (which are API-only and never served over HTTP), provisioning the shared org/drive first when needed. Intended for the cloud control plane's Connect-to-Drive flow. No keys are returned; the invitee obtains their own key via agent-fs registration.",
  tags: ["FS"],
  body: z.object({
    email: z.email(),
    role: z.enum(["viewer", "editor", "admin"]).default("editor"),
  }),
  responses: {
    200: { description: "Invite state ({ orgId, invited })" },
    400: { description: "Invalid body" },
    500: { description: "Provisioning or invite failed" },
  },
  auth: { apiKey: true },
  rbac: {
    ungated:
      "Tenant API key is the org-owner credential; the invite runs under the API server's own bootstrap identity, no per-agent principal applies.",
  },
});

const listTaskFilesRoute = route({
  method: "get",
  path: "/api/fs/tasks/{taskId}/files",
  pattern: ["api", "fs", "tasks", null, "files"],
  summary: "List task file attachments",
  tags: ["FS"],
  params: taskParams,
  responses: {
    200: { description: "Task file attachments" },
    404: { description: "Task not found" },
  },
});

const uploadTaskFileRoute = route({
  method: "post",
  path: "/api/fs/tasks/{taskId}/files",
  pattern: ["api", "fs", "tasks", null, "files"],
  summary: "Upload a binary task file attachment",
  description:
    "Accepts a raw binary request body. Pass the display/path name as the `name` query parameter.",
  tags: ["FS"],
  params: taskParams,
  query: uploadQuery,
  responses: {
    201: { description: "Uploaded task attachment" },
    400: { description: "Validation error" },
    403: { description: "Caller cannot mutate this task" },
    404: { description: "Task not found" },
    413: { description: "Upload exceeds 50 MiB" },
  },
  auth: { apiKey: true, agentId: true },
  rbac: { permission: "task.fs.mutate" },
});

const getTaskFileRoute = route({
  method: "get",
  path: "/api/fs/tasks/{taskId}/files/{attachmentId}",
  pattern: ["api", "fs", "tasks", null, "files", null],
  summary: "Get task file attachment metadata",
  tags: ["FS"],
  params: attachmentParams,
  responses: {
    200: { description: "Task attachment metadata" },
    404: { description: "Task or attachment not found" },
  },
});

const downloadTaskFileRoute = route({
  method: "get",
  path: "/api/fs/tasks/{taskId}/files/{attachmentId}/raw",
  pattern: ["api", "fs", "tasks", null, "files", null, "raw"],
  summary: "Download raw task file bytes",
  description: "Streams raw bytes. File content is not secret-scrubbed.",
  tags: ["FS"],
  params: attachmentParams,
  responses: {
    200: { description: "Raw file bytes" },
    404: { description: "Task, attachment, or provider object not found" },
  },
});

const signedUrlTaskFileRoute = route({
  method: "get",
  path: "/api/fs/tasks/{taskId}/files/{attachmentId}/signed-url",
  pattern: ["api", "fs", "tasks", null, "files", null, "signed-url"],
  summary: "Create a provider signed GET URL for a task file",
  tags: ["FS"],
  params: attachmentParams,
  query: signedUrlQuery,
  responses: {
    200: { description: "Signed URL" },
    404: { description: "Task, attachment, or provider object not found" },
    501: { description: "Active provider does not support signed URLs" },
  },
});

const deleteTaskFileRoute = route({
  method: "delete",
  path: "/api/fs/tasks/{taskId}/files/{attachmentId}",
  pattern: ["api", "fs", "tasks", null, "files", null],
  summary: "Delete a task file attachment",
  tags: ["FS"],
  params: attachmentParams,
  responses: {
    204: { description: "Attachment deleted" },
    403: { description: "Caller cannot mutate this task" },
    404: { description: "Task or attachment not found" },
  },
  auth: { apiKey: true, agentId: true },
  rbac: { permission: "task.fs.mutate" },
});

export async function handleFs(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId?: string,
): Promise<boolean> {
  if (ensureAgentCredentialsRoute.match(req.method, pathSegments)) {
    const parsed = await ensureAgentCredentialsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const headerAgentId = req.headers["x-agent-id"];
    const agentId =
      myAgentId || (Array.isArray(headerAgentId) ? headerAgentId[0] : headerAgentId) || "";
    if (!agentId) {
      jsonError(res, "X-Agent-ID is required", 400);
      return true;
    }
    try {
      const result = await ensureAgentFsCredentialsForAgent(agentId);
      json(res, result);
    } catch (error) {
      const message = scrubSecrets(error instanceof Error ? error.message : String(error));
      jsonError(res, `Failed to provision agent-fs credentials: ${message}`, 500);
    }
    return true;
  }

  if (inviteMemberRoute.match(req.method, pathSegments)) {
    const parsed = await inviteMemberRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      const result = await inviteEmailToSharedOrg(parsed.body.email, parsed.body.role);
      json(res, result);
    } catch (error) {
      const message = scrubSecrets(error instanceof Error ? error.message : String(error));
      jsonError(res, `Failed to invite member to agent-fs shared org: ${message}`, 500);
    }
    return true;
  }

  if (downloadTaskFileRoute.match(req.method, pathSegments)) {
    const parsed = await downloadTaskFileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const attachment = findAttachment(parsed.params.taskId, parsed.params.attachmentId, res);
    if (!attachment) return true;
    return sendDownload(res, attachment);
  }

  if (signedUrlTaskFileRoute.match(req.method, pathSegments)) {
    const parsed = await signedUrlTaskFileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const attachment = findAttachment(parsed.params.taskId, parsed.params.attachmentId, res);
    if (!attachment) return true;
    return sendSignedUrl(res, attachment, parsed.query.expiresIn);
  }

  if (getTaskFileRoute.match(req.method, pathSegments)) {
    const parsed = await getTaskFileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const attachment = findAttachment(parsed.params.taskId, parsed.params.attachmentId, res);
    if (!attachment) return true;
    json(res, attachment);
    return true;
  }

  if (deleteTaskFileRoute.match(req.method, pathSegments)) {
    const parsed = await deleteTaskFileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = getTaskById(parsed.params.taskId);
    if (!task) return notFound(res, "Task not found");
    if (!canMutateTask(task, myAgentId, req)) return forbidden(res);
    const attachment = getTaskAttachments(task.id).find(
      (item) => item.id === parsed.params.attachmentId,
    );
    if (!attachment) return notFound(res, "Attachment not found");
    return sendDelete(res, attachment);
  }

  if (uploadTaskFileRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_UPLOAD_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await uploadTaskFileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = getTaskById(parsed.params.taskId);
    if (!task) return notFound(res, "Task not found");
    if (!canMutateTask(task, myAgentId, req)) return forbidden(res);
    return sendUpload(req, res, parsed.params.taskId, parsed.query, myAgentId ?? null);
  }

  if (listTaskFilesRoute.match(req.method, pathSegments)) {
    const parsed = await listTaskFilesRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!getTaskById(parsed.params.taskId)) return notFound(res, "Task not found");
    json(res, { attachments: getTaskAttachments(parsed.params.taskId) });
    return true;
  }

  if (capabilitiesRoute.match(req.method, pathSegments)) {
    const provider = getFileStorageProvider();
    json(res, { providerId: provider.id, capabilities: provider.capabilities });
    return true;
  }

  return false;
}

async function sendUpload(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  query: z.infer<typeof uploadQuery>,
  agentId: string | null,
): Promise<boolean> {
  const body = await readRawBody(req, MAX_UPLOAD_BYTES);
  if (body === BODY_TOO_LARGE) {
    jsonError(res, `Payload too large (max ${MAX_UPLOAD_BYTES} bytes)`, 413);
    return true;
  }

  const provider = getFileStorageProvider();
  const contentType = singleHeader(req, "content-type") ?? "application/octet-stream";
  const scope = { taskId, name: query.name };
  let uploaded: FileObject;
  try {
    uploaded = await provider.upload(scope, body, {
      contentType,
      sizeBytes: body.byteLength,
      message: `Upload ${query.name} for task ${taskId}`,
    });
  } catch (error) {
    return sendProviderError(res, error);
  }

  try {
    const auth = getCurrentRequestAuth();
    const attachment = insertTaskAttachment({
      taskId,
      agentId,
      name: query.name,
      kind: provider.id === "agent-fs" ? "agent-fs" : "shared-fs",
      path: uploaded.key,
      providerId: provider.id,
      providerKey: uploaded.key,
      capabilities: {
        ...provider.capabilities,
        version: uploaded.version,
        etag: uploaded.etag,
      },
      mimeType: uploaded.contentType ?? contentType,
      sizeBytes: uploaded.sizeBytes ?? body.byteLength,
      sha256: uploaded.sha256 ?? createHash("sha256").update(body).digest("hex"),
      intent: query.intent,
      description: query.description,
      isPrimary: query.isPrimary === "true",
      createdBy: auth?.kind === "user" ? auth.userId : undefined,
    });
    json(res, attachment, 201);
  } catch (error) {
    try {
      await provider.delete(scope);
    } catch (cleanupError) {
      console.warn(
        scrubSecrets(
          `[fs] upload metadata insert failed and blob cleanup failed: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        ),
      );
    }
    throw error;
  }
  return true;
}

async function sendDownload(res: ServerResponse, attachment: TaskAttachment): Promise<boolean> {
  const provider = getFileStorageProvider();
  if (backingProviderId(attachment) !== provider.id) {
    jsonError(res, "Attachment is not available for download via the active file provider", 404);
    return true;
  }
  try {
    const response = await provider.download(scopeFromAttachment(attachment));
    const headers: Record<string, string> = {
      "Content-Type":
        response.headers.get("content-type") ?? attachment.mimeType ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${attachment.name.replace(/"/g, "")}"`,
    };
    const length = response.headers.get("content-length") ?? attachment.sizeBytes?.toString();
    if (length) headers["Content-Length"] = length;
    const etag = response.headers.get("etag");
    if (etag) headers.ETag = etag;
    res.writeHead(200, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    return sendProviderError(res, error);
  }
  return true;
}

async function sendSignedUrl(
  res: ServerResponse,
  attachment: TaskAttachment,
  expiresIn?: number,
): Promise<boolean> {
  const provider = getFileStorageProvider();
  if (backingProviderId(attachment) !== provider.id) {
    jsonError(res, "Attachment is not available via the active file provider", 404);
    return true;
  }
  if (!provider.capabilities.signedUrl.supported) {
    jsonError(res, "Active file provider does not support signed URLs", 501);
    return true;
  }
  try {
    const url = await provider.url(scopeFromAttachment(attachment), { expiresIn });
    json(res, { url, expiresIn: Math.min(expiresIn ?? 3600, 3600) });
  } catch (error) {
    return sendProviderError(res, error);
  }
  return true;
}

async function sendDelete(res: ServerResponse, attachment: TaskAttachment): Promise<boolean> {
  const provider = getFileStorageProvider();
  // Only touch the provider for rows it actually backs. For pointer-only rows
  // (shared-fs worker volume, url, page) we just drop the DB pointer — the target
  // lives outside any provider and isn't ours to delete. This is also what stops
  // a mis-resolved provider delete from orphaning a real file.
  if (backingProviderId(attachment) === provider.id) {
    try {
      await provider.delete(scopeFromAttachment(attachment));
    } catch (error) {
      const normalized = normalizeFilesError(error);
      // The key is the row's real stored key, so NotFound means the object is
      // genuinely gone — dropping the DB row is correct cleanup, not an orphan.
      if (normalized.code !== "NotFound") return sendProviderError(res, normalized);
    }
  }
  deleteTaskAttachment(attachment.id);
  res.writeHead(204);
  res.end();
  return true;
}

// Resolve against the row's ACTUAL stored key + its own org/drive, rather than
// reconstructing `tasks/<taskId>/<name>`. Attachments written to agent-fs via the
// CLI live at arbitrary paths (`misc/…`, `smoke/…`); reconstruction mis-resolves
// them, which previously caused downloads to 404 and deletes to orphan the real
// file. New uploads have no stored key yet at scope-build time and keep the
// forward-looking layout.
function scopeFromAttachment(attachment: TaskAttachment): FileScope {
  const storedKey = attachment.providerKey ?? attachment.path ?? "";
  return {
    taskId: attachment.taskId,
    name: attachment.name,
    key: storedKey.trim() ? storedKey : undefined,
    orgId: attachment.orgId,
    driveId: attachment.driveId,
  };
}

// Which file-storage provider (if any) actually holds this attachment's bytes.
// Only agent-fs objects and local-fs uploads are provider-backed; `shared-fs`
// worker-volume pointers, `url`, and `page` attachments have no provider object,
// so they must never be fetched or deleted through a provider (doing so would
// mis-resolve and, on delete, orphan the real target). Note local-fs uploads are
// recorded with kind "shared-fs" but an explicit local-fs providerId, so key off
// both signals rather than kind alone.
function backingProviderId(attachment: TaskAttachment): string | null {
  if (attachment.kind === "agent-fs") return attachment.providerId ?? "agent-fs";
  if (attachment.providerId === "local-fs") return "local-fs";
  return null;
}

function findAttachment(
  taskId: string,
  attachmentId: string,
  res: ServerResponse,
): TaskAttachment | null {
  if (!getTaskById(taskId)) {
    notFound(res, "Task not found");
    return null;
  }
  const attachment = getTaskAttachments(taskId).find((item) => item.id === attachmentId);
  if (!attachment) {
    notFound(res, "Attachment not found");
    return null;
  }
  return attachment;
}

function canMutateTask(
  task: { id: string; agentId: string | null; creatorAgentId?: string },
  myAgentId: string | undefined,
  req: IncomingMessage,
): boolean {
  const resource: RbacResource = {
    kind: "task",
    taskId: task.id,
    agentId: task.agentId,
    creatorAgentId: task.creatorAgentId,
  };
  // Decision order preserved (plan Appendix A row 36): operator/user request
  // auth short-circuits BEFORE agent identity — an operator bearer with a
  // non-owner X-Agent-ID is still allowed. The agent branches only bind when
  // the request-auth context is unset.
  const auth = getRequestAuth(req);
  let principal: RbacPrincipal;
  if (auth?.kind === "operator") {
    principal = { kind: "operator" };
  } else if (auth?.kind === "user") {
    principal = { kind: "user", userId: auth.userId };
  } else {
    // A missing caller identity cannot be lead/assignee/creator — same denial
    // as before (no separate "agent not found" branch).
    if (!myAgentId) return false;
    const agent = getAgentById(myAgentId);
    principal = { kind: "agent", agentId: myAgentId, isLead: agent?.isLead ?? false };
  }
  return can({ principal, verb: "task.fs.mutate", resource, source: "http" }).allow;
}

async function readRawBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | typeof BODY_TOO_LARGE> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) return BODY_TOO_LARGE;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function notFound(res: ServerResponse, message: string): true {
  jsonError(res, message, 404);
  return true;
}

function forbidden(res: ServerResponse): true {
  jsonError(res, "Caller cannot mutate this task's files", 403);
  return true;
}

function sendProviderError(res: ServerResponse, error: unknown): true {
  const normalized = error instanceof FilesError ? error : normalizeFilesError(error);
  const status =
    normalized.code === "NotFound"
      ? 404
      : normalized.code === "Unauthorized"
        ? 403
        : normalized.code === "Conflict"
          ? 409
          : normalized.code === "ReadOnly"
            ? 501
            : normalized.status && normalized.status >= 400
              ? normalized.status
              : 500;
  jsonError(res, normalized.message, status);
  return true;
}
