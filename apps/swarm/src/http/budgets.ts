// Phase 6: REST CRUD for daily USD budgets per (scope, scopeId).
//
// Auth defaults to apiKey via the `route()` factory (existing convention).
// Every PUT and DELETE writes a row to `agent_log` with eventType
// `budget.upserted` / `budget.deleted` so compliance reviewers can audit
// "who set what budget when". The raw API key is NEVER logged — we record a
// short SHA-256 fingerprint instead, scrubbed via `scrubSecrets` for safety.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createLogEntry,
  deleteBudget,
  getBudget,
  getBudgets,
  getRecentBudgetRefusalNotifications,
  upsertBudget,
} from "../be/db";
import { BudgetRefusalNotificationSchema, BudgetSchema, BudgetScopeSchema } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Short SHA-256 fingerprint of the bearer token for audit-log purposes. Never
 * logs the raw key — only the first 8 hex chars of the digest. Defense in
 * depth: also runs the result through `scrubSecrets` so any future change
 * that accidentally puts the raw key here cannot leak it through logs.
 */
function apiKeyFingerprint(req: IncomingMessage): string {
  const authHeader = req.headers.authorization;
  const providedKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!providedKey) return "";
  const digest = createHash("sha256").update(providedKey).digest("hex").slice(0, 8);
  return scrubSecrets(digest);
}

// ─── Route Definitions ───────────────────────────────────────────────────────

const ScopeIdSchema = z
  .string()
  .max(255)
  .describe("Scope identifier — empty string for global, agent UUID otherwise");

const listBudgets = route({
  method: "get",
  path: "/api/budgets",
  pattern: ["api", "budgets"],
  summary: "List all configured budget rows",
  tags: ["Budgets"],
  responses: {
    200: { description: "Budget list", schema: z.object({ budgets: z.array(BudgetSchema) }) },
  },
});

const listBudgetRefusals = route({
  method: "get",
  path: "/api/budgets/refusals",
  pattern: ["api", "budgets", "refusals"],
  summary: "List recent budget refusal notifications",
  tags: ["Budgets"],
  query: z.object({
    limit: z.coerce.number().int().positive().max(500).optional(),
  }),
  responses: {
    200: {
      description: "Recent budget refusals (newest first)",
      schema: z.object({ refusals: z.array(BudgetRefusalNotificationSchema) }),
    },
  },
});

const getBudgetByScope = route({
  method: "get",
  path: "/api/budgets/{scope}/{scopeId}",
  pattern: ["api", "budgets", null, null],
  summary: "Get a single budget row",
  tags: ["Budgets"],
  params: z.object({ scope: BudgetScopeSchema, scopeId: ScopeIdSchema }),
  responses: {
    200: { description: "Budget row", schema: BudgetSchema },
    404: { description: "Budget not configured" },
  },
});

const upsertBudgetRoute = route({
  method: "put",
  path: "/api/budgets/{scope}/{scopeId}",
  pattern: ["api", "budgets", null, null],
  summary: "Create or update a budget row",
  tags: ["Budgets"],
  params: z.object({ scope: BudgetScopeSchema, scopeId: ScopeIdSchema }),
  body: z.object({
    dailyBudgetUsd: z.number().nonnegative(),
  }),
  responses: {
    200: { description: "Budget upserted", schema: BudgetSchema },
    400: { description: "Validation error" },
  },
});

const deleteBudgetRoute = route({
  method: "delete",
  path: "/api/budgets/{scope}/{scopeId}",
  pattern: ["api", "budgets", null, null],
  summary: "Delete a budget row",
  tags: ["Budgets"],
  params: z.object({ scope: BudgetScopeSchema, scopeId: ScopeIdSchema }),
  responses: {
    204: { description: "Budget deleted" },
    404: { description: "Budget not configured" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleBudgets(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  _myAgentId: string | undefined,
): Promise<boolean> {
  // GET /api/budgets — list
  if (listBudgets.match(req.method, pathSegments)) {
    const parsed = await listBudgets.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    json(res, { budgets: getBudgets() });
    return true;
  }

  // GET /api/budgets/refusals — must come BEFORE the {scope}/{scopeId} routes
  // since those use a 4-segment pattern; this is 3 segments so they are
  // disjoint, but conceptually the literal must win over the wildcards.
  if (listBudgetRefusals.match(req.method, pathSegments)) {
    const parsed = await listBudgetRefusals.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const limit = parsed.query.limit ?? 50;
    json(res, { refusals: getRecentBudgetRefusalNotifications(limit) });
    return true;
  }

  // The single-row routes share the pattern `["api", "budgets", :scope, :scopeId]`.
  // URL-encoded empty `scopeId` ('') is used for the global scope; the
  // route-def `pattern` already requires a non-empty segment, so callers
  // targeting global must pass `'-'` or any non-empty placeholder. To support
  // the spec's "scopeId='' for global" we accept the literal `_global` and
  // map it back here.
  // Note: HTTP path segments cannot be empty strings (filter(Boolean) drops
  // them), so we use `_global` as the wire-format placeholder.

  if (getBudgetByScope.match(req.method, pathSegments)) {
    const parsed = await getBudgetByScope.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const scopeId = parsed.params.scopeId === "_global" ? "" : parsed.params.scopeId;
    const row = getBudget(parsed.params.scope, scopeId);
    if (!row) {
      jsonError(res, "Budget not configured", 404);
      return true;
    }
    json(res, row);
    return true;
  }

  if (upsertBudgetRoute.match(req.method, pathSegments)) {
    const parsed = await upsertBudgetRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const scopeId = parsed.params.scopeId === "_global" ? "" : parsed.params.scopeId;

    const before = getBudget(parsed.params.scope, scopeId);
    const updated = upsertBudget(parsed.params.scope, scopeId, parsed.body.dailyBudgetUsd);

    createLogEntry({
      eventType: "budget.upserted",
      metadata: {
        scope: parsed.params.scope,
        scopeId,
        before: before ? { dailyBudgetUsd: before.dailyBudgetUsd } : null,
        after: { dailyBudgetUsd: updated.dailyBudgetUsd },
        apiKeyFingerprint: apiKeyFingerprint(req),
      },
    });

    json(res, updated);
    return true;
  }

  if (deleteBudgetRoute.match(req.method, pathSegments)) {
    const parsed = await deleteBudgetRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const scopeId = parsed.params.scopeId === "_global" ? "" : parsed.params.scopeId;

    const before = getBudget(parsed.params.scope, scopeId);
    const deleted = deleteBudget(parsed.params.scope, scopeId);
    if (!deleted) {
      jsonError(res, "Budget not configured", 404);
      return true;
    }

    createLogEntry({
      eventType: "budget.deleted",
      metadata: {
        scope: parsed.params.scope,
        scopeId,
        before: before ? { dailyBudgetUsd: before.dailyBudgetUsd } : null,
        apiKeyFingerprint: apiKeyFingerprint(req),
      },
    });

    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}
