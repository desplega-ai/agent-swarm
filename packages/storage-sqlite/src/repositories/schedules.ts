import { BaseSchedulesRepository, SqlQuery } from "@desplega/storage";

export class SqliteSchedulesRepository extends BaseSchedulesRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(["rowid"], []);
  }
}
