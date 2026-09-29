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
  SwarmEventSchema,
} from "../types";
import { route } from "./route-def";
import { jsonError } from "./utils";

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
    201: {
      description: "Event stored",
      schema: z.object({ success: z.literal(true), event: SwarmEventSchema }),
    },
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
    201: {
      description: "Events stored",
      schema: z.object({ success: z.literal(true), count: z.number().int() }),
    },
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
    dataField: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    events: z
      .string()
      .optional()
      .describe("Comma-separated event names; matches any of them (ANDed with `event`)"),
    dataFields: z
      .string()
      .optional()
      .describe("Comma-separated `data.field` values, used with latestPerDataField"),
    latestPerDataField: z
      .enum(["true", "false"])
      .optional()
      .describe(
        "When true, return only the newest event per (event, data.field) pair for every name in `event`/`events` and every value in `dataFields`",
      ),
  }),
  responses: {
    200: {
      description: "List of events",
      schema: z.object({
        events: z.array(SwarmEventSchema),
        latestPerDataField: z
          .literal(true)
          .optional()
          .describe("Present only when the request asked for latestPerDataField=true"),
      }),
    },
    400: { description: "Validation error" },
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
    200: {
      description: "Event counts",
      schema: z.object({
        counts: z.array(z.object({ event: z.string(), count: z.number().int() })),
      }),
    },
  },
  auth: { apiKey: true },
});

/** Bounds the UNION ALL built for latestPerDataField: one indexed lookup per pair. */
const MAX_LATEST_PAIRS = 50;

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
      const count = await createEventsBatch(parsed.body.events);
      createEventsBatchRoute.respond(res, 201, { success: true, count });
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

    const counts = await getEventCountsFiltered({
      category: parsed.query.category || undefined,
      source: parsed.query.source || undefined,
      agentId: parsed.query.agentId || undefined,
      taskId: parsed.query.taskId || undefined,
      sessionId: parsed.query.sessionId || undefined,
      since: parsed.query.since || undefined,
      until: parsed.query.until || undefined,
    });
    getEventCountsRoute.respond(res, 200, { counts });
    return true;
  }

  // POST /api/events — single event
  if (createEventRoute.match(req.method, pathSegments)) {
    const parsed = await createEventRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const event = await createEvent(parsed.body);
      createEventRoute.respond(res, 201, { success: true, event });
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

    const eventNames = parsed.query.events
      ? parsed.query.events.split(",").map((name) => EventNameSchema.safeParse(name.trim()))
      : [];
    const invalid = eventNames.find((result) => !result.success);
    if (invalid) {
      jsonError(res, "Invalid event name in `events`", 400);
      return true;
    }
    const eventFilter = eventNames.flatMap((result) => (result.success ? [result.data] : []));
    const latestPerDataField = parsed.query.latestPerDataField === "true";
    const dataFields = (parsed.query.dataFields ?? "")
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
    const latestEvents =
      eventFilter.length > 0 ? eventFilter : parsed.query.event ? [parsed.query.event] : [];
    if (
      latestPerDataField &&
      (latestEvents.length === 0 ||
        dataFields.length === 0 ||
        latestEvents.length * dataFields.length > MAX_LATEST_PAIRS)
    ) {
      jsonError(
        res,
        `latestPerDataField needs \`event\` or \`events\` and \`dataFields\`, at most ${MAX_LATEST_PAIRS} pairs`,
        400,
      );
      return true;
    }

    const events = await getEventsFiltered({
      category: parsed.query.category || undefined,
      event: parsed.query.event || undefined,
      status: parsed.query.status || undefined,
      source: parsed.query.source || undefined,
      agentId: parsed.query.agentId || undefined,
      taskId: parsed.query.taskId || undefined,
      sessionId: parsed.query.sessionId || undefined,
      dataField: parsed.query.dataField || undefined,
      since: parsed.query.since || undefined,
      until: parsed.query.until || undefined,
      limit: parsed.query.limit ?? 100,
      events: eventFilter,
      latestPerDataField: latestPerDataField ? { events: latestEvents, dataFields } : undefined,
    });
    getEventsRoute.respond(
      res,
      200,
      latestPerDataField ? { events, latestPerDataField: true } : { events },
    );
    return true;
  }

  return false;
}
