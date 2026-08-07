import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveTaskAuditUserId } from "../be/audit-user";
import {
  type ApprovalRequest,
  createApprovalRequest,
  createTaskExtended,
  getApprovalRequestById,
  getTaskById,
  listApprovalRequests,
  resolveApprovalRequest,
} from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import { getRequestAuth } from "../utils/request-auth-context";
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
  status: z.enum(["pending", "approved", "rejected", "timeout"]),
  responses: z.record(z.string(), z.unknown()).nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
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
    timeoutSeconds: z.number().int().min(1).optional(),
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

    const existing = getApprovalRequestById(parsed.params.id);
    if (!existing) {
      jsonError(res, "Approval request not found", 404);
      return true;
    }

    if (existing.status !== "pending") {
      jsonError(res, `Approval request already resolved with status: ${existing.status}`, 409);
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

    const updated = resolveApprovalRequest(parsed.params.id, {
      status,
      responses: parsed.body.responses,
      resolvedBy: parsed.body.respondedBy,
    });

    if (!updated) {
      jsonError(
        res,
        "Failed to resolve approval request (may have been resolved concurrently)",
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
    if (!updated.workflowRunId && updated.sourceTaskId) {
      const sourceTask = getTaskById(updated.sourceTaskId);
      if (sourceTask) {
        // Format responses for the template
        const formattedResponses = formatResponses(
          updated.questions as Array<{ id: string; type: string; label: string }>,
          updated.responses as Record<string, unknown>,
        );

        const { text: taskText } = resolveTemplate("hitl.follow_up", {
          request_id: updated.id,
          title: updated.title,
          status: updated.status,
          responses: formattedResponses,
        });

        createTaskExtended(taskText, {
          agentId: sourceTask.agentId,
          parentTaskId: updated.sourceTaskId,
          source: "system",
          taskType: "hitl-follow-up",
          tags: ["hitl", "follow-up"],
          // Explicit Slack metadata — parentTaskId auto-inherits too,
          // but being explicit ensures the follow-up task always gets
          // the right thread context even if inheritance logic changes.
          slackChannelId: sourceTask.slackChannelId ?? undefined,
          slackThreadTs: sourceTask.slackThreadTs ?? undefined,
          slackUserId: sourceTask.slackUserId ?? undefined,
        });
      }
    }

    respondRoute.respond(res, 200, { approvalRequest: toApprovalRequestResponse(updated) });
    return true;
  }

  // 3-segment with param: GET /api/approval-requests/{id}
  if (getByIdRoute.match(req.method, pathSegments)) {
    const parsed = await getByIdRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const request = getApprovalRequestById(parsed.params.id);
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
        : (resolveTaskAuditUserId(parsed.body.sourceTaskId, callerAgentId) ?? undefined);
    const request = createApprovalRequest({
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

    const requests = listApprovalRequests({
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatResponses(
  questions: Array<{ id: string; type: string; label: string }>,
  responses: Record<string, unknown>,
): string {
  return questions
    .map((q) => {
      const answer = responses[q.id];
      let answerText: string;
      if (answer == null) {
        answerText = "(no answer)";
      } else if (q.type === "approval") {
        const a = answer as { approved?: boolean; comment?: string };
        answerText = a.approved ? "Approved" : "Rejected";
        if (a.comment) answerText += ` — ${a.comment}`;
      } else if (typeof answer === "object") {
        answerText = JSON.stringify(answer);
      } else {
        answerText = String(answer);
      }
      return `- ${q.label}: ${answerText}`;
    })
    .join("\n");
}
