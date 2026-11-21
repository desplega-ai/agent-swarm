import type { SqlQuery } from "@desplega/storage";
import { type AutomationPreflightRowText, BaseSchedulesRepository, sql } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresSchedulesRepository extends BaseSchedulesRepository {
  listEnabledPreflightRows(): Promise<AutomationPreflightRowText[]> {
    return this.db.query<AutomationPreflightRowText>(sql`
      SELECT id, name, 'schedule' AS kind, params, "requiredParams", requires
        FROM scheduled_tasks WHERE enabled = ${true} ORDER BY "_rowid"`);
  }

  protected insertionOrder(): SqlQuery {
    return notOnPostgresYet("PostgresSchedulesRepository.insertionOrder");
  }
}
