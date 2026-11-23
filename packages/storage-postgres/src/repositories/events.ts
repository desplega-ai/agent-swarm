import {
  BaseEventsRepository,
  type EventColumn,
  type EventCount,
  type EventCountFilters,
  type EventListFilters,
  type EventRow,
  readableSessionSql,
  type SqlQuery,
  sql,
  sqlColumnRef,
  sqlIdent,
  sqlJoin,
  sqlList,
  sqlWhere,
} from "@desplega/storage";

/** SQLite's `json_extract(data, '$.field') = ?`: only a JSON string equal to the text. */
function dataFieldIs(value: string): SqlQuery {
  return sql`data -> 'field' = to_jsonb(CAST(${value} AS text))`;
}

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

  async listFiltered(f: EventListFilters): Promise<EventRow[]> {
    const conditions: SqlQuery[] = [];
    if (f.readableBy) {
      conditions.push(
        readableSessionSql(f.readableBy.userId, sqlColumnRef('events."taskId"'), {
          nullable: true,
        }),
      );
    }
    if (f.category) conditions.push(sql`category = ${f.category}`);
    if (f.event) conditions.push(sql`event = ${f.event}`);
    if (f.events && f.events.length > 0) conditions.push(sql`event IN (${sqlList(f.events)})`);
    if (f.status) conditions.push(sql`status = ${f.status}`);
    if (f.source) conditions.push(sql`source = ${f.source}`);
    if (f.agentId) conditions.push(sql`"agentId" = ${f.agentId}`);
    if (f.taskId) conditions.push(sql`"taskId" = ${f.taskId}`);
    if (f.sessionId) conditions.push(sql`"sessionId" = ${f.sessionId}`);
    if (f.dataField) conditions.push(dataFieldIs(f.dataField));
    if (f.since) conditions.push(sql`"createdAt" >= ${f.since}`);
    if (f.until) conditions.push(sql`"createdAt" <= ${f.until}`);

    // Ties: SQLite walks idx_events_createdAt backwards, newest insertion first.
    if (f.latestPerDataField) {
      const lookups: SqlQuery[] = [];
      for (const event of f.latestPerDataField.events) {
        for (const field of f.latestPerDataField.dataFields) {
          const where = sqlWhere([...conditions, sql`event = ${event}`, dataFieldIs(field)]);
          lookups.push(
            sql`SELECT * FROM (SELECT * FROM events${where} ORDER BY "createdAt" DESC, "_rowid" DESC LIMIT 1) latest`,
          );
        }
      }
      if (lookups.length === 0) return [];
      return this.db.query<EventRow>(
        sql`${sqlJoin(lookups, sql` UNION ALL `)} ORDER BY "createdAt" DESC, "_rowid" DESC LIMIT ${f.limit}`,
      );
    }
    return this.db.query<EventRow>(
      sql`SELECT * FROM events${sqlWhere(conditions)} ORDER BY "createdAt" DESC, "_rowid" DESC LIMIT ${f.limit}`,
    );
  }
}
