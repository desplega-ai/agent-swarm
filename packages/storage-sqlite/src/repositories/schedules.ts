import {
  type AutomationPreflightRowText,
  BaseSchedulesRepository,
  SqlQuery,
  sql,
} from "@desplega/storage";

export class SqliteSchedulesRepository extends BaseSchedulesRepository {
  listEnabledPreflightRows(): Promise<AutomationPreflightRowText[]> {
    return this.db.query<AutomationPreflightRowText>(sql`
      SELECT id, name, 'schedule' AS kind, params, "requiredParams", requires
        FROM scheduled_tasks WHERE enabled = ${true} ORDER BY rowid`);
  }

  protected insertionOrder(): SqlQuery {
    return new SqlQuery(["rowid"], []);
  }
}
