import { jsonText, nowIso } from "../dialect";
import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql, sqlWhere } from "../sql";

/**
 * Domain: swarm events (`events`). Rows come back in the SQLite value shape on
 * every engine (JSON as text, timestamps as the text the column stores).
 */

export type EventRow = {
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

/** A new event. `createdAt` is the current time of the database. */
export type NewEvent = Omit<EventRow, "createdAt">;

/** The single-column filter of `listByColumn`. */
export type EventColumn = "category" | "event" | "agentId" | "taskId" | "sessionId";

export type EventCountFilters = {
  category?: string;
  source?: string;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  since?: string;
  until?: string;
};

export type EventCount = { event: string; count: number };

/** Filters of `listFiltered`; every given filter must match. */
export type EventListFilters = {
  /** Only events outside sessions this user may not read; `userId: null` is a guest. */
  readableBy?: { userId: string | null };
  category?: string;
  event?: string;
  /** Any of these names (`event IN (...)`). Ignored when empty. */
  events?: string[];
  status?: string;
  source?: string;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  /** `data.field` equals this value. */
  dataField?: string;
  since?: string;
  until?: string;
  limit: number;
  /**
   * Only the newest row per (event, data.field) pair over these names and
   * values: one indexed `ORDER BY createdAt DESC LIMIT 1` lookup per pair.
   */
  latestPerDataField?: { events: string[]; dataFields: string[] };
};

export interface EventsRepository {
  insert(row: NewEvent): Promise<void>;
  /**
   * Newest events first, at most `limit`, optionally where `column = value`.
   * Order: `createdAt` descending, then the order SQLite returned before the
   * move (insertion order for a column filter, newest insertion first without).
   */
  list(limit: number, filter?: { column: EventColumn; value: string }): Promise<EventRow[]>;
  /** Event counts per name. Order: count descending, then event name. */
  countByEvent(filters: EventCountFilters): Promise<EventCount[]>;
  /**
   * Events matching the filters, newest first, at most `limit`. Order:
   * `createdAt` descending; ties come in the order the engine reads them
   * (unchanged from before the move).
   */
  listFiltered(filters: EventListFilters): Promise<EventRow[]>;
}

export abstract class BaseEventsRepository implements EventsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  async insert(row: NewEvent): Promise<void> {
    await this.db.run(sql`
      INSERT INTO events (id, category, event, status, source, "agentId", "taskId",
        "sessionId", "parentEventId", "numericValue", "durationMs", data, "createdAt")
      VALUES (${row.id}, ${row.category}, ${row.event}, ${row.status}, ${row.source}, ${row.agentId},
        ${row.taskId}, ${row.sessionId}, ${row.parentEventId}, ${row.numericValue}, ${row.durationMs},
        ${jsonText(row.data)}, ${nowIso})`);
  }

  abstract list(
    limit: number,
    filter?: { column: EventColumn; value: string },
  ): Promise<EventRow[]>;

  abstract countByEvent(filters: EventCountFilters): Promise<EventCount[]>;

  /** `data.field` reads `json_extract` (SQLite). */
  abstract listFiltered(filters: EventListFilters): Promise<EventRow[]>;

  protected countFilters(filters: EventCountFilters): SqlQuery {
    const conditions: SqlQuery[] = [];
    if (filters.category) conditions.push(sql`category = ${filters.category}`);
    if (filters.source) conditions.push(sql`source = ${filters.source}`);
    if (filters.agentId) conditions.push(sql`"agentId" = ${filters.agentId}`);
    if (filters.taskId) conditions.push(sql`"taskId" = ${filters.taskId}`);
    if (filters.sessionId) conditions.push(sql`"sessionId" = ${filters.sessionId}`);
    if (filters.since) conditions.push(sql`"createdAt" >= ${filters.since}`);
    if (filters.until) conditions.push(sql`"createdAt" <= ${filters.until}`);
    return sqlWhere(conditions);
  }
}
