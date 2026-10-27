import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDbClient, listInboxState, upsertInboxState } from "../be/db";
import { getUserGrant } from "../be/rbac-roles";
import { isRbacEnabled } from "../rbac";
import { InboxItemStateSchema, InboxItemStatusSchema, InboxItemTypeSchema } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listState = route({
  method: "get",
  path: "/api/inbox-state",
  pattern: ["api", "inbox-state"],
  summary: "List inbox-item state rows for a user",
  tags: ["Inbox State"],
  query: z.object({
    userId: z.string(),
    status: InboxItemStatusSchema.optional(),
    itemType: InboxItemTypeSchema.optional(),
  }),
  responses: {
    200: {
      description: "Inbox state rows",
      schema: z.object({ items: z.array(InboxItemStateSchema) }),
    },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const inboxStateItemSchema = z.object({
  itemType: InboxItemTypeSchema,
  itemId: z.string().min(1),
  status: InboxItemStatusSchema,
  snoozeUntil: z.string().datetime().optional(),
  readAt: z.string().datetime().optional(),
  lastReadAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .describe(
      "Omit to preserve the read cursor, send null to clear it, or send a timestamp to set it, including an earlier time.",
    ),
});

const upsertState = route({
  method: "patch",
  path: "/api/inbox-state",
  pattern: ["api", "inbox-state"],
  summary: "Upsert per-user dismiss/snooze/done state for an inbox item",
  tags: ["Inbox State"],
  body: inboxStateItemSchema.extend({ userId: z.string() }),
  responses: {
    200: {
      description: "Upserted inbox state row",
      schema: z.object({ item: InboxItemStateSchema }),
    },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
    403: { description: "A non-admin user token wrote another user's state" },
  },
  auth: { apiKey: true },
  rbac: { permission: "favorite.write.own" },
});

const bulkUpsertState = route({
  method: "patch",
  path: "/api/inbox-state/bulk",
  pattern: ["api", "inbox-state", "bulk"],
  summary: "Upsert inbox-item state in one transaction",
  tags: ["Inbox State"],
  body: z.object({
    userId: z.string(),
    items: z.array(inboxStateItemSchema).min(1).max(200),
  }),
  responses: {
    200: {
      description: "Upserted inbox state rows in request order",
      schema: z.object({ items: z.array(InboxItemStateSchema) }),
    },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
    403: { description: "A non-admin user token wrote another user's state" },
  },
  auth: { apiKey: true },
  rbac: { permission: "favorite.write.own" },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

const OTHER_USER_STATE_DENIED = "You can only change your own inbox state";

/**
 * True when a user token without a grant-all role names another user's
 * `userId`. Operator-key and admin callers keep writing any user's state.
 */
async function writesOtherUsersState(req: IncomingMessage, userId: string): Promise<boolean> {
  const auth = getRequestAuth(req);
  if (auth?.kind !== "user" || auth.userId === userId || !isRbacEnabled()) return false;
  return !(await getUserGrant(auth.userId)).grantsAll;
}

export async function handleInboxState(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (listState.match(req.method, pathSegments)) {
    const parsed = await listState.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const items = await listInboxState({
      userId: parsed.query.userId,
      status: parsed.query.status,
      itemType: parsed.query.itemType,
    });
    listState.respond(res, 200, { items });
    return true;
  }

  if (bulkUpsertState.match(req.method, pathSegments)) {
    const parsed = await bulkUpsertState.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (await writesOtherUsersState(req, parsed.body.userId)) {
      jsonError(res, OTHER_USER_STATE_DENIED, 403);
      return true;
    }
    try {
      const items = await getDbClient().transaction(async () => {
        const rows = [];
        for (const item of parsed.body.items) {
          rows.push(await upsertInboxState({ ...item, userId: parsed.body.userId }));
        }
        return rows;
      });
      bulkUpsertState.respond(res, 200, { items });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to upsert inbox state", 500);
    }
    return true;
  }

  if (upsertState.match(req.method, pathSegments)) {
    const parsed = await upsertState.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (await writesOtherUsersState(req, parsed.body.userId)) {
      jsonError(res, OTHER_USER_STATE_DENIED, 403);
      return true;
    }
    try {
      const item = await upsertInboxState({
        userId: parsed.body.userId,
        itemType: parsed.body.itemType,
        itemId: parsed.body.itemId,
        status: parsed.body.status,
        snoozeUntil: parsed.body.snoozeUntil,
        readAt: parsed.body.readAt,
        lastReadAt: parsed.body.lastReadAt,
      });
      upsertState.respond(res, 200, { item });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to upsert inbox state", 500);
    }
    return true;
  }

  return false;
}
