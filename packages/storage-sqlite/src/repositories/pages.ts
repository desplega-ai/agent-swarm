import { BasePagesRepository, SqlQuery } from "@desplega/storage";

export class SqlitePagesRepository extends BasePagesRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(["rowid"], []);
  }
}
