import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  clearKeyRateLimit,
  getAvailableKeyIndices,
  getKeyCostSummary,
  getKeyStatuses,
  markKeyRateLimited,
  recordKeyRateLimitWindows,
  recordKeyUsage,
  setApiKeyName,
} from "../be/db";
import { MAX_RATE_LIMIT_RESET_MS, type RateLimitWindowTelemetry } from "../utils/error-tracker";
import { activeModelBlocks, MODEL_SCOPED_WINDOWS } from "../utils/model-rate-limit-windows";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

/** Wire shape sent by every `report-*` acknowledgement route. */
const successMessageSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

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
    200: { description: "Usage recorded", schema: successMessageSchema },
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
    200: { description: "Key marked as rate-limited", schema: successMessageSchema },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

export const rateLimitWindowSchema = z.object({
  status: z.string(),
  utilization: z.number().optional(),
  // .finite() rejects NaN/Infinity at the report boundary; sanitizeReportedWindowResets
  // below still has to guard a finite-but-out-of-range or implausibly far-future value.
  resetsAt: z.number().finite().optional(),
  isUsingOverage: z.boolean().optional(),
  surpassedThreshold: z.number().optional(),
  lastSeenAt: z.string().datetime(),
});

/**
 * Clamps a reported window's `resetsAt` (seconds) to `[now, now+7d]`, the
 * same 7-day ceiling used for the key-wide cooldown (`MAX_RATE_LIMIT_RESET_MS`).
 * Guards two failure modes at the report boundary, in either direction: a
 * finite-but-out-of-Date-range value (e.g. 1e20 or -1e20) that would
 * otherwise throw when rendered via `new Date(resetsAt * 1000).toISOString()`
 * downstream in `computeModelLimits`, and a representable but implausible
 * value (far-future, or negative/past — a freshly reported window can't
 * reset in the past) that would otherwise read as bogus. NaN/Infinity are
 * already rejected upstream by the route's `.finite()` schema. Applied
 * before storage, so `computeModelLimits` never sees an out-of-range value
 * from data reported through this endpoint.
 */
export function sanitizeReportedWindowResets(
  windows: RateLimitWindowTelemetry,
): RateLimitWindowTelemetry {
  const nowSec = Math.floor(Date.now() / 1000);
  const maxResetsAtSec = Math.floor((Date.now() + MAX_RATE_LIMIT_RESET_MS) / 1000);
  const sanitized: RateLimitWindowTelemetry = {};
  for (const [key, window] of Object.entries(windows)) {
    sanitized[key] =
      window.resetsAt === undefined
        ? window
        : { ...window, resetsAt: Math.min(Math.max(window.resetsAt, nowSec), maxResetsAtSec) };
  }
  return sanitized;
}

const reportRateLimitWindows = route({
  method: "post",
  path: "/api/keys/report-rate-limit-windows",
  pattern: ["api", "keys", "report-rate-limit-windows"],
  summary: "Record provider-emitted rate-limit window telemetry for an API key",
  tags: ["API Keys"],
  body: z.object({
    keyType: z.string(),
    keySuffix: z.string().min(1).max(10),
    keyIndex: z.number().int().min(0),
    windows: z.record(z.string(), rateLimitWindowSchema),
    scope: z.string().optional(),
    scopeId: z.string().optional(),
  }),
  responses: {
    200: {
      description: "Rate-limit window telemetry recorded",
      schema: successMessageSchema,
    },
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
    /** Model family the caller is about to run. Filters out keys with an active weekly window block for that family. */
    model: z.enum(["fable", "opus", "sonnet", "haiku"]).optional(),
  }),
  responses: {
    200: {
      description: "List of available key indices",
      schema: z.object({
        success: z.literal(true),
        availableIndices: z.array(z.number().int()),
        totalKeys: z.number().int(),
        /** Indices excluded only by an active model-scoped window block. Present only when `model` was passed. */
        modelBlockedIndices: z.array(z.number().int()).optional(),
        /** ISO of the earliest reset among modelBlockedIndices. Present only when `model` was passed. */
        earliestModelResetAt: z.string().nullable().optional(),
      }),
    },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

/** Mirrors `ApiKeyStatus` in `src/be/db.ts` (not exported from `src/types.ts`). */
const ApiKeyStatusSchema = z.object({
  id: z.string(),
  keyType: z.string(),
  keySuffix: z.string(),
  keyIndex: z.number().int(),
  scope: z.string(),
  scopeId: z.string().nullable(),
  status: z.string(),
  rateLimitedUntil: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  lastRateLimitAt: z.string().nullable(),
  totalUsageCount: z.number().int(),
  rateLimitCount: z.number().int(),
  /** Optional human-friendly label set from the dashboard. */
  name: z.string().nullable(),
  /** Auto-derived harness provider (claude/pi/codex/...). */
  provider: z.string(),
  /** Latest provider-emitted rate-limit window snapshots, keyed by window type. */
  rateLimitWindows: z.record(z.string(), rateLimitWindowSchema),
  /** Derived, readable view of any rejected model-scoped window (Fable/Opus/Sonnet) on this key. */
  modelLimits: z.array(
    z.object({
      model: z.string(),
      window: z.string(),
      resetsAt: z.number(),
      resetsAtIso: z.string(),
      active: z.boolean(),
    }),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Derives the readable `modelLimits` view from a key's raw `rateLimitWindows`:
 * every model-scoped window (Fable/Opus/Sonnet) with a rejected entry,
 * `active` when its `resetsAt` is still in the future.
 */
export function computeModelLimits(
  windows: Record<string, { status: string; resetsAt?: number }>,
  nowMs: number,
): Array<{
  model: string;
  window: string;
  resetsAt: number;
  resetsAtIso: string;
  active: boolean;
}> {
  const active = activeModelBlocks(windows, nowMs);
  const activeWindows = new Set(active.map((b) => b.window));
  const limits = active.map((b) => ({
    model: b.model,
    window: b.window,
    resetsAt: b.resetsAt,
    resetsAtIso: new Date(b.resetsAt * 1000).toISOString(),
    active: true,
  }));
  for (const window of Object.keys(MODEL_SCOPED_WINDOWS)) {
    if (activeWindows.has(window)) continue;
    const entry = windows[window];
    if (!entry || entry.status !== "rejected" || typeof entry.resetsAt !== "number") continue;
    limits.push({
      model: MODEL_SCOPED_WINDOWS[window]!,
      window,
      resetsAt: entry.resetsAt,
      resetsAtIso: new Date(entry.resetsAt * 1000).toISOString(),
      active: false,
    });
  }
  return limits;
}

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
    200: {
      description: "List of key status records",
      schema: z.object({ success: z.literal(true), keys: z.array(ApiKeyStatusSchema) }),
    },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

/** Mirrors `KeyCostSummary` in `src/be/db.ts`. */
const KeyCostSummarySchema = z.object({
  keyType: z.string(),
  keySuffix: z.string(),
  totalCost: z.number().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
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
    200: {
      description: "Per-key cost aggregation",
      schema: z.object({ success: z.literal(true), costs: z.array(KeyCostSummarySchema) }),
    },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const setKeyName = route({
  method: "patch",
  path: "/api/keys/name",
  pattern: ["api", "keys", "name"],
  summary: "Set or clear the human-friendly label on a pooled credential",
  tags: ["API Keys"],
  body: z.object({
    keyType: z.string().min(1),
    keySuffix: z.string().min(1).max(10),
    /** Pass null or empty string to clear the existing label. */
    name: z.string().max(60).nullable(),
    scope: z.string().optional(),
    scopeId: z.string().optional(),
  }),
  responses: {
    200: {
      description: "Name updated",
      schema: z.object({
        success: z.literal(true),
        keyType: z.string(),
        keySuffix: z.string(),
        name: z.string().nullable(),
      }),
    },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
    404: { description: "Key not found" },
  },
  auth: { apiKey: true },
});

const clearRateLimitRoute = route({
  method: "post",
  path: "/api/keys/clear-rate-limit",
  pattern: ["api", "keys", "clear-rate-limit"],
  summary: "Clear rate-limited status for a key after a successful use proves it is healthy",
  tags: ["API Keys"],
  body: z.object({
    keyType: z.string(),
    keySuffix: z.string().min(1).max(10),
    scope: z.string().optional(),
    scopeId: z.string().optional(),
  }),
  responses: {
    200: {
      description: "Rate limit cleared (or key was not rate-limited)",
      schema: z.object({
        success: z.literal(true),
        cleared: z.boolean(),
        message: z.string(),
      }),
    },
    400: { description: "Validation error" },
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
      await recordKeyUsage(keyType, keySuffix, keyIndex, taskId ?? null, scope, scopeId ?? null);
      reportUsage.respond(res, 200, { success: true, message: "Key usage recorded" });
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
      await markKeyRateLimited(
        keyType,
        keySuffix,
        keyIndex,
        rateLimitedUntil,
        scope,
        scopeId ?? null,
      );
      reportRateLimit.respond(res, 200, {
        success: true,
        message: `Key ...${keySuffix} marked as rate-limited until ${rateLimitedUntil}`,
      });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to mark rate limit", 500);
    }
    return true;
  }

  // POST /api/keys/report-rate-limit-windows
  if (reportRateLimitWindows.match(req.method, pathSegments)) {
    const parsed = await reportRateLimitWindows.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { keyType, keySuffix, keyIndex, windows, scope, scopeId } = parsed.body;
    try {
      await recordKeyRateLimitWindows(
        keyType,
        keySuffix,
        keyIndex,
        sanitizeReportedWindowResets(windows),
        scope,
        scopeId ?? null,
      );
      reportRateLimitWindows.respond(res, 200, {
        success: true,
        message: `Rate-limit windows recorded for ...${keySuffix}`,
      });
    } catch (err) {
      jsonError(
        res,
        err instanceof Error ? err.message : "Failed to record rate-limit windows",
        500,
      );
    }
    return true;
  }

  // GET /api/keys/available
  if (getAvailable.match(req.method, pathSegments)) {
    const parsed = await getAvailable.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { keyType, totalKeys, scope, scopeId, model } = parsed.query;
    try {
      const result = await getAvailableKeyIndices(
        keyType,
        totalKeys,
        scope,
        scopeId ?? null,
        model,
      );
      getAvailable.respond(res, 200, {
        success: true,
        availableIndices: result.availableIndices,
        totalKeys,
        ...(model !== undefined
          ? {
              modelBlockedIndices: result.modelBlockedIndices,
              earliestModelResetAt: result.earliestModelResetAt,
            }
          : {}),
      });
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
      const costs = await getKeyCostSummary(keyType);
      getCosts.respond(res, 200, { success: true, costs });
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
      const statuses = await getKeyStatuses(keyType, scope, scopeId ?? null);
      const nowMs = Date.now();
      const keys = statuses.map((status) => ({
        ...status,
        modelLimits: computeModelLimits(status.rateLimitWindows, nowMs),
      }));
      listStatuses.respond(res, 200, { success: true, keys });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to get key statuses", 500);
    }
    return true;
  }

  // PATCH /api/keys/name
  if (setKeyName.match(req.method, pathSegments)) {
    const parsed = await setKeyName.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { keyType, keySuffix, name, scope, scopeId } = parsed.body;
    try {
      // Empty string is treated as "clear the label" so the dashboard's
      // contenteditable can submit "" without sending an explicit null.
      const value = name === "" ? null : name;
      const updated = await setApiKeyName(keyType, keySuffix, value, scope, scopeId ?? null);
      if (!updated) {
        jsonError(res, `No key matching ${keyType} ...${keySuffix}`, 404);
        return true;
      }
      setKeyName.respond(res, 200, { success: true, keyType, keySuffix, name: value });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to set key name", 500);
    }
    return true;
  }

  // POST /api/keys/clear-rate-limit
  if (clearRateLimitRoute.match(req.method, pathSegments)) {
    const parsed = await clearRateLimitRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { keyType, keySuffix, scope, scopeId } = parsed.body;
    try {
      const cleared = await clearKeyRateLimit(keyType, keySuffix, scope, scopeId ?? null);
      clearRateLimitRoute.respond(res, 200, {
        success: true,
        cleared,
        message: cleared
          ? `Rate limit cleared for ...${keySuffix}`
          : `Key ...${keySuffix} was not rate-limited`,
      });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to clear rate limit", 500);
    }
    return true;
  }

  return false;
}
