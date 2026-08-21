import type { EventCategory, EventName, EventSource, EventStatus, SwarmEvent } from "../types";
import { getDbClient } from "./db";

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

export async function createEvent(input: CreateEventInput): Promise<SwarmEvent> {
  const id = crypto.randomUUID();
  await getDbClient().run(INSERT_EVENT_SQL, [
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
    input.data ? JSON.stringify(input.data) : null,
  ]);
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
      await tx.run(INSERT_EVENT_SQL, [
        crypto.randomUUID(),
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
        input.data ? JSON.stringify(input.data) : null,
      ]);
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

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 100;
  params.push(limit);

  const sql = `SELECT * FROM events ${where} ORDER BY createdAt DESC LIMIT ?`;
  const rows = await getDbClient().query<EventRow>(sql, params);
  return rows.map(rowToSwarmEvent);
}
