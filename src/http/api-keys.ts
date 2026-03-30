import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  getAvailableKeyIndices,
  getKeyCostSummary,
  getKeyStatuses,
  markKeyRateLimited,
  recordKeyUsage,
} from "../be/db";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const reportUsage = route({
  method: "post",
  path: "/api/keys/report-usage",
  pattern: ["api", "keys", "report-usage"],
  summary: "Record which API key was used for a task",
  tags: ["API Keys"],
  body: z.object({
    keyType: z.string(),
    keySuffix: z.string().min(1).max(10),
    keyIndex: z.number().int().min(0),
    taskId: z.string().uuid().optional(),
    scope: z.string().optional(),
    scopeId: z.string().optional(),
  }),
  responses: {
    200: { description: "Usage recorded" },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const reportRateLimit = route({
  method: "post",
  path: "/api/keys/report-rate-limit",
  pattern: ["api", "keys", "report-rate-limit"],
  summary: "Mark an API key as rate-limited",
  tags: ["API Keys"],
  body: z.object({
    keyType: z.string(),
    keySuffix: z.string().min(1).max(10),
    keyIndex: z.number().int().min(0),
    rateLimitedUntil: z.string().datetime(),
    scope: z.string().optional(),
    scopeId: z.string().optional(),
  }),
  responses: {
    200: { description: "Key marked as rate-limited" },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const getAvailable = route({
  method: "get",
  path: "/api/keys/available",
  pattern: ["api", "keys", "available"],
  summary: "Get available (non-rate-limited) key indices for a credential type",
  tags: ["API Keys"],
  query: z.object({
    keyType: z.string(),
    totalKeys: z.coerce.number().int().min(1),
    scope: z.string().optional(),
    scopeId: z.string().optional(),
  }),
  responses: {
    200: { description: "List of available key indices" },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const listStatuses = route({
  method: "get",
  path: "/api/keys/status",
  pattern: ["api", "keys", "status"],
  summary: "Get all API key status records",
  tags: ["API Keys"],
  query: z.object({
    keyType: z.string().optional(),
    scope: z.string().optional(),
    scopeId: z.string().optional(),
  }),
  responses: {
    200: { description: "List of key status records" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const getCosts = route({
  method: "get",
  path: "/api/keys/costs",
  pattern: ["api", "keys", "costs"],
  summary: "Get aggregated cost data per API key",
  tags: ["API Keys"],
  query: z.object({
    keyType: z.string().optional(),
  }),
  responses: {
    200: { description: "Per-key cost aggregation" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleApiKeys(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  // POST /api/keys/report-usage
  if (reportUsage.match(req.method, pathSegments)) {
    const parsed = await reportUsage.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { keyType, keySuffix, keyIndex, taskId, scope, scopeId } = parsed.body;
    try {
      recordKeyUsage(keyType, keySuffix, keyIndex, taskId ?? null, scope, scopeId ?? null);
      json(res, { success: true, message: "Key usage recorded" });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to record usage", 500);
    }
    return true;
  }

  // POST /api/keys/report-rate-limit
  if (reportRateLimit.match(req.method, pathSegments)) {
    const parsed = await reportRateLimit.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { keyType, keySuffix, keyIndex, rateLimitedUntil, scope, scopeId } = parsed.body;
    try {
      markKeyRateLimited(keyType, keySuffix, keyIndex, rateLimitedUntil, scope, scopeId ?? null);
      json(res, {
        success: true,
        message: `Key ...${keySuffix} marked as rate-limited until ${rateLimitedUntil}`,
      });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to mark rate limit", 500);
    }
    return true;
  }

  // GET /api/keys/available
  if (getAvailable.match(req.method, pathSegments)) {
    const parsed = await getAvailable.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { keyType, totalKeys, scope, scopeId } = parsed.query;
    try {
      const indices = getAvailableKeyIndices(keyType, totalKeys, scope, scopeId ?? null);
      json(res, { success: true, availableIndices: indices, totalKeys });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to get available keys", 500);
    }
    return true;
  }

  // GET /api/keys/costs
  if (getCosts.match(req.method, pathSegments)) {
    const parsed = await getCosts.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { keyType } = parsed.query;
    try {
      const costs = getKeyCostSummary(keyType);
      json(res, { success: true, costs });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to get key costs", 500);
    }
    return true;
  }

  // GET /api/keys/status
  if (listStatuses.match(req.method, pathSegments)) {
    const parsed = await listStatuses.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { keyType, scope, scopeId } = parsed.query;
    try {
      const statuses = getKeyStatuses(keyType, scope, scopeId ?? null);
      json(res, { success: true, keys: statuses });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to get key statuses", 500);
    }
    return true;
  }

  return false;
}
