import {
  BaseEventsRepository,
  type EventColumn,
  type EventCount,
  type EventCountFilters,
  type EventRow,
  sql,
  sqlIdent,
} from "@desplega/storage";

export class PostgresEventsRepository extends BaseEventsRepository {
  list(limit: number, filter?: { column: EventColumn; value: string }): Promise<EventRow[]> {
    // The SQLite override's ties, with "_rowid" for rowid: a column filter
    // keeps insertion order, no filter puts the newest insertion first.
    if (filter) {
      return this.db.query<EventRow>(sql`
        SELECT * FROM events WHERE ${sqlIdent(filter.column)} = ${filter.value}
        ORDER BY "createdAt" DESC, "_rowid" ASC LIMIT ${limit}`);
    }
    return this.db.query<EventRow>(
      sql`SELECT * FROM events ORDER BY "createdAt" DESC, "_rowid" DESC LIMIT ${limit}`,
    );
  }

  countByEvent(filters: EventCountFilters): Promise<EventCount[]> {
    // Equal counts in byte order of the name (the database collation is C).
    return this.db.query<EventCount>(sql`
      SELECT event, COUNT(*) AS count FROM events${this.countFilters(filters)}
      GROUP BY event ORDER BY count DESC, event ASC`);
  }
}
