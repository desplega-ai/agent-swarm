/**
 * `events/list`, `events/subscribe` and `events/unsubscribe` for the user MCP
 * (SEP-3415 draft, webhook delivery only).
 *
 * Backward compatibility: nothing here runs unless a client sends an
 * `events/*` request. The only change a non-events client sees is the added
 * capability keys in the `initialize` result.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { getTaskById } from "@/be/db";
import type { User } from "@/types";
import {
  EVENT_DESCRIPTORS,
  EVENTS_EXTENSION_ID,
  EventsErrorCode,
  isTaskEventName,
  parseTaskEventArguments,
} from "./catalog";
import {
  canonicalJson,
  countLiveSubscriptions,
  deleteExpiredSubscriptions,
  deleteSubscription,
  getSubscription,
  latestVerification,
  subscriptionIdFor,
  upsertSubscription,
} from "./store";
import { callbackUrlProblem, parseWebhookSecret, verifyCallbackEndpoint } from "./webhook";

export const MAX_SUBSCRIPTIONS_PER_USER = 25;
export const DEFAULT_TTL_MS = 60 * 60 * 1000;
export const MIN_TTL_MS = 60 * 1000;
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a passed verification challenge covers this user's later subscribes to the URL. */
export const VERIFICATION_CACHE_MS = 24 * 60 * 60 * 1000;
/** Dual-signing window after a client rotates its secret. */
export const ROTATION_GRACE_MS = 10 * 60 * 1000;

class EventsRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function invalidParams(message: string): EventsRpcError {
  return new EventsRpcError(EventsErrorCode.InvalidParams, message);
}

function resourceExhausted(): EventsRpcError {
  return new EventsRpcError(EventsErrorCode.ResourceExhausted, "Too many subscriptions", {
    limit: "subscriptions",
    max: MAX_SUBSCRIPTIONS_PER_USER,
  });
}

// Loose params: validation happens in the handler so a bad request gets
// InvalidParams with a useful message instead of a schema-parse InternalError.
const EventsListRequestSchema = z.object({
  method: z.literal("events/list"),
  params: z.unknown().optional(),
});
const EventsSubscribeRequestSchema = z.object({
  method: z.literal("events/subscribe"),
  params: z.unknown().optional(),
});
const EventsUnsubscribeRequestSchema = z.object({
  method: z.literal("events/unsubscribe"),
  params: z.unknown().optional(),
});

type SubscriptionKey = {
  name: "task.completed" | "task.failed";
  arguments: { taskId?: string };
  argumentsJson: string;
  url: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseKey(rawParams: unknown): SubscriptionKey & { delivery: Record<string, unknown> } {
  const params = asRecord(rawParams);
  if (typeof params.name !== "string") throw invalidParams("name is required");
  if (!isTaskEventName(params.name)) {
    throw new EventsRpcError(EventsErrorCode.NotFound, `Unknown event: ${params.name}`, {
      kind: "event",
    });
  }
  const args = parseTaskEventArguments(params.arguments);
  if (!args) throw invalidParams("arguments do not match the event's inputSchema");
  const delivery = asRecord(params.delivery);
  if (delivery.mode !== undefined && delivery.mode !== "webhook") {
    throw new EventsRpcError(EventsErrorCode.Unsupported, "Only webhook delivery is offered", {
      feature: "deliveryMode",
      value: delivery.mode,
    });
  }
  const urlProblem = callbackUrlProblem(delivery.url);
  if (urlProblem) throw invalidParams(urlProblem);
  return {
    name: params.name,
    arguments: args,
    argumentsJson: canonicalJson(args),
    url: delivery.url as string,
    delivery,
  };
}

/** Client suggestion → granted TTL. Never grants no-expiry; clamps instead of rejecting. */
export function grantTtlMs(raw: unknown): number {
  if (raw === undefined) return DEFAULT_TTL_MS;
  if (raw === null) return MAX_TTL_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw))
    throw invalidParams("ttlMs must be a number");
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(raw)));
}

export type EventsAuthorizer = (method: string) => Promise<boolean>;

/** Verification POSTs allowed per user, and in total, per rolling hour. */
export const VERIFICATIONS_PER_USER_PER_HOUR = 30;
export const VERIFICATIONS_PER_HOUR = 1000;
const HOUR_MS = 60 * 60 * 1000;
// shortcut: in-memory and per API process, upgrade if the API runs several replicas.
const verificationLog = new Map<string, number[]>();

/** Records one verification POST unless the user or global hourly budget is spent. */
function takeVerificationBudget(userId: string, now: number): boolean {
  const recent = (key: string) =>
    (verificationLog.get(key) ?? []).filter((at) => at > now - HOUR_MS);
  const mine = recent(userId);
  const all = recent("*");
  if (mine.length >= VERIFICATIONS_PER_USER_PER_HOUR || all.length >= VERIFICATIONS_PER_HOUR) {
    return false;
  }
  verificationLog.set(userId, [...mine, now]);
  verificationLog.set("*", [...all, now]);
  return true;
}

async function handleSubscribe(
  user: User,
  tokenId: string,
  authorize: EventsAuthorizer,
  rawParams: unknown,
) {
  const key = parseKey(rawParams);
  const secretText = key.delivery.secret;
  const secret = parseWebhookSecret(secretText);
  if (!secret) {
    throw invalidParams("delivery.secret must be whsec_ followed by base64 of 24 to 64 bytes");
  }
  const ttlMs = grantTtlMs(asRecord(rawParams).ttlMs);
  if (!(await authorize("events/subscribe"))) {
    throw new EventsRpcError(EventsErrorCode.Forbidden, "Forbidden");
  }
  if (key.arguments.taskId) {
    const task = await getTaskById(key.arguments.taskId);
    // One answer for "missing" and "not yours", so the filter is not an existence oracle.
    if (!task || task.requestedByUserId !== user.id) {
      throw new EventsRpcError(EventsErrorCode.Forbidden, "taskId is not one of your tasks");
    }
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  await deleteExpiredSubscriptions(nowIso);
  const id = subscriptionIdFor(user.id, key.url, key.name, key.argumentsJson);
  const previous = await getSubscription(id);
  const refreshing = previous !== null && previous.expiresAt > nowIso;
  // Checked again inside the upsert transaction; this early check keeps a
  // capped user from sending verification POSTs to new URLs.
  if (
    !refreshing &&
    (await countLiveSubscriptions(user.id, nowIso)) >= MAX_SUBSCRIPTIONS_PER_USER
  ) {
    throw resourceExhausted();
  }

  let verifiedAt = await latestVerification(
    user.id,
    key.url,
    new Date(now - VERIFICATION_CACHE_MS).toISOString(),
    nowIso,
  );
  if (!verifiedAt) {
    // Unsubscribe or expiry frees a live slot, so the live cap alone does not
    // bound challenge POSTs; this budget does.
    if (!takeVerificationBudget(user.id, now)) {
      throw new EventsRpcError(EventsErrorCode.ResourceExhausted, "Too many verifications", {
        limit: "verifications",
        max: VERIFICATIONS_PER_USER_PER_HOUR,
      });
    }
    const failure = await verifyCallbackEndpoint({ url: key.url, subscriptionId: id, secret });
    if (failure) {
      throw new EventsRpcError(
        EventsErrorCode.CallbackEndpointError,
        "Callback endpoint verification failed",
        { reason: failure },
      );
    }
    verifiedAt = nowIso;
  }

  const row = await upsertSubscription({
    id,
    userId: user.id,
    tokenId,
    eventName: key.name,
    argumentsJson: key.argumentsJson,
    url: key.url,
    secret: secretText as string,
    verifiedAt,
    expiresAt: new Date(now + ttlMs).toISOString(),
    nowIso,
    rotationGraceUntil: new Date(now + ROTATION_GRACE_MS).toISOString(),
    maxActivePerUser: MAX_SUBSCRIPTIONS_PER_USER,
  });
  if (row === "limit") throw resourceExhausted();

  return {
    resultType: "complete",
    id: row.id,
    refreshBefore: row.expiresAt,
    // task.* events are emit-only: no replay, so no cursor.
    cursor: null,
    truncated: false,
    ...(refreshing
      ? {
          deliveryStatus: {
            active: true,
            lastDeliveryAt: row.lastDeliveryAt,
            lastError: row.lastError,
            ...(row.failedSince ? { failedSince: row.failedSince } : {}),
          },
        }
      : {}),
  };
}

async function handleUnsubscribe(user: User, authorize: EventsAuthorizer, rawParams: unknown) {
  const key = parseKey(rawParams);
  if (!(await authorize("events/unsubscribe"))) {
    throw new EventsRpcError(EventsErrorCode.Forbidden, "Forbidden");
  }
  // Idempotent: an unknown or already-expired key is a successful no-op.
  await deleteSubscription(
    subscriptionIdFor(user.id, key.url, key.name, key.argumentsJson),
    user.id,
  );
  return { resultType: "complete" };
}

/**
 * Advertises the events capability and registers the `events/*` handlers on
 * one user session's server. Call before `connect`.
 *
 * Two capability keys, because the two documents disagree: SEP-3415 puts the
 * extension under `capabilities.extensions[EVENTS_EXTENSION_ID]`, while the
 * design sketch and OpenAI's ChatGPT guide use `capabilities.events` in the
 * `initialize` result.
 */
export function registerUserEvents(
  server: McpServer,
  user: User,
  tokenId: string,
  authorize: EventsAuthorizer,
): void {
  server.server.registerCapabilities({
    events: {},
    extensions: { [EVENTS_EXTENSION_ID]: {} },
  } as ServerCapabilities);

  server.server.setRequestHandler(EventsListRequestSchema, async () => ({
    resultType: "complete",
    events: EVENT_DESCRIPTORS,
  }));
  server.server.setRequestHandler(EventsSubscribeRequestSchema, async (request) =>
    handleSubscribe(user, tokenId, authorize, request.params),
  );
  server.server.setRequestHandler(EventsUnsubscribeRequestSchema, async (request) =>
    handleUnsubscribe(user, authorize, request.params),
  );
}
