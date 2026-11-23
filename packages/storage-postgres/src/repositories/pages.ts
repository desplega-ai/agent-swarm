import { BasePagesRepository, SqlQuery } from "@desplega/storage";

export class PostgresPagesRepository extends BasePagesRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(['"_rowid"'], []);
  }
}
