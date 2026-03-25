import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createApprovalRequest,
  createTaskExtended,
  getApprovalRequestById,
  getTaskById,
  listApprovalRequests,
  resolveApprovalRequest,
} from "../be/db";
import { resolveTemplate } from "../prompts/resolver";
import { workflowEventBus } from "../workflows/event-bus";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

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
    201: { description: "Approval request created" },
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
    200: { description: "Approval request details" },
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
    200: { description: "Response recorded" },
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
    200: { description: "List of approval requests" },
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

    // Determine status from responses: if any approval question has approved: false → rejected
    const questions = existing.questions as Array<{ id: string; type: string }>;
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

    json(res, { approvalRequest: updated });
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

    json(res, { approvalRequest: request });
    return true;
  }

  // 2-segment: POST /api/approval-requests (create)
  if (createRoute.match(req.method, pathSegments)) {
    const parsed = await createRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const id = crypto.randomUUID();
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
    });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ approvalRequest: request }));
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

    json(res, { approvalRequests: requests });
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
