import {
  type AutomationPreflightRowText,
  BaseSchedulesRepository,
  SqlQuery,
  sql,
} from "@desplega/storage";

export class PostgresSchedulesRepository extends BaseSchedulesRepository {
  listEnabledPreflightRows(): Promise<AutomationPreflightRowText[]> {
    return this.db.query<AutomationPreflightRowText>(sql`
      SELECT id, name, 'schedule' AS kind, params, "requiredParams", requires
        FROM scheduled_tasks WHERE enabled = ${true} ORDER BY "_rowid"`);
  }

  protected insertionOrder(): SqlQuery {
    return new SqlQuery(['"_rowid"'], []);
  }
}
