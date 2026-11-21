import { nowIso } from "../dialect";
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
}

export abstract class BaseEventsRepository implements EventsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  async insert(row: NewEvent): Promise<void> {
    await this.db.run(sql`
      INSERT INTO events (id, category, event, status, source, "agentId", "taskId",
        "sessionId", "parentEventId", "numericValue", "durationMs", data, "createdAt")
      VALUES (${row.id}, ${row.category}, ${row.event}, ${row.status}, ${row.source}, ${row.agentId},
        ${row.taskId}, ${row.sessionId}, ${row.parentEventId}, ${row.numericValue}, ${row.durationMs},
        ${row.data}, ${nowIso})`);
  }

  abstract list(
    limit: number,
    filter?: { column: EventColumn; value: string },
  ): Promise<EventRow[]>;

  abstract countByEvent(filters: EventCountFilters): Promise<EventCount[]>;

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
