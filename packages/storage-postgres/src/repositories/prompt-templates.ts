import {
  BasePromptTemplatesRepository,
  type PromptTemplateFilters,
  type PromptTemplateRow,
  SqlQuery,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

export class PostgresPromptTemplatesRepository extends BasePromptTemplatesRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(['"_rowid"'], []);
  }

  listPromptTemplates(_filters: PromptTemplateFilters): Promise<PromptTemplateRow[]> {
    return notOnPostgresYet("PostgresPromptTemplatesRepository.listPromptTemplates");
  }
}
