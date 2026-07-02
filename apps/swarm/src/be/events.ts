import type { EventCategory, EventName, EventSource, EventStatus, SwarmEvent } from "../types";
import { getDb } from "./db";

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

const eventQueries = {
  insert: () =>
    getDb().prepare<
      null,
      [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        string | null,
      ]
    >(
      `INSERT INTO events (id, category, event, status, source, agentId, taskId,
       sessionId, parentEventId, numericValue, durationMs, data, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ),

  getByCategory: () =>
    getDb().prepare<EventRow, [string, number]>(
      "SELECT * FROM events WHERE category = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getByEvent: () =>
    getDb().prepare<EventRow, [string, number]>(
      "SELECT * FROM events WHERE event = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getByAgentId: () =>
    getDb().prepare<EventRow, [string, number]>(
      "SELECT * FROM events WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getByTaskId: () =>
    getDb().prepare<EventRow, [string, number]>(
      "SELECT * FROM events WHERE taskId = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getBySessionId: () =>
    getDb().prepare<EventRow, [string, number]>(
      "SELECT * FROM events WHERE sessionId = ? ORDER BY createdAt DESC LIMIT ?",
    ),

  getAll: () =>
    getDb().prepare<EventRow, [number]>("SELECT * FROM events ORDER BY createdAt DESC LIMIT ?"),

  countByEvent: () =>
    getDb().prepare<{ event: string; count: number }, []>(
      "SELECT event, COUNT(*) as count FROM events GROUP BY event ORDER BY count DESC",
    ),

  countByEventForAgent: () =>
    getDb().prepare<{ event: string; count: number }, [string]>(
      "SELECT event, COUNT(*) as count FROM events WHERE agentId = ? GROUP BY event ORDER BY count DESC",
    ),
};

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

export function createEvent(input: CreateEventInput): SwarmEvent {
  const id = crypto.randomUUID();
  eventQueries
    .insert()
    .run(
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
    );
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

export function createEventsBatch(inputs: CreateEventInput[]): number {
  const insert = eventQueries.insert();
  const tx = getDb().transaction(() => {
    for (const input of inputs) {
      const id = crypto.randomUUID();
      insert.run(
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
      );
    }
  });
  tx();
  return inputs.length;
}

// ─── Query ──────────────────────────────────────────────────────────────────

export function getEventsByCategory(category: EventCategory, limit = 100): SwarmEvent[] {
  return eventQueries.getByCategory().all(category, limit).map(rowToSwarmEvent);
}

export function getEventsByEvent(event: EventName, limit = 100): SwarmEvent[] {
  return eventQueries.getByEvent().all(event, limit).map(rowToSwarmEvent);
}

export function getEventsByAgentId(agentId: string, limit = 100): SwarmEvent[] {
  return eventQueries.getByAgentId().all(agentId, limit).map(rowToSwarmEvent);
}

export function getEventsByTaskId(taskId: string, limit = 100): SwarmEvent[] {
  return eventQueries.getByTaskId().all(taskId, limit).map(rowToSwarmEvent);
}

export function getEventsBySessionId(sessionId: string, limit = 100): SwarmEvent[] {
  return eventQueries.getBySessionId().all(sessionId, limit).map(rowToSwarmEvent);
}

export function getAllEvents(limit = 100): SwarmEvent[] {
  return eventQueries.getAll().all(limit).map(rowToSwarmEvent);
}

export function getEventCounts(): Array<{ event: string; count: number }> {
  return eventQueries.countByEvent().all();
}

export function getEventCountsForAgent(agentId: string): Array<{ event: string; count: number }> {
  return eventQueries.countByEventForAgent().all(agentId);
}

export function getEventCountsFiltered(filters: {
  category?: EventCategory;
  source?: EventSource;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  since?: string;
  until?: string;
}): Array<{ event: string; count: number }> {
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
  return getDb()
    .prepare<{ event: string; count: number }, (string | number)[]>(sql)
    .all(...params);
}

export function getEventsFiltered(filters: {
  category?: EventCategory;
  event?: EventName;
  status?: EventStatus;
  source?: EventSource;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  since?: string;
  until?: string;
  limit?: number;
}): SwarmEvent[] {
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
  return getDb()
    .prepare<EventRow, (string | number)[]>(sql)
    .all(...params)
    .map(rowToSwarmEvent);
}
