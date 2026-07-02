import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createEvent,
  createEventsBatch,
  getEventCountsFiltered,
  getEventsFiltered,
} from "../be/events";
import {
  EventCategorySchema,
  EventNameSchema,
  EventSourceSchema,
  EventStatusSchema,
} from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const eventBodySchema = z.object({
  category: EventCategorySchema,
  event: EventNameSchema,
  status: EventStatusSchema.optional(),
  source: EventSourceSchema,
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  parentEventId: z.string().optional(),
  numericValue: z.number().optional(),
  durationMs: z.number().int().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const createEventRoute = route({
  method: "post",
  path: "/api/events",
  pattern: ["api", "events"],
  summary: "Store a single event",
  tags: ["Events"],
  body: eventBodySchema,
  responses: {
    201: { description: "Event stored" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
});

const createEventsBatchRoute = route({
  method: "post",
  path: "/api/events/batch",
  pattern: ["api", "events", "batch"],
  summary: "Store multiple events in a batch",
  tags: ["Events"],
  body: z.object({
    events: z.array(eventBodySchema).min(1).max(500),
  }),
  responses: {
    201: { description: "Events stored" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
});

const getEventsRoute = route({
  method: "get",
  path: "/api/events",
  pattern: ["api", "events"],
  summary: "Query events with filters",
  tags: ["Events"],
  query: z.object({
    category: EventCategorySchema.optional(),
    event: EventNameSchema.optional(),
    status: EventStatusSchema.optional(),
    source: EventSourceSchema.optional(),
    agentId: z.string().optional(),
    taskId: z.string().optional(),
    sessionId: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }),
  responses: {
    200: { description: "List of events" },
  },
  auth: { apiKey: true },
});

const getEventCountsRoute = route({
  method: "get",
  path: "/api/events/counts",
  pattern: ["api", "events", "counts"],
  summary: "Get event counts grouped by event name",
  tags: ["Events"],
  query: z.object({
    category: EventCategorySchema.optional(),
    source: EventSourceSchema.optional(),
    agentId: z.string().optional(),
    taskId: z.string().optional(),
    sessionId: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
  }),
  responses: {
    200: { description: "Event counts" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  _myAgentId: string | undefined,
): Promise<boolean> {
  // Match batch BEFORE generic /api/events (POST)
  if (createEventsBatchRoute.match(req.method, pathSegments)) {
    const parsed = await createEventsBatchRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const count = createEventsBatch(parsed.body.events);
      json(res, { success: true, count }, 201);
    } catch (error) {
      console.error("[HTTP] Failed to create events batch:", error);
      jsonError(res, "Failed to store events batch", 500);
    }
    return true;
  }

  // Match counts BEFORE generic /api/events (GET)
  if (getEventCountsRoute.match(req.method, pathSegments)) {
    const parsed = await getEventCountsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const counts = getEventCountsFiltered({
      category: parsed.query.category || undefined,
      source: parsed.query.source || undefined,
      agentId: parsed.query.agentId || undefined,
      taskId: parsed.query.taskId || undefined,
      sessionId: parsed.query.sessionId || undefined,
      since: parsed.query.since || undefined,
      until: parsed.query.until || undefined,
    });
    json(res, { counts });
    return true;
  }

  // POST /api/events — single event
  if (createEventRoute.match(req.method, pathSegments)) {
    const parsed = await createEventRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const event = createEvent(parsed.body);
      json(res, { success: true, event }, 201);
    } catch (error) {
      console.error("[HTTP] Failed to create event:", error);
      jsonError(res, "Failed to store event", 500);
    }
    return true;
  }

  // GET /api/events — filtered query
  if (getEventsRoute.match(req.method, pathSegments)) {
    const parsed = await getEventsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const events = getEventsFiltered({
      category: parsed.query.category || undefined,
      event: parsed.query.event || undefined,
      status: parsed.query.status || undefined,
      source: parsed.query.source || undefined,
      agentId: parsed.query.agentId || undefined,
      taskId: parsed.query.taskId || undefined,
      sessionId: parsed.query.sessionId || undefined,
      since: parsed.query.since || undefined,
      until: parsed.query.until || undefined,
      limit: parsed.query.limit ?? 100,
    });
    json(res, { events });
    return true;
  }

  return false;
}
