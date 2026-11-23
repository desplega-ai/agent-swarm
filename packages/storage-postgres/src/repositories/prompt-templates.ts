import {
  BasePromptTemplatesRepository,
  type PromptTemplateFilters,
  type PromptTemplateRow,
  promptTemplateStatements,
  SqlQuery,
  sql,
} from "@desplega/storage";

export class PostgresPromptTemplatesRepository extends BasePromptTemplatesRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(['"_rowid"'], []);
  }

  listPromptTemplates(filters: PromptTemplateFilters): Promise<PromptTemplateRow[]> {
    // The SQLite plan breaks event type ties in the order of the index it
    // reads. A scope filter, or a scopeId filter without an event type, reads
    // the (scope, scopeId) or (eventType, scope, scopeId) index: ties by
    // scope, then scopeId (NULL first), then insertion order. Every other
    // filter set reads the eventType index: ties in insertion order.
    const byScope = Boolean(filters.scope) || (Boolean(filters.scopeId) && !filters.eventType);
    const ties = byScope ? sql`scope, "scopeId" NULLS FIRST, "_rowid"` : sql`"_rowid"`;
    return this.db.query<PromptTemplateRow>(sql`
      SELECT * FROM prompt_templates${promptTemplateStatements.listWhere(filters)}
      ORDER BY "eventType" ASC, ${ties}`);
  }
}
