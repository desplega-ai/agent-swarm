import { BasePromptTemplatesRepository, SqlQuery } from "@desplega/storage";

export class SqlitePromptTemplatesRepository extends BasePromptTemplatesRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(["rowid"], []);
  }
}
