import type { EventCategory, EventName, EventSource, EventStatus, SwarmEvent } from "../types";
import { type ScrubbedText, scrubObject, scrubSecrets } from "../utils/secret-scrubber";
import { breaksJsonValidity } from "./scrub-json";
import { recordSkillInvocation } from "./skill-invocations";
import { getStorage } from "./storage";

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

async function insertEvent(id: string, input: CreateEventInput): Promise<void> {
  await getStorage().repos.events.insert({
    id,
    category: input.category,
    event: input.event,
    status: input.status ?? "ok",
    source: input.source,
    agentId: input.agentId ?? null,
    taskId: input.taskId ?? null,
    sessionId: input.sessionId ?? null,
    parentEventId: input.parentEventId ?? null,
    numericValue: input.numericValue ?? null,
    durationMs: input.durationMs ?? null,
    data: input.data ? serializeEventData(input.data) : null,
  });
  // `skill.invoke` also feeds the per-skill counter and invocation history
  // (skills repository; inside a transaction it joins it).
  await recordSkillInvocation(input, id);
}

export async function createEvent(input: CreateEventInput): Promise<SwarmEvent> {
  const id = crypto.randomUUID();
  if (input.event === "skill.invoke") {
    await getStorage().transaction(() => insertEvent(id, input));
  } else {
    await insertEvent(id, input);
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
  await getStorage().transaction(async () => {
    for (const input of inputs) {
      await insertEvent(crypto.randomUUID(), input);
    }
  });
  return inputs.length;
}

// ─── Query ──────────────────────────────────────────────────────────────────

export async function getEventsByCategory(
  category: EventCategory,
  limit = 100,
): Promise<SwarmEvent[]> {
  const rows = await getStorage().repos.events.list(limit, { column: "category", value: category });
  return rows.map(rowToSwarmEvent);
}

export async function getEventsByEvent(event: EventName, limit = 100): Promise<SwarmEvent[]> {
  const rows = await getStorage().repos.events.list(limit, { column: "event", value: event });
  return rows.map(rowToSwarmEvent);
}

export async function getEventsByAgentId(agentId: string, limit = 100): Promise<SwarmEvent[]> {
  const rows = await getStorage().repos.events.list(limit, { column: "agentId", value: agentId });
  return rows.map(rowToSwarmEvent);
}

export async function getEventsByTaskId(taskId: string, limit = 100): Promise<SwarmEvent[]> {
  const rows = await getStorage().repos.events.list(limit, { column: "taskId", value: taskId });
  return rows.map(rowToSwarmEvent);
}

export async function getEventsBySessionId(sessionId: string, limit = 100): Promise<SwarmEvent[]> {
  const rows = await getStorage().repos.events.list(limit, {
    column: "sessionId",
    value: sessionId,
  });
  return rows.map(rowToSwarmEvent);
}

export async function getAllEvents(limit = 100): Promise<SwarmEvent[]> {
  const rows = await getStorage().repos.events.list(limit);
  return rows.map(rowToSwarmEvent);
}

export async function getEventCounts(): Promise<Array<{ event: string; count: number }>> {
  return await getStorage().repos.events.countByEvent({});
}

export async function getEventCountsForAgent(
  agentId: string,
): Promise<Array<{ event: string; count: number }>> {
  return await getStorage().repos.events.countByEvent({ agentId });
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
  return await getStorage().repos.events.countByEvent(filters);
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
  /** Only events outside sessions this user may not read; `userId: null` is a guest. */
  readableBy?: { userId: string | null };
}): Promise<SwarmEvent[]> {
  const rows = await getStorage().repos.events.listFiltered({
    ...filters,
    limit: filters.limit ?? 100,
  });
  return rows.map(rowToSwarmEvent);
}
