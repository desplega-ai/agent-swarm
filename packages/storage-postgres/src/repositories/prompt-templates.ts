import { BasePromptTemplatesRepository, SqlQuery } from "@desplega/storage";

export class PostgresPromptTemplatesRepository extends BasePromptTemplatesRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(['"_rowid"'], []);
  }
}
