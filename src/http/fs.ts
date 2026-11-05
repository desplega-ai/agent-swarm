import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  AgentFsKeyValidationError,
  ensureUserAgentFsAccount,
  mintUserAgentFsKey,
} from "../be/agent-fs-user-keys";
import { deleteTaskAttachment, getTaskAttachments, getTaskById } from "../be/db";
import { appendDraftTaskText } from "../be/db/tasks/draft-text";
import { getUserGrant } from "../be/rbac-roles";
import {
  ensureAgentFsCredentialsForAgent,
  inviteEmailToSharedOrg,
  resolveAgentFsSharedContext,
} from "../be/seed/agent-fs-provision";
import {
  backingProviderId,
  MAX_TASK_ATTACHMENT_BYTES,
  recordTaskAttachmentUpload,
  scopeFromAttachment,
} from "../be/task-attachment-store";
import { findUserById } from "../be/users";
import { getCombConfig } from "../comb/config";
import { type FileObject, FilesError, normalizeFilesError } from "../fs/provider";
import { getFileStorageProvider } from "../fs/registry";
import { can, isRbacEnabled, type RbacResource } from "../rbac";
import { type TaskAttachment, TaskAttachmentSchema } from "../types";
import { getAgentFsLiveUrl } from "../utils/constants";
import { attachmentContentDisposition } from "../utils/content-disposition";
import {
  authUser,
  authUserId,
  getCurrentRequestUserId,
  getRequestAuth,
  isOperatorAuth,
} from "../utils/request-auth-context";
import { scrubSecrets } from "../utils/secret-scrubber";
import { transcribeAudioNotes } from "../utils/transcription";
import { dashboardUserIdHeader } from "./favorite-owner";
import { createIpRateLimiter } from "./ip-rate-limit";
import { requestPrincipal } from "./request-principal";
import { route } from "./route-def";
import { canReadSession, SESSION_READ_DENIED } from "./session-access";
import { BODY_TOO_LARGE, enforceContentLengthCap, jsonError } from "./utils";

// Upload wall-clock past which the provider round-trip is worth a log line.
// Attachment stalls were invisible before: this path had no timing at all.
const SLOW_UPLOAD_LOG_MS = 3_000;

const fsKeyRateLimit = createIpRateLimiter({ capacity: 5, refillPerMs: 5 / 60_000 });

const fsContinueRateLimit = createIpRateLimiter({ capacity: 10, refillPerMs: 10 / 60_000 });

// `GET /api/fs/me` registers and invites on demand. Each Comb page load calls it once.
const fsMeRateLimit = createIpRateLimiter({ capacity: 20, refillPerMs: 20 / 60_000 });

export function _resetFsKeyRateLimitForTests(): void {
  fsKeyRateLimit.reset();
  fsContinueRateLimit.reset();
  fsMeRateLimit.reset();
}

const userAgentFsStateSchema = z.object({
  status: z
    .enum(["ready", "pending", "off", "unsupported"])
    .describe("Account readiness in agent-fs."),
  agentFsUserId: z.string().optional().describe("User ID in agent-fs when ready."),
  email: z.string().optional().describe("Email of the swarm user, when available."),
  displayName: z.string().optional().describe("Name of the swarm user when ready."),
  orgId: z.string().optional().describe("Shared agent-fs org ID when configured."),
  driveId: z.string().optional().describe("Shared agent-fs drive ID when configured."),
  reason: z.string().optional().describe("Reason the account is not ready."),
});

const userAgentFsMeRoute = route({
  method: "get",
  path: "/api/fs/me",
  pattern: ["api", "fs", "me"],
  summary: "Ensure the current user's agent-fs account and shared membership",
  tags: ["FS"],
  responses: {
    200: { description: "Account readiness", schema: userAgentFsStateSchema },
    401: { description: "User identity required" },
    403: { description: "Caller cannot join the shared org" },
    429: { description: "Limit of twenty account checks per minute reached" },
    502: { description: "agent-fs request failed" },
  },
});

const mintUserAgentFsKeyRoute = route({
  method: "post",
  path: "/api/fs/keys",
  pattern: ["api", "fs", "keys"],
  summary: "Mint a named agent-fs key for the current user",
  description: "The key is scoped to the shared org. The API returns it once and never stores it.",
  tags: ["FS"],
  body: z.object({ label: z.string().min(1).max(100) }),
  rbac: { permission: "fs.join.own" },
  responses: {
    201: {
      description: "Named key returned once and never stored",
      schema: z.object({
        apiKey: z.string().describe("Plaintext key returned once. The API never stores this key."),
        keyId: z.string(),
        label: z.string(),
        agentFsUserId: z.string(),
        orgId: z.string(),
        driveId: z.string(),
      }),
    },
    400: { description: "Invalid key label" },
    401: { description: "User identity required" },
    403: { description: "Caller cannot join the shared org" },
    409: { description: "agent-fs account or membership is pending" },
    429: { description: "Limit of five keys per minute reached" },
    501: { description: "agent_fs_too_old" },
    502: { description: "agent-fs request failed" },
    503: { description: "agent_fs_not_configured" },
  },
});

const continueToAgentFsRoute = route({
  method: "post",
  path: "/api/fs/continue",
  pattern: ["api", "fs", "continue"],
  summary: "Mint a named agent-fs key for the live agent-fs app and return the redirect URL",
  description:
    "Powers 'Continue with your swarm' on the live agent-fs app. The key travels only in the URL fragment of `redirectUrl`. The API never stores it.",
  tags: ["FS"],
  body: z.object({ returnTo: z.url().max(4096) }),
  rbac: { permission: "fs.join.own" },
  responses: {
    200: {
      description: "Redirect URL with the named key in the fragment",
      schema: z.object({
        redirectUrl: z
          .string()
          .describe(
            "`returnTo` with `#key=<af_...>&apiUrl=<browser-facing agent-fs API URL>` as its only fragment.",
          ),
      }),
    },
    400: {
      description:
        "invalid_return_to: the origin is not the live agent-fs app (AGENT_FS_LIVE_URL). org_mismatch: the `returnTo` path names an agent-fs org other than this swarm's shared org.",
    },
    401: { description: "User identity required" },
    403: { description: "Caller cannot join the shared org" },
    409: { description: "agent-fs account or membership is pending" },
    429: { description: "Limit of ten continues per minute reached" },
    501: { description: "agent_fs_too_old" },
    502: { description: "agent-fs request failed" },
    503: { description: "agent_fs_not_configured" },
  },
});

/**
 * The one origin that may receive a key: the live agent-fs app
 * (`AGENT_FS_LIVE_URL`). `AGENT_FS_APP_URL` names the dashboard that agent-fs
 * links open, so it is not a key target.
 */
function allowedReturnOrigin(): string | null {
  try {
    const { origin } = new URL(getAgentFsLiveUrl());
    return origin === "null" ? null : origin;
  } catch {
    // An unparseable URL allows nothing.
    return null;
  }
}

/**
 * The agent-fs org that a live-app URL names, or null when its path names
 * none (for example the live root, `/files`, or `/keys`). The live app puts
 * the org in `/<view>/~/<orgId>/...` (`/file`, `/detail`, `/page`, `/sql`,
 * `/members`) and in `/orgs/<orgId>/...`.
 */
export function liveAppOrgId(target: URL): string | null {
  const segments = target.pathname.split("/").slice(1);
  const raw = segments[1] === "~" ? segments[2] : segments[0] === "orgs" ? segments[1] : undefined;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

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

// Mirrors `ProviderCapabilities` from src/fs/capabilities.ts — no zod schema
// exists there (it's a plain TS type consumed by provider implementations).
const providerCapabilitiesSchema = z.object({
  signedUrl: z.object({
    supported: z.boolean(),
    maxExpiresIn: z.number().optional(),
  }),
  search: z.boolean().optional(),
  comments: z.boolean().optional(),
  versioning: z.boolean().optional(),
});

const agentFsCredentialStateSchema = z.object({
  enabled: z.boolean(),
  created: z.boolean(),
  agentId: z.string(),
  email: z.string().optional(),
  orgId: z.string().optional(),
  driveId: z.string().optional(),
});

const agentFsInviteStateSchema = z.object({
  orgId: z.string(),
  invited: z.boolean().describe("False only when the email already holds the requested role."),
  status: z
    .enum(["already_member", "added", "pending"])
    .describe(
      "already_member: no change. added: an existing agent-fs account joined the org. pending: the email has no account, so agent-fs created an invite the person must accept.",
    ),
  inviteId: z.string().optional().describe("Pending invite id (status pending)."),
  expiresAt: z.string().optional().describe("ISO time the accept link expires (status pending)."),
  acceptUrl: z
    .string()
    .optional()
    .describe(
      "Link the invitee opens to accept (status pending). agent-fs sends no email, so hand it to the person. Absent when agent-fs has no app URL configured.",
    ),
});

const signedUrlResponseSchema = z.object({
  url: z.string(),
  expiresIn: z.number(),
});

const capabilitiesRoute = route({
  method: "get",
  path: "/api/fs/capabilities",
  pattern: ["api", "fs", "capabilities"],
  summary: "Get active file-storage provider capabilities",
  tags: ["FS"],
  responses: {
    200: {
      description: "Active provider capabilities",
      schema: z.object({ providerId: z.string(), capabilities: providerCapabilitiesSchema }),
    },
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
    200: { description: "Credential state", schema: agentFsCredentialStateSchema },
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
    "The API server performs the invite with its own bootstrap credentials (which are API-only and never served over HTTP), provisioning the shared org/drive first when needed. Intended for the cloud control plane's Connect-to-Drive flow. An email with an agent-fs account is added directly (status added). An email without one gets a pending invite (status pending) with an acceptUrl when agent-fs returns one; agent-fs sends no email, so the caller must hand the link to the invitee. No keys are returned; the invitee obtains their own key via agent-fs registration.",
  tags: ["FS"],
  body: z.object({
    email: z.email(),
    role: z.enum(["viewer", "editor", "admin"]).default("editor"),
  }),
  responses: {
    200: {
      description: "Invite state ({ orgId, invited, status, acceptUrl? })",
      schema: agentFsInviteStateSchema,
    },
    400: { description: "Invalid body" },
    403: { description: "A non-admin user token named an email other than its own" },
    500: { description: "Provisioning or invite failed" },
  },
  auth: { apiKey: true },
  // The operator key and grant-all users invite any email at any role. Other
  // users may only join with their own account email, at a role the handler
  // derives from their grant.
  rbac: { permission: "fs.join.own" },
});

const listTaskFilesRoute = route({
  method: "get",
  path: "/api/fs/tasks/{taskId}/files",
  pattern: ["api", "fs", "tasks", null, "files"],
  session: { taskParam: "taskId" },
  summary: "List task file attachments",
  tags: ["FS"],
  params: taskParams,
  responses: {
    200: {
      description: "Task file attachments",
      schema: z.object({ attachments: z.array(TaskAttachmentSchema) }),
    },
    404: { description: "Task not found" },
  },
});

const uploadTaskFileRoute = route({
  method: "post",
  path: "/api/fs/tasks/{taskId}/files",
  pattern: ["api", "fs", "tasks", null, "files"],
  session: { taskParam: "taskId" },
  summary: "Upload a binary task file attachment",
  description:
    "Accepts a raw binary request body. Pass the display/path name as the `name` query parameter. An `audio/*` file uploaded to a `draft` task gets a `[File: …]` line and its transcript (or why there is none) appended to the task text before the response; a failed transcription never fails the upload.",
  tags: ["FS"],
  params: taskParams,
  query: uploadQuery,
  responses: {
    201: { description: "Uploaded task attachment", schema: TaskAttachmentSchema },
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
  session: { taskParam: "taskId" },
  summary: "Get task file attachment metadata",
  tags: ["FS"],
  params: attachmentParams,
  responses: {
    200: { description: "Task attachment metadata", schema: TaskAttachmentSchema },
    404: { description: "Task or attachment not found" },
  },
});

const downloadTaskFileRoute = route({
  method: "get",
  path: "/api/fs/tasks/{taskId}/files/{attachmentId}/raw",
  pattern: ["api", "fs", "tasks", null, "files", null, "raw"],
  session: { taskParam: "taskId" },
  summary: "Download raw task file bytes",
  description: "Streams raw bytes. File content is not secret-scrubbed.",
  tags: ["FS"],
  params: attachmentParams,
  responses: {
    200: {
      description: "Raw file bytes",
      unstructured: "Streams raw binary file bytes (Content-Type varies per attachment)",
    },
    404: { description: "Task, attachment, or provider object not found" },
  },
});

const signedUrlTaskFileRoute = route({
  method: "get",
  path: "/api/fs/tasks/{taskId}/files/{attachmentId}/signed-url",
  pattern: ["api", "fs", "tasks", null, "files", null, "signed-url"],
  session: { taskParam: "taskId" },
  summary: "Create a provider signed GET URL for a task file",
  tags: ["FS"],
  params: attachmentParams,
  query: signedUrlQuery,
  responses: {
    200: { description: "Signed URL", schema: signedUrlResponseSchema },
    404: { description: "Task, attachment, or provider object not found" },
    501: { description: "Active provider does not support signed URLs" },
  },
});

const deleteTaskFileRoute = route({
  method: "delete",
  path: "/api/fs/tasks/{taskId}/files/{attachmentId}",
  pattern: ["api", "fs", "tasks", null, "files", null],
  session: { taskParam: "taskId" },
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

type InviteRole = "viewer" | "editor" | "admin";

/**
 * The email and role an invite runs with. The operator key and grant-all users
 * keep the body as sent. Any other user joins only as itself: the body email
 * must match the account email (ignoring case), the stored spelling is used,
 * and the role is `editor` when the user may change task files, else `viewer`.
 */
async function resolveInvite(
  req: IncomingMessage,
  body: { email: string; role: InviteRole },
): Promise<{ email: string; role: InviteRole } | { denied: string }> {
  const user = authUser(getRequestAuth(req));
  if (!user || !isRbacEnabled()) return body;
  const grant = await getUserGrant(user.id);
  if (grant.grantsAll) return body;
  const decision = can({
    principal: { kind: "user", userId: user.id },
    verb: "fs.join.own",
    resource: { kind: "none" },
    source: "http",
  });
  // Admission already required the role to hold `fs.join.own`.
  if (!decision.allow) return { denied: decision.reason };
  const ownEmail = user.email?.trim();
  if (!ownEmail || ownEmail.toLowerCase() !== body.email.trim().toLowerCase()) {
    return { denied: "You can only join the shared drive with your own account email" };
  }
  return { email: ownEmail, role: grant.verbs.has("task.fs.mutate") ? "editor" : "viewer" };
}

/**
 * The `fs.join.own` gate for the resolved user, also a user picked behind the
 * operator key (`X-Swarm-User-Id`). Admission checks the caller's own grant
 * only for non-GET routes and grants the operator key everything, so this
 * reads the user's grant directly.
 */
async function denyFsJoin(userId: string): Promise<string | null> {
  const decision = can({
    principal: { kind: "user", userId },
    verb: "fs.join.own",
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) return decision.reason;
  // `can()` records the check but allows any user (legacy policy: anyAuthenticated),
  // and admission skips GETs and the operator key: under RBAC the role grant decides.
  if (!isRbacEnabled()) return null;
  const grant = await getUserGrant(userId);
  return grant.grantsAll || grant.verbs.has("fs.join.own")
    ? null
    : "missing permission 'fs.join.own'";
}

async function resolveAgentFsUserId(req: IncomingMessage): Promise<string | null> {
  const auth = getRequestAuth(req);
  if (auth?.page) return null;
  const userId = authUserId(auth);
  if (userId) return userId;
  if (!isOperatorAuth(auth) || req.headers["x-agent-id"] !== undefined) return null;
  const pickedUserId = dashboardUserIdHeader(req);
  if (!pickedUserId) return null;
  const user = await findUserById(pickedUserId);
  return user?.status === "active" ? user.id : null;
}

function respondMintFailure(
  res: ServerResponse,
  result: { status: "pending" | "unsupported" | "off"; reason: string },
): void {
  switch (result.status) {
    case "pending":
      jsonError(res, scrubSecrets(`agent-fs account pending: ${result.reason}`), 409);
      break;
    case "unsupported":
      jsonError(res, "agent_fs_too_old", 501);
      break;
    case "off":
      jsonError(res, "agent_fs_not_configured", 503);
      break;
  }
}

function respondMintError(res: ServerResponse, error: unknown): void {
  jsonError(
    res,
    scrubSecrets(error instanceof Error ? error.message : String(error)),
    error instanceof AgentFsKeyValidationError ? 400 : 502,
  );
}

export async function handleFs(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId?: string,
): Promise<boolean> {
  if (userAgentFsMeRoute.match(req.method, pathSegments)) {
    const userId = await resolveAgentFsUserId(req);
    if (!userId) {
      jsonError(res, "user identity required", 401);
      return true;
    }
    const denied = await denyFsJoin(userId);
    if (denied) {
      jsonError(res, denied, 403);
      return true;
    }
    if (!fsMeRateLimit.take(userId)) {
      jsonError(res, "Limit of twenty account checks per minute reached", 429);
      return true;
    }
    try {
      userAgentFsMeRoute.respond(res, 200, await ensureUserAgentFsAccount(userId));
    } catch (error) {
      jsonError(res, scrubSecrets(error instanceof Error ? error.message : String(error)), 502);
    }
    return true;
  }

  if (mintUserAgentFsKeyRoute.match(req.method, pathSegments)) {
    const userId = await resolveAgentFsUserId(req);
    if (!userId) {
      jsonError(res, "user identity required", 401);
      return true;
    }
    const parsed = await mintUserAgentFsKeyRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const denied = await denyFsJoin(userId);
    if (denied) {
      jsonError(res, denied, 403);
      return true;
    }
    if (!fsKeyRateLimit.take(userId)) {
      jsonError(res, "Limit of five keys per minute reached", 429);
      return true;
    }
    try {
      const result = await mintUserAgentFsKey(userId, parsed.body.label);
      if (result.status === "minted") {
        res.setHeader("Cache-Control", "no-store");
        const { status: _, ...key } = result;
        mintUserAgentFsKeyRoute.respond(res, 201, key);
      } else {
        respondMintFailure(res, result);
      }
    } catch (error) {
      respondMintError(res, error);
    }
    return true;
  }

  if (continueToAgentFsRoute.match(req.method, pathSegments)) {
    const userId = await resolveAgentFsUserId(req);
    if (!userId) {
      jsonError(res, "user identity required", 401);
      return true;
    }
    const parsed = await continueToAgentFsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const denied = await denyFsJoin(userId);
    if (denied) {
      jsonError(res, denied, 403);
      return true;
    }
    const target = new URL(parsed.body.returnTo);
    if (target.origin !== allowedReturnOrigin()) {
      jsonError(res, "invalid_return_to", 400);
      return true;
    }
    if (!fsContinueRateLimit.take(userId)) {
      jsonError(res, "Limit of ten continues per minute reached", 429);
      return true;
    }
    // The same browser-facing agent-fs URL the dashboard uses (`/status` `agent_fs.comb.api_url`).
    const browserApiUrl = getCombConfig().apiUrl;
    if (!browserApiUrl) {
      jsonError(res, "agent_fs_not_configured", 503);
      return true;
    }
    try {
      // A link for another org (for example one that names this swarm by
      // mistake) must not mint a key that the live app cannot use there.
      const linkOrgId = liveAppOrgId(target);
      if (linkOrgId) {
        const shared = await resolveAgentFsSharedContext();
        if (!shared) {
          jsonError(res, "agent_fs_not_configured", 503);
          return true;
        }
        if (shared.orgId !== linkOrgId) {
          jsonError(res, "org_mismatch", 400);
          return true;
        }
      }
      const date = new Date().toISOString().slice(0, 10);
      const result = await mintUserAgentFsKey(userId, `${target.host} · ${date}`);
      if (result.status === "minted") {
        // The fragment never reaches a server. The live app stores the key and strips it.
        target.hash = `key=${encodeURIComponent(result.apiKey)}&apiUrl=${encodeURIComponent(browserApiUrl)}`;
        res.setHeader("Cache-Control", "no-store");
        continueToAgentFsRoute.respond(res, 200, { redirectUrl: target.toString() });
      } else {
        respondMintFailure(res, result);
      }
    } catch (error) {
      respondMintError(res, error);
    }
    return true;
  }

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
      ensureAgentCredentialsRoute.respond(res, 200, result);
    } catch (error) {
      const message = scrubSecrets(error instanceof Error ? error.message : String(error));
      jsonError(res, `Failed to provision agent-fs credentials: ${message}`, 500);
    }
    return true;
  }

  if (inviteMemberRoute.match(req.method, pathSegments)) {
    const parsed = await inviteMemberRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const invite = await resolveInvite(req, parsed.body);
    if ("denied" in invite) {
      jsonError(res, invite.denied, 403);
      return true;
    }
    try {
      const result = await inviteEmailToSharedOrg(invite.email, invite.role);
      inviteMemberRoute.respond(res, 200, result);
    } catch (error) {
      const message = scrubSecrets(error instanceof Error ? error.message : String(error));
      jsonError(res, `Failed to invite member to agent-fs shared org: ${message}`, 500);
    }
    return true;
  }

  if (downloadTaskFileRoute.match(req.method, pathSegments)) {
    const parsed = await downloadTaskFileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const attachment = await findAttachment(
      req,
      myAgentId,
      parsed.params.taskId,
      parsed.params.attachmentId,
      res,
    );
    if (!attachment) return true;
    return sendDownload(res, attachment);
  }

  if (signedUrlTaskFileRoute.match(req.method, pathSegments)) {
    const parsed = await signedUrlTaskFileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const attachment = await findAttachment(
      req,
      myAgentId,
      parsed.params.taskId,
      parsed.params.attachmentId,
      res,
    );
    if (!attachment) return true;
    return sendSignedUrl(res, attachment, parsed.query.expiresIn);
  }

  if (getTaskFileRoute.match(req.method, pathSegments)) {
    const parsed = await getTaskFileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const attachment = await findAttachment(
      req,
      myAgentId,
      parsed.params.taskId,
      parsed.params.attachmentId,
      res,
    );
    if (!attachment) return true;
    getTaskFileRoute.respond(res, 200, attachment);
    return true;
  }

  if (deleteTaskFileRoute.match(req.method, pathSegments)) {
    const parsed = await deleteTaskFileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.taskId);
    if (!task) return notFound(res, "Task not found");
    if (!(await canMutateTask(task, myAgentId, req))) return forbidden(res);
    const attachment = (await getTaskAttachments(task.id)).find(
      (item) => item.id === parsed.params.attachmentId,
    );
    if (!attachment) return notFound(res, "Attachment not found");
    return sendDelete(res, attachment);
  }

  if (uploadTaskFileRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_TASK_ATTACHMENT_BYTES) === BODY_TOO_LARGE)
      return true;
    const parsed = await uploadTaskFileRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = await getTaskById(parsed.params.taskId);
    if (!task) return notFound(res, "Task not found");
    if (!(await canMutateTask(task, myAgentId, req))) return forbidden(res);
    return sendUpload(
      req,
      res,
      parsed.params.taskId,
      parsed.query,
      myAgentId ?? null,
      task.status === "draft",
    );
  }

  if (listTaskFilesRoute.match(req.method, pathSegments)) {
    const parsed = await listTaskFilesRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await getTaskById(parsed.params.taskId))) return notFound(res, "Task not found");
    if (!(await canReadSession(req, myAgentId, parsed.params.taskId))) {
      jsonError(res, SESSION_READ_DENIED, 403);
      return true;
    }
    listTaskFilesRoute.respond(res, 200, {
      attachments: await getTaskAttachments(parsed.params.taskId),
    });
    return true;
  }

  if (capabilitiesRoute.match(req.method, pathSegments)) {
    const provider = getFileStorageProvider();
    capabilitiesRoute.respond(res, 200, {
      providerId: provider.id,
      capabilities: provider.capabilities,
    });
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
  isDraft: boolean,
): Promise<boolean> {
  const body = await readRawBody(req, MAX_TASK_ATTACHMENT_BYTES);
  if (body === BODY_TOO_LARGE) {
    jsonError(res, `Payload too large (max ${MAX_TASK_ATTACHMENT_BYTES} bytes)`, 413);
    return true;
  }

  const provider = getFileStorageProvider();
  const contentType = singleHeader(req, "content-type") ?? "application/octet-stream";
  const scope = { taskId, name: query.name };
  let uploaded: FileObject;
  const uploadStartedAt = performance.now();
  try {
    uploaded = await provider.upload(scope, body, {
      contentType,
      sizeBytes: body.byteLength,
      message: `Upload ${query.name} for task ${taskId}`,
    });
    const elapsedMs = performance.now() - uploadStartedAt;
    if (elapsedMs >= SLOW_UPLOAD_LOG_MS) {
      console.warn(
        scrubSecrets(
          `[fs] slow upload provider=${provider.id} task=${taskId} bytes=${body.byteLength} elapsedMs=${Math.round(elapsedMs)}`,
        ),
      );
    }
  } catch (error) {
    if (error instanceof FilesError && error.code === "Timeout") {
      console.warn(
        scrubSecrets(
          `[fs] upload timed out provider=${provider.id} task=${taskId} bytes=${body.byteLength} elapsedMs=${Math.round(performance.now() - uploadStartedAt)}`,
        ),
      );
    }
    return sendProviderError(res, error);
  }

  const attachment = await recordTaskAttachmentUpload({
    provider,
    scope,
    uploaded,
    sizeBytes: body.byteLength,
    sha256: uploaded.sha256 ?? new Bun.CryptoHasher("sha256").update(body).digest("hex"),
    contentType,
    agentId,
    intent: query.intent,
    description: query.description,
    isPrimary: query.isPrimary === "true",
    createdBy: getCurrentRequestUserId(),
  });
  const mimeType = contentType.split(";")[0]!.trim().toLowerCase();
  if (isDraft && mimeType.startsWith("audio/")) {
    await appendAudioTranscript(taskId, query.name, mimeType, body);
  }
  uploadTaskFileRoute.respond(res, 201, attachment);
  return true;
}

/**
 * A voice note uploaded to a draft (the composer's pre-dispatch window) gets
 * its transcript in the task text, as one sent over Slack or a chat app does.
 * Runs before the upload responds, so the composer promotes the draft only
 * after the text is final. Never throws: the attachment has already landed.
 */
async function appendAudioTranscript(
  taskId: string,
  name: string,
  mimeType: string,
  body: Buffer,
): Promise<void> {
  try {
    const notes = await transcribeAudioNotes(
      [{ key: name, name, data: new Blob([body], { type: mimeType }), mimeType }],
      "[fs]",
    );
    const note = notes.get(name);
    if (!note) return;
    if (!(await appendDraftTaskText(taskId, `[File: ${name} (${mimeType})]\n${note}`))) {
      console.warn(`[fs] task ${taskId} left draft before the transcript of ${name} was added`);
    }
  } catch (error) {
    console.warn(
      scrubSecrets(
        `[fs] could not add the transcript of ${name} to task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
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
      "Content-Disposition": attachmentContentDisposition(attachment.name),
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
    signedUrlTaskFileRoute.respond(res, 200, { url, expiresIn: Math.min(expiresIn ?? 3600, 3600) });
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
  await deleteTaskAttachment(attachment.id);
  res.writeHead(204);
  res.end();
  return true;
}

async function findAttachment(
  req: IncomingMessage,
  myAgentId: string | undefined,
  taskId: string,
  attachmentId: string,
  res: ServerResponse,
): Promise<TaskAttachment | null> {
  if (!(await getTaskById(taskId))) {
    notFound(res, "Task not found");
    return null;
  }
  if (!(await canReadSession(req, myAgentId, taskId))) {
    jsonError(res, SESSION_READ_DENIED, 403);
    return null;
  }
  const attachment = (await getTaskAttachments(taskId)).find((item) => item.id === attachmentId);
  if (!attachment) {
    notFound(res, "Attachment not found");
    return null;
  }
  return attachment;
}

async function canMutateTask(
  task: { id: string; agentId: string | null; creatorAgentId?: string },
  myAgentId: string | undefined,
  req: IncomingMessage,
): Promise<boolean> {
  const resource: RbacResource = {
    kind: "task",
    taskId: task.id,
    agentId: task.agentId,
    creatorAgentId: task.creatorAgentId,
  };
  // Decision order preserved (plan Appendix A row 36): operator/user request
  // auth short-circuits BEFORE agent identity — an operator bearer with a
  // non-owner X-Agent-ID is still allowed. The agent branches only bind when
  // the request-auth context is unset. A missing caller identity cannot be
  // lead/assignee/creator: same denial as before (no separate "agent not
  // found" branch).
  const principal = await requestPrincipal(req, myAgentId);
  if (!principal) return false;
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
            : normalized.code === "Timeout"
              ? 504
              : normalized.status && normalized.status >= 400
                ? normalized.status
                : 500;
  jsonError(res, normalized.message, status);
  return true;
}
