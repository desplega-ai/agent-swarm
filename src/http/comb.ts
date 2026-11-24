import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpRequesterUserId } from "../be/audit-user";
import { getTaskById } from "../be/db";
import { getCombConfig } from "../comb/config";
import {
  REVIEW_BATCH_MAX,
  REVIEW_NOTE_MAX,
  ReviewBatchError,
  sendReviewBatch,
} from "../comb/review-batch";
import { can } from "../rbac";
import { TaskCreationBlockedError } from "../tasks/errors";
import { scrubSecrets } from "../utils/secret-scrubber";
import { agentFirstPrincipal, requestPrincipal } from "./request-principal";
import { bodyTask, route } from "./route-def";
import { denyParentAttach } from "./session-access";
import { jsonError } from "./utils";

const skippedSchema = z.object({
  id: z.string(),
  reason: z.enum(["not-found", "reply", "resolved", "already-sent"]),
  /** The task an "already-sent" comment went to, when known. */
  taskId: z.string().optional(),
});

const resultSchema = z.object({
  /** The new task. Null on a 200: the batch only posted missing "sent" replies again. */
  taskId: z.string().nullable(),
  sent: z.array(z.string()),
  skipped: z.array(skippedSchema),
  /** Comments of an earlier send whose missing "sent" reply this batch posted again. */
  repaired: z.array(z.object({ id: z.string(), taskId: z.string() })),
  /**
   * With a new task only. `online`: a lead got it. `offline`: every lead is offline,
   * so the task waits for one. `none`: no lead, so the task waits
   * unassigned in the pool.
   */
  lead: z.enum(["online", "offline", "none"]).optional(),
});

const batchErrorSchema = z.object({ error: z.string(), skipped: z.array(skippedSchema) });

/** A drive path: starts with "/", no "." or ".." segment. */
function isDrivePath(path: string): boolean {
  return (
    path.startsWith("/") && !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

const reviewBatchRoute = route({
  method: "post",
  path: "/api/comb/review-batches",
  pattern: ["api", "comb", "review-batches"],
  summary: "Send agent-fs comments to the swarm as one task",
  description:
    "Comb's 'Send to swarm'. The server reads each comment again from agent-fs with its bootstrap key, skips replies, resolved comments, and comments already sent, and creates one task. An optional parentTaskId attaches it as a follow-up for the parent’s agent. Without a parent assignee it routes to the lead. Each sent comment gets a `[comb:sent task=<id>]` reply from the swarm service account. A comment is sent at most once. An optional `note` from the sender goes into the task text. When an earlier send lost its reply, the batch posts that reply again (`repaired`). Answers 404 while COMB_ENABLED is off.",
  tags: ["Comb"],
  body: z.object({
    parentTaskId: z.uuid().optional(),
    orgId: z.string().min(1),
    driveId: z.string().min(1),
    // agent-fs comment ids are UUIDs, so a malformed id never costs an agent-fs read.
    commentIds: z.array(z.uuid()).min(1).max(REVIEW_BATCH_MAX),
    /** The file or folder the batch was sent from (a Comb path such as "/docs/"). */
    scopePath: z
      .string()
      .min(1)
      .max(1024)
      .refine(isDrivePath, "scopePath must start with '/' and have no '.' or '..' segment"),
    /** The sender's note for the lead about the whole batch. */
    note: z.string().max(REVIEW_NOTE_MAX).optional(),
  }),
  responses: {
    200: {
      description: "No new task: the batch only posted missing 'sent' replies again",
      schema: resultSchema,
    },
    201: { description: "Task created", schema: resultSchema },
    400: { description: "Invalid body, or not the swarm drive" },
    403: { description: "Caller cannot create tasks" },
    404: { description: "Comb is not enabled" },
    409: {
      description: "Nothing to send (every comment was skipped)",
      schema: batchErrorSchema,
    },
    422: { description: "Task creation blocked by an extension" },
    502: { description: "agent-fs could not read a comment" },
    503: {
      description:
        "agent-fs or the swarm drive is not set up, or an operator disabled a Comb review template",
      schema: batchErrorSchema,
    },
  },
  session: bodyTask("parentTaskId"),
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
  // Comb off: the route does not exist. No body parsing, no RBAC answer.
  if (!getCombConfig().enabled) {
    jsonError(res, "Comb is not enabled", 404);
    return true;
  }

  const parsed = await reviewBatchRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const principal = await requestPrincipal(req, myAgentId);
  if (
    !principal ||
    !can({ principal, verb: "task.create.own", resource: { kind: "none" }, source: "http" }).allow
  ) {
    jsonError(res, "Not authorized to create tasks", 403);
    return true;
  }

  try {
    const { parentTaskId, ...batch } = parsed.body;
    const parent = parentTaskId ? await getTaskById(parentTaskId) : null;
    if (parentTaskId && !parent) {
      jsonError(res, "Parent task not found", 404);
      return true;
    }
    const sender = parent ? await agentFirstPrincipal(req, myAgentId) : null;
    if (parent && sender && (await denyParentAttach(req, res, myAgentId, parent, sender)))
      return true;
    const result = await sendReviewBatch({
      ...batch,
      parent: parent
        ? { id: parent.id, agentId: parent.agentId, agentCaller: sender?.kind === "agent" }
        : undefined,
      requestedByUserId: await resolveHttpRequesterUserId(req, myAgentId),
    });
    reviewBatchRoute.respond(res, result.taskId === null ? 200 : 201, result);
  } catch (error) {
    if (error instanceof ReviewBatchError) {
      if (error.status === 409 || error.status === 503) {
        reviewBatchRoute.respond(res, error.status, {
          error: error.message,
          skipped: error.skipped,
        });
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
