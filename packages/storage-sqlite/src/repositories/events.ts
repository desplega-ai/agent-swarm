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

  async listFiltered(f: EventListFilters): Promise<EventRow[]> {
    const conditions: SqlQuery[] = [];
    if (f.readableBy) {
      conditions.push(
        readableSessionSql(f.readableBy.userId, sqlColumnRef("events.taskId"), { nullable: true }),
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
    if (f.dataField) conditions.push(sql`json_extract(data, '$.field') = ${f.dataField}`);
    if (f.since) conditions.push(sql`"createdAt" >= ${f.since}`);
    if (f.until) conditions.push(sql`"createdAt" <= ${f.until}`);

    if (f.latestPerDataField) {
      const lookups: SqlQuery[] = [];
      for (const event of f.latestPerDataField.events) {
        for (const field of f.latestPerDataField.dataFields) {
          const where = sqlWhere([
            ...conditions,
            sql`event = ${event}`,
            sql`json_extract(data, '$.field') = ${field}`,
          ]);
          lookups.push(
            sql`SELECT * FROM (SELECT * FROM events${where} ORDER BY "createdAt" DESC LIMIT 1)`,
          );
        }
      }
      if (lookups.length === 0) return [];
      return this.db.query<EventRow>(
        sql`${sqlJoin(lookups, sql` UNION ALL `)} ORDER BY "createdAt" DESC LIMIT ${f.limit}`,
      );
    }
    return this.db.query<EventRow>(
      sql`SELECT * FROM events${sqlWhere(conditions)} ORDER BY "createdAt" DESC LIMIT ${f.limit}`,
    );
  }
}
