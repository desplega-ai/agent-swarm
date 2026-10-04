import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveTaskAuditUserId } from "../be/audit-user";
import {
  type ApprovalRequest,
  type ApprovalVote,
  createApprovalRequest,
  getAgentById,
  getApprovalRequestById,
  getDbClient,
  getPendingApprovalVoteState,
  getWorkflowRun,
  getWorkflowRunStep,
  listApprovalRequestSummaries,
  listApprovalRequests,
  recordApprovalVotes,
  resolveApprovalRequest,
} from "../be/db";
import { findUserById } from "../be/users";
import { can, type RbacPrincipal } from "../rbac";
import type { User } from "../types";
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

const ApprovalVoteSchema = z.object({
  responder: z
    .string()
    .describe("Who answered, from the credential: a user id, or `operator` for the shared key."),
  approved: z.boolean(),
  responses: z.record(z.string(), z.unknown()),
  claimedRespondedBy: z
    .string()
    .optional()
    .describe("The `respondedBy` the client sent. Unverified; display only."),
  respondedAt: z.string(),
});

const ApprovalProgressSchema = z
  .object({
    approved: z.number().int().describe("Approvals that count toward the policy so far."),
    required: z.number().int().describe("Approvals the policy needs before the request resolves."),
  })
  .nullable()
  .describe("Quorum progress while the request is pending; null once it is resolved.");

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
  approvals: z
    .array(ApprovalVoteSchema)
    .nullable()
    .describe(
      "Every accepted answer, in order. A request with an `all` or `{ min: N }` policy stays pending until enough approve.",
    ),
  approvalProgress: ApprovalProgressSchema,
  resolvedBy: z
    .string()
    .nullable()
    .describe(
      "Who resolved the request, from the credential: a user id, `operator` for the shared key, or an agent id for a cancellation.",
    ),
  resolvedAt: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  timeoutSeconds: z.number().nullable(),
  expiresAt: z.string().nullable(),
  notificationChannels: z.array(NotificationChannelSchema).nullable(),
  createdBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Slim list row (`?fields=slim`) — see `ApprovalRequestSummary`. */
const ApprovalRequestSummarySchema = ApprovalRequestSchema.omit({
  questions: true,
  approvers: true,
  responses: true,
  approvals: true,
  resolutionReason: true,
  notificationChannels: true,
}).extend({ questionCount: z.number().int() });

/**
 * Reshapes a DB `ApprovalRequest` row for `respond()` — identical values,
 * narrowed from the DB layer's `unknown` fields to the precise wire shape
 * (see comment above `ApproversSchema`), plus the derived `approvalProgress`.
 */
async function toApprovalRequestResponse(
  request: ApprovalRequest,
): Promise<z.infer<typeof ApprovalRequestSchema>> {
  const approvers = request.approvers as ApproversShape;
  const approvals = request.approvals ?? null;
  return {
    ...request,
    questions: request.questions as ApprovalQuestion[],
    approvers,
    responses: request.responses as Record<string, unknown> | null,
    approvals,
    approvalProgress:
      request.status === "pending" ? await approvalProgress(approvers, approvals ?? []) : null,
    notificationChannels: request.notificationChannels as NotificationChannelShape[] | null,
  };
}

/** Slim rows plus `approvalProgress` for the pending ones (one extra read). */
async function withApprovalProgress(
  rows: Awaited<ReturnType<typeof listApprovalRequestSummaries>>,
): Promise<z.infer<typeof ApprovalRequestSummarySchema>[]> {
  const pendingIds = rows.filter((row) => row.status === "pending").map((row) => row.id);
  const state = new Map(
    (await getPendingApprovalVoteState(pendingIds)).map((entry) => [entry.id, entry]),
  );
  return Promise.all(
    rows.map(async (row) => {
      const entry = state.get(row.id);
      return {
        ...row,
        approvalProgress: entry
          ? await approvalProgress(entry.approvers as ApproversShape, entry.approvals ?? [])
          : null,
      };
    }),
  );
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
  description:
    "Only a person may answer: a user token, a page session signed for a user, or the shared key with no agent identity (recorded as `operator`). The responder is taken from the credential. When the request lists `approvers.users` or `approvers.roles`, a user must match one of them. A rejection resolves the request at once; approvals resolve it when the `any`, `all` or `{ min: N }` policy is met, and until then it stays pending with the answer recorded in `approvals`.",
  tags: ["ApprovalRequests"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    responses: z.record(z.string(), z.unknown()),
    respondedBy: z
      .string()
      .optional()
      .describe(
        "Unverified display name. Stored as `claimedRespondedBy` on the answer; never used as the responder.",
      ),
  }),
  responses: {
    200: {
      description:
        "Response recorded. `status` stays `pending` while the policy needs more approvals.",
      schema: z.object({ approvalRequest: ApprovalRequestSchema }),
    },
    400: { description: "Validation error" },
    403: { description: "Caller is an agent, or is not one of the request's approvers" },
    404: { description: "Not found" },
    409: { description: "Already resolved, or this responder already answered" },
  },
  auth: { apiKey: true },
  rbac: { permission: "approval.respond" },
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
  description:
    "Returns full approval requests by default. Pass `fields=slim` for the list-view shape: `questions`, `approvers`, `responses`, `resolutionReason` and `notificationChannels` are dropped and `questionCount` is added. Fetch one request in full via `GET /api/approval-requests/{id}`.",
  tags: ["ApprovalRequests"],
  query: z.object({
    status: z.string().optional(),
    workflowRunId: z.string().optional(),
    limit: z.coerce.number().optional(),
    /** `slim` is the list-view shape; default is full. */
    fields: z.enum(["full", "slim"]).optional(),
  }),
  responses: {
    200: {
      description: "List of approval requests",
      schema: z.object({
        approvalRequests: z.union([
          z.array(ApprovalRequestSchema),
          z.array(ApprovalRequestSummarySchema),
        ]),
      }),
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

    const responder = await approvalResponder(req);
    if (!responder.ok) {
      jsonError(res, responder.message, 403);
      return true;
    }

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

    const approvers = existing.approvers as ApproversShape;
    if (!isListedApprover(approvers, responder.responder)) {
      jsonError(res, "You are not one of this request's approvers", 403);
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

    const responderId = responderKey(responder.responder);
    const vote: ApprovalVote = {
      responder: responderId,
      approved: status === "approved",
      responses: parsed.body.responses,
      ...(parsed.body.respondedBy ? { claimedRespondedBy: parsed.body.respondedBy } : {}),
      respondedAt: new Date().toISOString(),
    };
    // One write transaction (BEGIN IMMEDIATE) so concurrent answers to an
    // `all` / `{ min: N }` request append in turn and never drop each other.
    const outcome = await getDbClient().transaction(async () => {
      const current = await getApprovalRequestById(parsed.params.id);
      if (!current || current.status !== "pending") return { kind: "unavailable" as const };
      const prior = current.approvals ?? [];
      if (prior.some((v) => v.responder === responderId)) return { kind: "duplicate" as const };
      const votes = [...prior, vote];
      if (status === "rejected" || (await approvalQuorumMet(approvers, votes))) {
        const resolved = await resolveApprovalRequest(
          parsed.params.id,
          { status, responses: parsed.body.responses, approvals: votes, resolvedBy: responderId },
          { requireActionableWorkflow: true },
        );
        return resolved
          ? { kind: "resolved" as const, request: resolved }
          : { kind: "unavailable" as const };
      }
      const recorded = (await recordApprovalVotes(parsed.params.id, votes))
        ? await getApprovalRequestById(parsed.params.id)
        : null;
      return recorded
        ? { kind: "recorded" as const, request: recorded }
        : { kind: "unavailable" as const };
    });

    if (outcome.kind === "duplicate") {
      jsonError(res, "You already answered this approval request", 409);
      return true;
    }
    if (outcome.kind === "recorded") {
      respondRoute.respond(res, 200, {
        approvalRequest: await toApprovalRequestResponse(outcome.request),
      });
      return true;
    }
    const updated = outcome.kind === "resolved" ? outcome.request : null;

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

    respondRoute.respond(res, 200, {
      approvalRequest: await toApprovalRequestResponse(updated),
    });
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
      approvalRequest: await toApprovalRequestResponse(result.request),
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

    getByIdRoute.respond(res, 200, {
      approvalRequest: await toApprovalRequestResponse(request),
    });
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

    createRoute.respond(res, 201, {
      approvalRequest: await toApprovalRequestResponse(request),
    });
    return true;
  }

  // 2-segment: GET /api/approval-requests (list)
  if (listRoute.match(req.method, pathSegments)) {
    const parsed = await listRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const filters = {
      status: parsed.query.status || undefined,
      workflowRunId: parsed.query.workflowRunId || undefined,
      limit: parsed.query.limit || undefined,
    };
    // Opt-in: API, MCP and script callers that don't ask keep the full rows.
    if (parsed.query.fields === "slim") {
      listRoute.respond(res, 200, {
        approvalRequests: await withApprovalProgress(await listApprovalRequestSummaries(filters)),
      });
      return true;
    }

    const requests = await listApprovalRequests(filters);
    listRoute.respond(res, 200, {
      approvalRequests: await Promise.all(requests.map(toApprovalRequestResponse)),
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

type ApprovalResponder = { kind: "user"; user: User } | { kind: "operator" };

const AGENT_RESPONSE_REFUSED =
  "Agents cannot answer approval requests. A person must respond with a user token or the dashboard.";

/**
 * The person answering an approval request, taken from the credential and
 * never from the request body. Every agent identity is refused: an `aseph_`
 * session token, the shared key with an `X-Agent-ID`, and a page session with
 * no signed-in user (page code is agent-authored, so it cannot vouch for a
 * person). The shared key alone is the operator.
 */
async function approvalResponder(
  req: IncomingMessage,
): Promise<{ ok: true; responder: ApprovalResponder } | { ok: false; message: string }> {
  const auth = getRequestAuth(req);
  const rawAgentId = req.headers["x-agent-id"];
  const headerAgentId = Array.isArray(rawAgentId) ? rawAgentId[0] : rawAgentId;

  let principal: RbacPrincipal;
  let responder: ApprovalResponder | null = null;
  if (auth?.kind === "user") {
    principal = { kind: "user", userId: auth.userId };
    responder = { kind: "user", user: auth.user };
  } else if (auth?.kind === "agent" || headerAgentId) {
    const agentId = auth?.kind === "agent" ? auth.agentId : (headerAgentId ?? "");
    const agent = agentId ? await getAgentById(agentId) : null;
    principal = { kind: "agent", agentId, isLead: agent?.isLead ?? false };
  } else if (auth?.page) {
    return {
      ok: false,
      message: "A page session without a signed-in user cannot answer approval requests.",
    };
  } else {
    principal = { kind: "operator" };
    responder = { kind: "operator" };
  }

  const decision = can({ principal, verb: "approval.respond", source: "http" });
  if (!decision.allow || !responder) return { ok: false, message: AGENT_RESPONSE_REFUSED };
  return { ok: true, responder };
}

function responderKey(responder: ApprovalResponder): string {
  return responder.kind === "user" ? responder.user.id : "operator";
}

function userMatchesListed(user: Pick<User, "id" | "email">, listed: string): boolean {
  if (listed === user.id) return true;
  return !!user.email && listed.toLowerCase() === user.email.toLowerCase();
}

/**
 * Whether the responder may answer this request. With no `users` or `roles`
 * listed, any person may. The operator key is the deployment's admin
 * credential and may answer any request, counting as the single responder
 * `operator`.
 */
export function isListedApprover(approvers: ApproversShape, responder: ApprovalResponder): boolean {
  const users = approvers.users ?? [];
  const roles = approvers.roles ?? [];
  if (users.length === 0 && roles.length === 0) return true;
  if (responder.kind === "operator") return true;
  const { user } = responder;
  if (users.some((listed) => userMatchesListed(user, listed))) return true;
  return !!user.role && roles.includes(user.role);
}

/**
 * How far the approving answers are toward the policy. `any`: one approval.
 * `{ min: N }`: N distinct responders. `all`: every user in `approvers.users`
 * (one approval when no users are listed, since roles cannot be enumerated).
 */
export async function approvalProgress(
  approvers: ApproversShape,
  votes: ApprovalVote[],
): Promise<{ approved: number; required: number }> {
  const approving = votes.filter((v) => v.approved);
  const distinct = new Set(approving.map((v) => v.responder)).size;
  const policy = approvers.policy;
  if (policy === "any") return { approved: Math.min(distinct, 1), required: 1 };
  if (policy === "all") {
    const listed = approvers.users ?? [];
    if (listed.length === 0) return { approved: Math.min(distinct, 1), required: 1 };
    const approvingUsers: Pick<User, "id" | "email">[] = [];
    for (const vote of approving) {
      if (vote.responder === "operator") continue;
      const user = await findUserById(vote.responder);
      approvingUsers.push(user ?? { id: vote.responder });
    }
    const approved = listed.filter((entry) =>
      approvingUsers.some((u) => userMatchesListed(u, entry)),
    ).length;
    return { approved, required: listed.length };
  }
  return { approved: Math.min(distinct, policy.min), required: policy.min };
}

/** Whether the approving answers satisfy the policy (see `approvalProgress`). */
export async function approvalQuorumMet(
  approvers: ApproversShape,
  votes: ApprovalVote[],
): Promise<boolean> {
  const { approved, required } = await approvalProgress(approvers, votes);
  return approved >= required;
}
