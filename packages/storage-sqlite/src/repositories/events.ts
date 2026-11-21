import {
  BaseEventsRepository,
  type EventColumn,
  type EventCount,
  type EventCountFilters,
  type EventRow,
  sql,
  sqlIdent,
} from "@desplega/storage";

export class SqliteEventsRepository extends BaseEventsRepository {
  list(limit: number, filter?: { column: EventColumn; value: string }): Promise<EventRow[]> {
    // Ties keep the order SQLite returned before the move: a column filter
    // sorts its index-by-rowid search (insertion order); no filter walks
    // idx_events_createdAt backwards (newest insertion first).
    if (filter) {
      return this.db.query<EventRow>(sql`
        SELECT * FROM events WHERE ${sqlIdent(filter.column)} = ${filter.value}
        ORDER BY "createdAt" DESC, rowid ASC LIMIT ${limit}`);
    }
    return this.db.query<EventRow>(
      sql`SELECT * FROM events ORDER BY "createdAt" DESC, rowid DESC LIMIT ${limit}`,
    );
  }

  countByEvent(filters: EventCountFilters): Promise<EventCount[]> {
    // GROUP BY hands the groups over in byte order of the name, so equal counts
    // kept that order before the move.
    return this.db.query<EventCount>(sql`
      SELECT event, COUNT(*) AS count FROM events${this.countFilters(filters)}
      GROUP BY event ORDER BY count DESC, event ASC`);
  }
}
