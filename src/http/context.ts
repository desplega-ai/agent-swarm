import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createContextSnapshot,
  getContextSnapshotsByTaskId,
  getContextSummaryByTaskId,
  getTaskById,
} from "../be/db";
import {
  ContextFormulaSchema,
  ContextSnapshotEventTypeSchema,
  ContextSnapshotSchema,
} from "../types";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Response Schemas ───────────────────────────────────────────────────────

const PostContextResponseSchema = z.object({
  ok: z.literal(true),
  snapshotId: z.uuid(),
});

// Mirrors the `ContextSummary` interface returned by
// `getContextSummaryByTaskId` in src/be/db.ts — not a named entity schema in
// types.ts, so defined locally.
const ContextSummarySchema = z.object({
  compactionCount: z.number().int().min(0),
  peakContextPercent: z.number().min(0).max(100).nullable(),
  peakContextTokens: z.number().int().min(0).nullable(),
  contextWindowSize: z.number().int().min(0).nullable(),
  snapshotCount: z.number().int().min(0),
});

const GetContextResponseSchema = z.object({
  snapshots: z.array(ContextSnapshotSchema),
  summary: ContextSummarySchema,
});

// ─── Route Definitions ───────────────────────────────────────────────────────

const postContext = route({
  method: "post",
  path: "/api/tasks/{id}/context",
  pattern: ["api", "tasks", null, "context"],
  summary: "Record a context usage snapshot for a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({
    eventType: ContextSnapshotEventTypeSchema,
    sessionId: z.string(),
    contextUsedTokens: z.number().int().min(0).optional(),
    contextTotalTokens: z.number().int().min(0).optional(),
    contextPercent: z.number().min(0).max(100).optional(),
    compactTrigger: z.enum(["auto", "manual", "auto-inferred"]).optional(),
    preCompactTokens: z.number().int().min(0).optional(),
    cumulativeInputTokens: z.number().int().min(0).optional(),
    cumulativeOutputTokens: z.number().int().min(0).optional(),
    // Migration 063: adapters tag the formula they used so cross-provider
    // comparisons can tell apples from oranges.
    contextFormula: ContextFormulaSchema.optional(),
  }),
  responses: {
    200: { description: "Snapshot recorded", schema: PostContextResponseSchema },
    400: { description: "Validation error" },
    404: { description: "Task not found" },
  },
  auth: { apiKey: true, agentId: true },
});

const getContext = route({
  method: "get",
  path: "/api/tasks/{id}/context",
  pattern: ["api", "tasks", null, "context"],
  summary: "Get context usage history for a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  responses: {
    200: { description: "Context snapshot history", schema: GetContextResponseSchema },
    404: { description: "Task not found" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleContext(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (postContext.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }

    const parsed = await postContext.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const task = await getTaskById(parsed.params.id);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    const snapshot = await createContextSnapshot({
      taskId: parsed.params.id,
      agentId: myAgentId,
      sessionId: parsed.body.sessionId,
      eventType: parsed.body.eventType,
      contextUsedTokens: parsed.body.contextUsedTokens,
      contextTotalTokens: parsed.body.contextTotalTokens,
      contextPercent: parsed.body.contextPercent,
      compactTrigger: parsed.body.compactTrigger,
      preCompactTokens: parsed.body.preCompactTokens,
      cumulativeInputTokens: parsed.body.cumulativeInputTokens,
      cumulativeOutputTokens: parsed.body.cumulativeOutputTokens,
      contextFormula: parsed.body.contextFormula,
    });

    postContext.respond(res, 200, { ok: true, snapshotId: snapshot.id });
    return true;
  }

  if (getContext.match(req.method, pathSegments)) {
    const parsed = await getContext.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const task = await getTaskById(parsed.params.id);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    const snapshots = await getContextSnapshotsByTaskId(parsed.params.id, parsed.query.limit);
    const summary = await getContextSummaryByTaskId(parsed.params.id);

    getContext.respond(res, 200, { snapshots, summary });
    return true;
  }

  return false;
}
