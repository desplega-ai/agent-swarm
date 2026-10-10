import type { EventCategory, EventName, EventSource, EventStatus, SwarmEvent } from "../types";
import { type ScrubbedText, scrubObject, scrubSecrets } from "../utils/secret-scrubber";
import { getDbClient } from "./db";
import type { DbExecutor } from "./db-client";
import { breaksJsonValidity } from "./scrub-json";
import { recordSkillInvocation } from "./skill-invocations";

// -- Events --

type EventRow = {
  id: string;
  category: string;
  event: string;
  status: string;
  source: string;
  agentId: string | null;
  taskId: string | null;
  sessionId: string | null;
  parentEventId: string | null;
  numericValue: number | null;
  durationMs: number | null;
  data: string | null;
  createdAt: string;
};

function rowToSwarmEvent(row: EventRow): SwarmEvent {
  return {
    id: row.id,
    category: row.category as EventCategory,
    event: row.event as EventName,
    status: row.status as EventStatus,
    source: row.source as EventSource,
    agentId: row.agentId ?? undefined,
    taskId: row.taskId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    parentEventId: row.parentEventId ?? undefined,
    numericValue: row.numericValue ?? undefined,
    durationMs: row.durationMs ?? undefined,
    data: row.data ? JSON.parse(row.data) : undefined,
    createdAt: row.createdAt,
  };
}

const INSERT_EVENT_SQL = `INSERT INTO events (id, category, event, status, source, agentId, taskId,
       sessionId, parentEventId, numericValue, durationMs, data, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

// ─── Create ─────────────────────────────────────────────────────────────────

export interface CreateEventInput {
  category: EventCategory;
  event: EventName;
  status?: EventStatus;
  source: EventSource;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  parentEventId?: string;
  numericValue?: number;
  durationMs?: number;
  data?: Record<string, unknown>;
}

/**
 * Serialize an event payload for `events.data` with secrets redacted. Scrubs
 * the serialized string; if a redaction breaks JSON validity (e.g. a marker
 * swallowed a closing quote), falls back to scrubbing each leaf string so the
 * column always parses for `rowToSwarmEvent`.
 */
function serializeEventData(data: Record<string, unknown>): ScrubbedText {
  const raw = JSON.stringify(data);
  const scrubbed = scrubSecrets(raw);
  if (!breaksJsonValidity(raw, scrubbed)) return scrubbed;
  // Every leaf string went through scrubSecrets, so the brand holds.
  return JSON.stringify(scrubObject(data)) as ScrubbedText;
}

async function insertEvent(db: DbExecutor, id: string, input: CreateEventInput): Promise<void> {
  await db.run(INSERT_EVENT_SQL, [
    id,
    input.category,
    input.event,
    input.status ?? "ok",
    input.source,
    input.agentId ?? null,
    input.taskId ?? null,
    input.sessionId ?? null,
    input.parentEventId ?? null,
    input.numericValue ?? null,
    input.durationMs ?? null,
    input.data ? serializeEventData(input.data) : null,
  ]);
  // `skill.invoke` also feeds the per-skill counter and invocation history.
  await recordSkillInvocation(db, input, id);
}

export async function createEvent(input: CreateEventInput): Promise<SwarmEvent> {
  const id = crypto.randomUUID();
  if (input.event === "skill.invoke") {
    await getDbClient().transaction((tx) => insertEvent(tx, id, input));
  } else {
    await insertEvent(getDbClient(), id, input);
  }
  return {
    id,
    category: input.category,
    event: input.event,
    status: input.status ?? "ok",
    source: input.source,
    agentId: input.agentId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    parentEventId: input.parentEventId,
    numericValue: input.numericValue,
    durationMs: input.durationMs,
    data: input.data,
    createdAt: new Date().toISOString(),
  };
}

export async function createEventsBatch(inputs: CreateEventInput[]): Promise<number> {
  await getDbClient().transaction(async (tx) => {
    for (const input of inputs) {
      await insertEvent(tx, crypto.randomUUID(), input);
    }
  });
  return inputs.length;
}

// ─── Query ──────────────────────────────────────────────────────────────────

export async function getEventsByCategory(
  category: EventCategory,
  limit = 100,
): Promise<SwarmEvent[]> {
  const rows = await getDbClient().query<EventRow>(
    "SELECT * FROM events WHERE category = ? ORDER BY createdAt DESC LIMIT ?",
    [category, limit],
  );
  return rows.map(rowToSwarmEvent);
}

export async function getEventsByEvent(event: EventName, limit = 100): Promise<SwarmEvent[]> {
  const rows = await getDbClient().query<EventRow>(
    "SELECT * FROM events WHERE event = ? ORDER BY createdAt DESC LIMIT ?",
    [event, limit],
  );
  return rows.map(rowToSwarmEvent);
}

export async function getEventsByAgentId(agentId: string, limit = 100): Promise<SwarmEvent[]> {
  const rows = await getDbClient().query<EventRow>(
    "SELECT * FROM events WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?",
    [agentId, limit],
  );
  return rows.map(rowToSwarmEvent);
}

export async function getEventsByTaskId(taskId: string, limit = 100): Promise<SwarmEvent[]> {
  const rows = await getDbClient().query<EventRow>(
    "SELECT * FROM events WHERE taskId = ? ORDER BY createdAt DESC LIMIT ?",
    [taskId, limit],
  );
  return rows.map(rowToSwarmEvent);
}

export async function getEventsBySessionId(sessionId: string, limit = 100): Promise<SwarmEvent[]> {
  const rows = await getDbClient().query<EventRow>(
    "SELECT * FROM events WHERE sessionId = ? ORDER BY createdAt DESC LIMIT ?",
    [sessionId, limit],
  );
  return rows.map(rowToSwarmEvent);
}

export async function getAllEvents(limit = 100): Promise<SwarmEvent[]> {
  const rows = await getDbClient().query<EventRow>(
    "SELECT * FROM events ORDER BY createdAt DESC LIMIT ?",
    [limit],
  );
  return rows.map(rowToSwarmEvent);
}

export async function getEventCounts(): Promise<Array<{ event: string; count: number }>> {
  return await getDbClient().query<{ event: string; count: number }>(
    "SELECT event, COUNT(*) as count FROM events GROUP BY event ORDER BY count DESC",
  );
}

export async function getEventCountsForAgent(
  agentId: string,
): Promise<Array<{ event: string; count: number }>> {
  return await getDbClient().query<{ event: string; count: number }>(
    "SELECT event, COUNT(*) as count FROM events WHERE agentId = ? GROUP BY event ORDER BY count DESC",
    [agentId],
  );
}

export async function getEventCountsFiltered(filters: {
  category?: EventCategory;
  source?: EventSource;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  since?: string;
  until?: string;
}): Promise<Array<{ event: string; count: number }>> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.category) {
    conditions.push("category = ?");
    params.push(filters.category);
  }
  if (filters.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  if (filters.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }
  if (filters.taskId) {
    conditions.push("taskId = ?");
    params.push(filters.taskId);
  }
  if (filters.sessionId) {
    conditions.push("sessionId = ?");
    params.push(filters.sessionId);
  }
  if (filters.since) {
    conditions.push("createdAt >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push("createdAt <= ?");
    params.push(filters.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT event, COUNT(*) as count FROM events ${where} GROUP BY event ORDER BY count DESC`;
  return await getDbClient().query<{ event: string; count: number }>(sql, params);
}

export async function getEventsFiltered(filters: {
  category?: EventCategory;
  event?: EventName;
  status?: EventStatus;
  source?: EventSource;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  dataField?: string;
  since?: string;
  until?: string;
  limit?: number;
  /** Match any of these event names (`event IN (...)`), ANDed with `event`. */
  events?: EventName[];
  /**
   * Return only the newest row per (event, data.field) pair, for every pair of
   * these event names and field values. Each pair is its own indexed
   * `ORDER BY createdAt DESC LIMIT 1` lookup, so the cost does not grow with
   * the agent's event history.
   */
  latestPerDataField?: { events: EventName[]; dataFields: string[] };
}): Promise<SwarmEvent[]> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.category) {
    conditions.push("category = ?");
    params.push(filters.category);
  }
  if (filters.event) {
    conditions.push("event = ?");
    params.push(filters.event);
  }
  if (filters.events && filters.events.length > 0) {
    conditions.push(`event IN (${filters.events.map(() => "?").join(", ")})`);
    params.push(...filters.events);
  }
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  if (filters.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }
  if (filters.taskId) {
    conditions.push("taskId = ?");
    params.push(filters.taskId);
  }
  if (filters.sessionId) {
    conditions.push("sessionId = ?");
    params.push(filters.sessionId);
  }
  if (filters.dataField) {
    conditions.push("json_extract(data, '$.field') = ?");
    params.push(filters.dataField);
  }
  if (filters.since) {
    conditions.push("createdAt >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push("createdAt <= ?");
    params.push(filters.until);
  }

  const limit = filters.limit ?? 100;

  if (filters.latestPerDataField) {
    const lookups: string[] = [];
    const lookupParams: (string | number)[] = [];
    for (const event of filters.latestPerDataField.events) {
      for (const field of filters.latestPerDataField.dataFields) {
        const where = [...conditions, "event = ?", "json_extract(data, '$.field') = ?"];
        lookups.push(
          `SELECT * FROM (SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY createdAt DESC LIMIT 1)`,
        );
        lookupParams.push(...params, event, field);
      }
    }
    if (lookups.length === 0) return [];
    const sql = `${lookups.join(" UNION ALL ")} ORDER BY createdAt DESC LIMIT ?`;
    const rows = await getDbClient().query<EventRow>(sql, [...lookupParams, limit]);
    return rows.map(rowToSwarmEvent);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const sql = `SELECT * FROM events ${where} ORDER BY createdAt DESC LIMIT ?`;
  const rows = await getDbClient().query<EventRow>(sql, params);
  return rows.map(rowToSwarmEvent);
}
