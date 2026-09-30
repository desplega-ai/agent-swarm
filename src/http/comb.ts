import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import { getAgentById } from "../be/db";
import { REVIEW_BATCH_MAX, ReviewBatchError, sendReviewBatch } from "../comb/review-batch";
import { can, type RbacPrincipal } from "../rbac";
import { TaskCreationBlockedError } from "../tasks/errors";
import { getRequestAuth } from "../utils/request-auth-context";
import { scrubSecrets } from "../utils/secret-scrubber";
import { route } from "./route-def";
import { jsonError } from "./utils";

const skippedSchema = z.object({
  id: z.string(),
  reason: z.enum(["not-found", "reply", "resolved", "already-sent"]),
});

const reviewBatchRoute = route({
  method: "post",
  path: "/api/comb/review-batches",
  pattern: ["api", "comb", "review-batches"],
  summary: "Send agent-fs comments to the swarm as one lead task",
  description:
    "Comb's 'Send to swarm'. The server reads each comment again from agent-fs with its bootstrap key, skips replies, resolved comments, and comments already sent, and creates ONE task for the lead. Each sent comment gets a `[comb:sent task=<id>]` reply from the swarm service account. A comment is sent at most once. Answers 404 while COMB_ENABLED is off.",
  tags: ["Comb"],
  body: z.object({
    orgId: z.string().min(1),
    driveId: z.string().min(1),
    commentIds: z.array(z.string().min(1)).min(1).max(REVIEW_BATCH_MAX),
    /** The file or folder the batch was sent from (a Comb path such as "/docs/"). */
    scopePath: z.string().min(1),
  }),
  responses: {
    201: {
      description: "Task created",
      schema: z.object({
        taskId: z.string(),
        sent: z.array(z.string()),
        skipped: z.array(skippedSchema),
      }),
    },
    400: { description: "Invalid body, or not the swarm drive" },
    403: { description: "Caller cannot create tasks" },
    404: { description: "Comb is not enabled" },
    409: {
      description: "Nothing to send (every comment was skipped), or the template is disabled",
      schema: z.object({ error: z.string(), skipped: z.array(skippedSchema) }),
    },
    422: { description: "Task creation blocked by an extension" },
    502: { description: "agent-fs could not read a comment" },
    503: { description: "agent-fs is not set up for this swarm" },
  },
  rbac: { permission: "task.create.own" },
});

export async function handleComb(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId?: string,
): Promise<boolean> {
  if (!reviewBatchRoute.match(req.method, pathSegments)) return false;

  const parsed = await reviewBatchRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  if (!(await canCreateTask(req, myAgentId))) {
    jsonError(res, "Not authorized to create tasks", 403);
    return true;
  }

  try {
    const result = await sendReviewBatch({
      ...parsed.body,
      requestedByUserId: await resolveHttpAuditUserId(req, myAgentId),
    });
    reviewBatchRoute.respond(res, 201, result);
  } catch (error) {
    if (error instanceof ReviewBatchError) {
      if (error.status === 409) {
        reviewBatchRoute.respond(res, 409, { error: error.message, skipped: error.skipped });
      } else {
        jsonError(res, error.message, error.status);
      }
    } else if (error instanceof TaskCreationBlockedError) {
      jsonError(res, error.reason, 422);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      jsonError(res, scrubSecrets(`Failed to send comments to the swarm: ${message}`), 500);
    }
  }
  return true;
}

async function canCreateTask(req: IncomingMessage, myAgentId: string | undefined) {
  const auth = getRequestAuth(req);
  let principal: RbacPrincipal;
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
  return can({ principal, verb: "task.create.own", resource: { kind: "none" }, source: "http" })
    .allow;
}
