import { type AutomationPreflightRowText, BaseSchedulesRepository } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresSchedulesRepository extends BaseSchedulesRepository {
  listEnabledPreflightRows(): Promise<AutomationPreflightRowText[]> {
    return notOnPostgresYet("PostgresSchedulesRepository.listEnabledPreflightRows");
  }
}
