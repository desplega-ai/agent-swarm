import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createSessionCost,
  createSessionLogs,
  getActivePricingRow,
  getAllSessionCosts,
  getDashboardCostSummary,
  getSessionCostSummary,
  getSessionCostsByAgentId,
  getSessionCostsByTaskId,
  getSessionCostsFiltered,
  getSessionLogsByTaskId,
  getTaskById,
} from "../be/db";
import { normalizeModelKey } from "../be/pricing-normalize";
import { incrementServerSessionsProcessed } from "../server-runtime-counters";
import type { SessionCost, SessionCostSource } from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const createSessionLogsRoute = route({
  method: "post",
  path: "/api/session-logs",
  pattern: ["api", "session-logs"],
  summary: "Store session logs",
  tags: ["Session Data"],
  body: z.object({
    sessionId: z.string().min(1),
    iteration: z.number().int().min(1),
    lines: z.array(z.string()).min(1),
    taskId: z.string().optional(),
    cli: z.string().optional(),
  }),
  responses: {
    201: { description: "Logs stored" },
    400: { description: "Validation error" },
  },
});

const getSessionLogsByTask = route({
  method: "get",
  path: "/api/tasks/{taskId}/session-logs",
  pattern: ["api", "tasks", null, "session-logs"],
  summary: "Get session logs for a task",
  tags: ["Session Data"],
  params: z.object({ taskId: z.string() }),
  query: z.object({
    // When set, returns the last N log rows ordered ASC. Used by the
    // resume context preamble to avoid pulling the full log set over HTTP
    // just to slice the tail. Server-side limit prevents OOM / slow
    // dispatch for tasks with very long run history (PR #594 review).
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }),
  responses: {
    200: { description: "Session logs" },
    404: { description: "Task not found" },
  },
});

const createSessionCostRoute = route({
  method: "post",
  path: "/api/session-costs",
  pattern: ["api", "session-costs"],
  summary: "Store session cost record",
  tags: ["Session Data"],
  body: z.object({
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    totalCostUsd: z.number(),
    taskId: z.string().optional(),
    inputTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    cacheReadTokens: z.number().int().optional(),
    // Migration 063: nullable — adapters that can't honestly report cache writes
    // (e.g. Codex SDK) prefer null over a faked 0.
    cacheWriteTokens: z.number().int().nullable().optional(),
    // Migration 063: new token classes previously dropped on the floor.
    reasoningOutputTokens: z.number().int().nonnegative().optional(),
    thinkingTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().optional(),
    // Migration 063: nullable for adapters that can't honestly report numTurns.
    numTurns: z.number().int().nullable().optional(),
    model: z.string().optional(),
    isError: z.boolean().optional(),
    /**
     * Phase 6 (extended migration 063): drives the API recompute path. After
     * Phase 2 every provider with seeded pricing rows participates.
     */
    provider: z
      .enum(["claude", "claude-managed", "codex", "pi", "opencode", "devin", "gemini"])
      .optional(),
    /**
     * Phase 6: epoch-ms timestamp used as the "active price at time T" lookup
     * basis. Defaults to `Date.now()` when omitted. Including it lets
     * historical recomputes pick the correct `effective_from` row.
     */
    createdAt: z.number().int().nonnegative().optional(),
  }),
  responses: {
    201: { description: "Cost record stored" },
    400: { description: "Validation error" },
  },
});

const getSessionCostSummaryRoute = route({
  method: "get",
  path: "/api/session-costs/summary",
  pattern: ["api", "session-costs", "summary"],
  summary: "Aggregated session cost summary",
  tags: ["Session Data"],
  query: z.object({
    groupBy: z.enum(["day", "agent", "both"]).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    agentId: z.string().optional(),
  }),
  responses: {
    200: { description: "Cost summary" },
    400: { description: "Invalid groupBy" },
  },
});

const getDashboardCosts = route({
  method: "get",
  path: "/api/session-costs/dashboard",
  pattern: ["api", "session-costs", "dashboard"],
  summary: "Cost today and month-to-date for dashboard",
  tags: ["Session Data"],
  responses: {
    200: { description: "Dashboard cost data" },
  },
});

const listSessionCosts = route({
  method: "get",
  path: "/api/session-costs",
  pattern: ["api", "session-costs"],
  summary: "Query session costs with filters",
  tags: ["Session Data"],
  query: z.object({
    agentId: z.string().optional(),
    taskId: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    limit: z.coerce.number().int().min(1).optional(),
  }),
  responses: {
    200: { description: "Session costs" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleSessionData(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  _myAgentId: string | undefined,
): Promise<boolean> {
  if (createSessionLogsRoute.match(req.method, pathSegments)) {
    const parsed = await createSessionLogsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      createSessionLogs({
        taskId: parsed.body.taskId || undefined,
        sessionId: parsed.body.sessionId,
        iteration: parsed.body.iteration,
        cli: parsed.body.cli || "claude",
        lines: parsed.body.lines,
      });
      json(res, { success: true, count: parsed.body.lines.length }, 201);
    } catch (error) {
      console.error("[HTTP] Failed to create session logs:", error);
      jsonError(res, "Failed to store session logs", 500);
    }
    return true;
  }

  if (getSessionLogsByTask.match(req.method, pathSegments)) {
    const parsed = await getSessionLogsByTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const task = getTaskById(parsed.params.taskId);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    const logs = getSessionLogsByTaskId(parsed.params.taskId, parsed.query?.limit);
    json(res, { logs });
    return true;
  }

  if (createSessionCostRoute.match(req.method, pathSegments)) {
    const parsed = await createSessionCostRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const inputTokens = parsed.body.inputTokens ?? 0;
      const cachedInputTokens = parsed.body.cacheReadTokens ?? 0;
      const cacheWriteTokens = parsed.body.cacheWriteTokens ?? 0;
      const outputTokens = parsed.body.outputTokens ?? 0;
      // Phase 2: don't paper over a missing model with a fake default — that
      // poisoned the pricing-table lookup against the wrong rate. Only the
      // back-compat case (no provider tag) keeps "opus" so old callers don't
      // explode.
      const model = parsed.body.model || (parsed.body.provider ? "" : "opus");

      // Phase 2: widen the recompute branch beyond codex. For any provider
      // with a known model and seeded pricing rows, recompute `totalCostUsd`
      // from tokens × DB prices and tag the row 'pricing-table'. When the
      // (provider, model) pair has no pricing rows at all, tag 'unpriced' so
      // the UI can flag it. When the provider isn't set, fall through with
      // 'harness' (back-compat for older callers).
      let totalCostUsd = parsed.body.totalCostUsd;
      let costSource: SessionCostSource = "harness";

      if (parsed.body.provider && model) {
        const lookupTime = parsed.body.createdAt ?? Date.now();
        // Phase 2 fix — different harnesses prepend routing prefixes
        // (`openrouter/`, `github-copilot/`, …) to the same underlying model
        // id. The pricing seed stores canonical (un-prefixed) keys, so we
        // strip the prefix here before lookup. The original adapter-emitted
        // string is still persisted to `session_costs.model` for debugging.
        const lookupModel = normalizeModelKey(parsed.body.provider, model);
        const inputRow = getActivePricingRow(
          parsed.body.provider,
          lookupModel,
          "input",
          lookupTime,
        );
        const cachedRow = getActivePricingRow(
          parsed.body.provider,
          lookupModel,
          "cached_input",
          lookupTime,
        );
        const outputRow = getActivePricingRow(
          parsed.body.provider,
          lookupModel,
          "output",
          lookupTime,
        );
        const cacheWriteRow = getActivePricingRow(
          parsed.body.provider,
          lookupModel,
          "cache_write",
          lookupTime,
        );

        if (inputRow && outputRow) {
          // Mirror the legacy codex semantic: uncached input is billed at the
          // full rate, cached input at the discounted rate. Cache writes are
          // billed separately when the provider's pricing table carries that
          // class (anthropic) and the adapter reports a non-zero value.
          const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
          const cachedRate = cachedRow?.pricePerMillionUsd ?? 0;
          const cacheWriteRate = cacheWriteRow?.pricePerMillionUsd ?? 0;
          totalCostUsd =
            (uncachedInputTokens * inputRow.pricePerMillionUsd +
              cachedInputTokens * cachedRate +
              cacheWriteTokens * cacheWriteRate +
              outputTokens * outputRow.pricePerMillionUsd) /
            1_000_000;
          costSource = "pricing-table";
        } else {
          // Provider was tagged but we have no pricing rows for it; flag the
          // row so the UI can show an "unpriced" badge instead of pretending.
          costSource = "unpriced";
        }
      }

      const cost = createSessionCost({
        sessionId: parsed.body.sessionId,
        taskId: parsed.body.taskId || undefined,
        agentId: parsed.body.agentId,
        totalCostUsd,
        inputTokens,
        outputTokens,
        cacheReadTokens: cachedInputTokens,
        cacheWriteTokens: parsed.body.cacheWriteTokens ?? 0,
        reasoningOutputTokens: parsed.body.reasoningOutputTokens ?? 0,
        thinkingTokens: parsed.body.thinkingTokens ?? 0,
        durationMs: parsed.body.durationMs ?? 0,
        // Migration 063: pass null through honestly instead of faking a 1.
        numTurns: parsed.body.numTurns ?? null,
        model,
        isError: parsed.body.isError ?? false,
        costSource,
      });
      incrementServerSessionsProcessed();
      json(res, { success: true, cost }, 201);
    } catch (error) {
      console.error("[HTTP] Failed to create session cost:", error);
      jsonError(res, "Failed to store session cost", 500);
    }
    return true;
  }

  if (getSessionCostSummaryRoute.match(req.method, pathSegments)) {
    const parsed = await getSessionCostSummaryRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const summary = getSessionCostSummary({
      startDate: parsed.query.startDate || undefined,
      endDate: parsed.query.endDate || undefined,
      agentId: parsed.query.agentId || undefined,
      groupBy: parsed.query.groupBy || "both",
    });
    json(res, summary);
    return true;
  }

  if (getDashboardCosts.match(req.method, pathSegments)) {
    const dashboardCosts = getDashboardCostSummary();
    json(res, dashboardCosts);
    return true;
  }

  if (listSessionCosts.match(req.method, pathSegments)) {
    const parsed = await listSessionCosts.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const limit = parsed.query.limit ?? 100;
    const { agentId, taskId, startDate, endDate } = parsed.query;

    let costs: SessionCost[];
    if (taskId) {
      costs = getSessionCostsByTaskId(taskId, limit);
    } else if (startDate || endDate) {
      costs = getSessionCostsFiltered({
        agentId: agentId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        limit,
      });
    } else if (agentId) {
      costs = getSessionCostsByAgentId(agentId, limit);
    } else {
      costs = getAllSessionCosts(limit);
    }

    json(res, { costs });
    return true;
  }

  return false;
}
