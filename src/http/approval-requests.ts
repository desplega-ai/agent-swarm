import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveTaskAuditUserId } from "../be/audit-user";
import {
  type ApprovalRequest,
  createApprovalRequest,
  getAgentById,
  getApprovalRequestById,
  getDbClient,
  getWorkflowRun,
  getWorkflowRunStep,
  listApprovalRequests,
  resolveApprovalRequest,
} from "../be/db";
import type { RbacPrincipal } from "../rbac";
import { getRequestAuth } from "../utils/request-auth-context";
import { cancelApprovalRequest } from "../workflows/approval-cancel";
import { createApprovalFollowUpTask } from "../workflows/approval-notifications";
import { workflowEventBus } from "../workflows/event-bus";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const QuestionSchema = z.object({
  id: z.string(),
  type: z.enum(["approval", "text", "single-select", "multi-select", "boolean"]),
  label: z.string(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  multiline: z.boolean().optional(),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  minSelections: z.number().int().min(0).optional(),
  maxSelections: z.number().int().min(1).optional(),
  defaultValue: z.boolean().optional(),
});

export type ApprovalQuestion = z.infer<typeof QuestionSchema>;

// ─── Response Schemas ────────────────────────────────────────────────────────
// `ApprovalRequest` (src/be/db.ts) types `questions`/`approvers`/`responses`/
// `notificationChannels` as `unknown` — the DB layer stores opaque JSON blobs.
// Reading every writer (this file's create route, tools/request-human-input.ts,
// workflows/executors/human-in-the-loop.ts) confirms they always conform to the
// shapes below, so we describe them precisely here and cast at the call sites
// (matching the existing `existing.questions as ApprovalQuestion[]` pattern in
// this file) rather than degrading the documented contract to `z.unknown()`.

const ApproversSchema = z.object({
  users: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  policy: z.union([z.literal("any"), z.literal("all"), z.object({ min: z.number().int().min(1) })]),
});
type ApproversShape = z.infer<typeof ApproversSchema>;

const NotificationChannelSchema = z.object({
  channel: z.enum(["slack", "email"]),
  target: z.string(),
  // Added post-creation by workflows/executors/human-in-the-loop.ts once the
  // notification message is sent (see `updateApprovalRequestNotifications`).
  messageTs: z.string().optional(),
});
type NotificationChannelShape = z.infer<typeof NotificationChannelSchema>;

const ApprovalRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  questions: z.array(QuestionSchema),
  workflowRunId: z.string().nullable(),
  workflowRunStepId: z.string().nullable(),
  sourceTaskId: z.string().nullable(),
  approvers: ApproversSchema,
  status: z.enum(["pending", "approved", "rejected", "timeout", "cancelled"]),
  responses: z.record(z.string(), z.unknown()).nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  timeoutSeconds: z.number().nullable(),
  expiresAt: z.string().nullable(),
  notificationChannels: z.array(NotificationChannelSchema).nullable(),
  createdBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Reshapes a DB `ApprovalRequest` row for `respond()` — identical values,
 * narrowed from the DB layer's `unknown` fields to the precise wire shape
 * (see comment above `ApproversSchema`). Not a behavior change: same object
 * contents, serialized the same way.
 */
function toApprovalRequestResponse(
  request: ApprovalRequest,
): z.infer<typeof ApprovalRequestSchema> {
  return {
    ...request,
    questions: request.questions as ApprovalQuestion[],
    approvers: request.approvers as ApproversShape,
    responses: request.responses as Record<string, unknown> | null,
    notificationChannels: request.notificationChannels as NotificationChannelShape[] | null,
  };
}

export async function getWorkflowApprovalUnavailableReason(
  request: ApprovalRequest,
): Promise<string | null> {
  if (!request.workflowRunId || !request.workflowRunStepId) return null;

  const run = await getWorkflowRun(request.workflowRunId);
  if (!run) return "The workflow run no longer exists";
  if (run.status !== "running" && run.status !== "waiting") {
    return `The workflow run is ${run.status} and this approval is no longer actionable`;
  }

  const step = await getWorkflowRunStep(request.workflowRunStepId);
  if (!step) return "The human-in-the-loop step no longer exists";
  if (step.runId !== run.id) {
    return "The human-in-the-loop step belongs to a different workflow run";
  }
  if (step.status !== "waiting") {
    return `The human-in-the-loop step is ${step.status} and this approval is no longer actionable`;
  }
  return null;
}

function hasRequiredResponse(question: ApprovalQuestion, response: unknown): boolean {
  switch (question.type) {
    case "approval":
      return (
        typeof response === "object" &&
        response !== null &&
        typeof (response as { approved?: unknown }).approved === "boolean"
      );
    case "text":
      return typeof response === "string" && response.trim().length > 0;
    case "single-select":
      return (
        typeof response === "string" &&
        response.length > 0 &&
        (!question.options || question.options.some((option) => option.value === response))
      );
    case "multi-select": {
      if (!Array.isArray(response)) return false;
      const minimum = Math.max(1, question.minSelections ?? 0);
      if (response.length < minimum) return false;
      if (question.maxSelections !== undefined && response.length > question.maxSelections) {
        return false;
      }
      return response.every(
        (value) =>
          typeof value === "string" &&
          (!question.options || question.options.some((option) => option.value === value)),
      );
    }
    case "boolean":
      return typeof response === "boolean";
  }
}

export function missingRequiredResponseIds(
  questions: ApprovalQuestion[],
  responses: Record<string, unknown>,
): string[] {
  return questions
    .filter(
      (question) => question.required && !hasRequiredResponse(question, responses[question.id]),
    )
    .map((question) => question.id);
}

const createRoute = route({
  method: "post",
  path: "/api/approval-requests",
  pattern: ["api", "approval-requests"],
  summary: "Create a new approval request",
  tags: ["ApprovalRequests"],
  body: z.object({
    title: z.string().min(1),
    questions: z.array(QuestionSchema).min(1),
    approvers: z.object({
      users: z.array(z.string()).optional(),
      roles: z.array(z.string()).optional(),
      policy: z.union([
        z.literal("any"),
        z.literal("all"),
        z.object({ min: z.number().int().min(1) }),
      ]),
    }),
    workflowRunId: z.string().uuid().optional(),
    workflowRunStepId: z.string().uuid().optional(),
    sourceTaskId: z.string().uuid().optional(),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Seconds until the request expires. After that the request becomes 'timeout' and you get a hitl-follow-up task. A request with no timeout is cancelled after APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS days (default 7).",
      ),
    notifications: z
      .array(
        z.object({
          channel: z.enum(["slack", "email"]),
          target: z.string(),
        }),
      )
      .optional(),
  }),
  responses: {
    201: {
      description: "Approval request created",
      schema: z.object({ approvalRequest: ApprovalRequestSchema }),
    },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
});

const getByIdRoute = route({
  method: "get",
  path: "/api/approval-requests/{id}",
  pattern: ["api", "approval-requests", null],
  summary: "Get approval request details",
  tags: ["ApprovalRequests"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: {
      description: "Approval request details",
      schema: z.object({ approvalRequest: ApprovalRequestSchema }),
    },
    404: { description: "Not found" },
  },
  auth: { apiKey: true },
});

const respondRoute = route({
  method: "post",
  path: "/api/approval-requests/{id}/respond",
  pattern: ["api", "approval-requests", null, "respond"],
  summary: "Submit a response to an approval request",
  tags: ["ApprovalRequests"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    responses: z.record(z.string(), z.unknown()),
    respondedBy: z.string().optional(),
  }),
  responses: {
    200: {
      description: "Response recorded",
      schema: z.object({ approvalRequest: ApprovalRequestSchema }),
    },
    400: { description: "Validation error" },
    404: { description: "Not found" },
    409: { description: "Already resolved" },
  },
  auth: { apiKey: true },
});

const cancelRoute = route({
  method: "post",
  path: "/api/approval-requests/{id}/cancel",
  pattern: ["api", "approval-requests", null, "cancel"],
  summary: "Cancel a pending approval request",
  tags: ["ApprovalRequests"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().max(500).optional() }),
  responses: {
    200: {
      description:
        "Request cancelled, or already cancelled. A request that gates a running or waiting workflow run cancels that run too.",
      schema: z.object({
        approvalRequest: ApprovalRequestSchema,
        alreadyCancelled: z.boolean(),
        runCancelled: z.boolean(),
      }),
    },
    403: { description: "Caller may not cancel this request" },
    404: { description: "Not found" },
    409: {
      description: "Already resolved with approved, rejected, or timeout, or its expiresAt passed",
    },
  },
  auth: { apiKey: true },
  rbac: { permission: "approval.cancel.any" },
});

const listRoute = route({
  method: "get",
  path: "/api/approval-requests",
  pattern: ["api", "approval-requests"],
  summary: "List approval requests with optional filters",
  tags: ["ApprovalRequests"],
  query: z.object({
    status: z.string().optional(),
    workflowRunId: z.string().optional(),
    limit: z.coerce.number().optional(),
  }),
  responses: {
    200: {
      description: "List of approval requests",
      schema: z.object({ approvalRequests: z.array(ApprovalRequestSchema) }),
    },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleApprovalRequests(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  // 4-segment: POST /api/approval-requests/{id}/respond
  if (respondRoute.match(req.method, pathSegments)) {
    const parsed = await respondRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const existing = await getApprovalRequestById(parsed.params.id);
    if (!existing) {
      jsonError(res, "Approval request not found", 404);
      return true;
    }

    if (existing.status !== "pending") {
      const reason = existing.resolutionReason ? `: ${existing.resolutionReason}` : "";
      jsonError(
        res,
        `Approval request already resolved with status: ${existing.status}${reason}`,
        409,
      );
      return true;
    }

    // A late answer never resolves the request: it becomes timeout at once.
    // A workflow run then routes on its timeout port on the next heartbeat
    // tick through getStuckApprovalRuns, so no approval.resolved is emitted.
    if (existing.expiresAt && new Date(existing.expiresAt) < new Date()) {
      // The status change and the follow-up task commit together.
      await getDbClient().transaction(async () => {
        const timedOut = await resolveApprovalRequest(existing.id, {
          status: "timeout",
          resolutionReason: `Timed out: the answer arrived after the deadline ${existing.expiresAt}`,
        });
        if (timedOut && !existing.workflowRunId) {
          await createApprovalFollowUpTask(timedOut, "hitl.timeout");
        }
      });
      jsonError(res, `Approval request expired at ${existing.expiresAt}`, 409);
      return true;
    }

    const unavailableReason = await getWorkflowApprovalUnavailableReason(existing);
    if (unavailableReason) {
      jsonError(res, unavailableReason, 409);
      return true;
    }

    const questions = existing.questions as ApprovalQuestion[];
    const missingRequired = missingRequiredResponseIds(questions, parsed.body.responses);
    if (missingRequired.length > 0) {
      jsonError(res, `Required responses missing or invalid: ${missingRequired.join(", ")}`, 400);
      return true;
    }

    // Determine status from responses: if any approval question has approved: false → rejected
    let status: "approved" | "rejected" = "approved";
    for (const q of questions) {
      if (q.type === "approval") {
        const answer = parsed.body.responses[q.id] as { approved?: boolean } | undefined;
        if (answer && answer.approved === false) {
          status = "rejected";
          break;
        }
      }
    }

    const updated = await resolveApprovalRequest(
      parsed.params.id,
      {
        status,
        responses: parsed.body.responses,
        resolvedBy: parsed.body.respondedBy,
      },
      { requireActionableWorkflow: true },
    );

    if (!updated) {
      const latest = await getApprovalRequestById(parsed.params.id);
      const unavailableAfterRace = latest
        ? await getWorkflowApprovalUnavailableReason(latest)
        : null;
      jsonError(
        res,
        unavailableAfterRace ??
          `Failed to resolve approval request (status: ${latest?.status ?? "unknown"})`,
        409,
      );
      return true;
    }

    // Emit event for workflow resume
    if (updated.workflowRunId && updated.workflowRunStepId) {
      workflowEventBus.emit("approval.resolved", {
        requestId: updated.id,
        status: updated.status,
        responses: updated.responses,
        workflowRunId: updated.workflowRunId,
        workflowRunStepId: updated.workflowRunStepId,
      });
    }

    // For standalone (non-workflow) requests, create a follow-up task
    // so the requesting agent is notified of the human's response
    await createApprovalFollowUpTask(updated, "hitl.follow_up");

    respondRoute.respond(res, 200, { approvalRequest: toApprovalRequestResponse(updated) });
    return true;
  }

  // 4-segment: POST /api/approval-requests/{id}/cancel
  if (cancelRoute.match(req.method, pathSegments)) {
    const parsed = await cancelRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { principal, resolvedBy } = await approvalCancelPrincipal(req);
    const result = await cancelApprovalRequest({
      id: parsed.params.id,
      reason: parsed.body.reason,
      principal,
      resolvedBy,
    });
    if (!result.ok) {
      jsonError(res, result.message, result.status);
      return true;
    }
    cancelRoute.respond(res, 200, {
      approvalRequest: toApprovalRequestResponse(result.request),
      alreadyCancelled: result.alreadyCancelled,
      runCancelled: result.runCancelled,
    });
    return true;
  }

  // 3-segment with param: GET /api/approval-requests/{id}
  if (getByIdRoute.match(req.method, pathSegments)) {
    const parsed = await getByIdRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const request = await getApprovalRequestById(parsed.params.id);
    if (!request) {
      jsonError(res, "Approval request not found", 404);
      return true;
    }

    getByIdRoute.respond(res, 200, { approvalRequest: toApprovalRequestResponse(request) });
    return true;
  }

  // 2-segment: POST /api/approval-requests (create)
  if (createRoute.match(req.method, pathSegments)) {
    const parsed = await createRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const id = crypto.randomUUID();
    // Prefer a trusted authenticated user (never client-controlled); else fall
    // back to the ownership-validated sourceTaskId the request body carries.
    const auth = getRequestAuth(req);
    const rawCallerAgentId = req.headers["x-agent-id"];
    const callerAgentId = Array.isArray(rawCallerAgentId) ? rawCallerAgentId[0] : rawCallerAgentId;
    const createdBy =
      auth?.kind === "user"
        ? auth.userId
        : ((await resolveTaskAuditUserId(parsed.body.sourceTaskId, callerAgentId)) ?? undefined);
    const request = await createApprovalRequest({
      id,
      title: parsed.body.title,
      questions: parsed.body.questions,
      approvers: parsed.body.approvers,
      workflowRunId: parsed.body.workflowRunId,
      workflowRunStepId: parsed.body.workflowRunStepId,
      sourceTaskId: parsed.body.sourceTaskId,
      timeoutSeconds: parsed.body.timeoutSeconds,
      notificationChannels: parsed.body.notifications,
      createdBy,
    });

    createRoute.respond(res, 201, { approvalRequest: toApprovalRequestResponse(request) });
    return true;
  }

  // 2-segment: GET /api/approval-requests (list)
  if (listRoute.match(req.method, pathSegments)) {
    const parsed = await listRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const requests = await listApprovalRequests({
      status: parsed.query.status || undefined,
      workflowRunId: parsed.query.workflowRunId || undefined,
      limit: parsed.query.limit || undefined,
    });

    listRoute.respond(res, 200, {
      approvalRequests: requests.map(toApprovalRequestResponse),
    });
    return true;
  }

  return false;
}

/**
 * The caller of the cancel route. The shared API key with an `X-Agent-ID`
 * header identifies that agent, as on the create route.
 */
async function approvalCancelPrincipal(
  req: IncomingMessage,
): Promise<{ principal: RbacPrincipal; resolvedBy: string | null }> {
  const auth = getRequestAuth(req);
  if (auth?.kind === "user") {
    return { principal: { kind: "user", userId: auth.userId }, resolvedBy: auth.userId };
  }
  const rawAgentId = req.headers["x-agent-id"];
  const agentId =
    auth?.kind === "agent" ? auth.agentId : Array.isArray(rawAgentId) ? rawAgentId[0] : rawAgentId;
  if (agentId) {
    const agent = await getAgentById(agentId);
    return {
      principal: { kind: "agent", agentId, isLead: agent?.isLead ?? false },
      resolvedBy: agentId,
    };
  }
  return { principal: { kind: "operator" }, resolvedBy: "operator" };
}
