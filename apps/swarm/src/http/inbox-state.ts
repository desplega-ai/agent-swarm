import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { listInboxState, upsertInboxState } from "../be/db";
import { InboxItemStatusSchema, InboxItemTypeSchema } from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

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
    200: { description: "Inbox state rows" },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const upsertState = route({
  method: "patch",
  path: "/api/inbox-state",
  pattern: ["api", "inbox-state"],
  summary: "Upsert per-user dismiss/snooze/done state for an inbox item",
  tags: ["Inbox State"],
  body: z.object({
    userId: z.string(),
    itemType: InboxItemTypeSchema,
    itemId: z.string().min(1),
    status: InboxItemStatusSchema,
    snoozeUntil: z.string().datetime().optional(),
  }),
  responses: {
    200: { description: "Upserted inbox state row" },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleInboxState(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (listState.match(req.method, pathSegments)) {
    const parsed = await listState.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const items = listInboxState({
      userId: parsed.query.userId,
      status: parsed.query.status,
      itemType: parsed.query.itemType,
    });
    json(res, { items });
    return true;
  }

  if (upsertState.match(req.method, pathSegments)) {
    const parsed = await upsertState.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      const item = upsertInboxState({
        userId: parsed.body.userId,
        itemType: parsed.body.itemType,
        itemId: parsed.body.itemId,
        status: parsed.body.status,
        snoozeUntil: parsed.body.snoozeUntil,
      });
      json(res, { item });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to upsert inbox state", 500);
    }
    return true;
  }

  return false;
}
