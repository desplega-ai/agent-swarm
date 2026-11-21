import { BasePromptTemplatesRepository, type SqlQuery } from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresPromptTemplatesRepository extends BasePromptTemplatesRepository {
  protected insertionOrder(): SqlQuery {
    return notOnPostgresYet("PostgresPromptTemplatesRepository.insertionOrder");
  }
}
