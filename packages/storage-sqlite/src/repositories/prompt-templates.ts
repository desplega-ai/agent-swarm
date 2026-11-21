import type { Database } from "bun:sqlite";
import {
  BasePromptTemplatesRepository,
  type PromptTemplateFilters,
  type PromptTemplateHistoryRow,
  type PromptTemplateRecordUpdate,
  type PromptTemplateRow,
  promptTemplateStatements,
  SqlQuery,
  sql,
} from "@desplega/storage";
import { sqliteDialect } from "../dialect";

// Ties keep the order the SQLite plan gives (rowid through the eventType
// index, scopeId through the UNIQUE index), unchanged from before the move.
const listQuery = (filters: PromptTemplateFilters): SqlQuery =>
  sql`SELECT * FROM prompt_templates${promptTemplateStatements.listWhere(filters)} ORDER BY "eventType" ASC`;

export class SqlitePromptTemplatesRepository extends BasePromptTemplatesRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(["rowid"], []);
  }

  listPromptTemplates(filters: PromptTemplateFilters): Promise<PromptTemplateRow[]> {
    return this.db.query<PromptTemplateRow>(listQuery(filters));
  }
}

// ---- The default-template seed on the synchronous SQLite start path ----

function render(query: SqlQuery): { text: string; params: never[] } {
  const { text, params } = query.render(sqliteDialect);
  return { text, params: params as never[] };
}

export function listPromptTemplatesSync(
  database: Database,
  filters: PromptTemplateFilters,
): PromptTemplateRow[] {
  const { text, params } = render(listQuery(filters));
  return database.prepare<PromptTemplateRow, never[]>(text).all(...params);
}

export function insertPromptTemplateSync(
  database: Database,
  row: PromptTemplateRow,
): PromptTemplateRow | null {
  const { text, params } = render(promptTemplateStatements.insert(row));
  return database.prepare<PromptTemplateRow, never[]>(text).get(...params);
}

export function updatePromptTemplateRecordSync(
  database: Database,
  id: string,
  c: PromptTemplateRecordUpdate,
): PromptTemplateRow | null {
  const { text, params } = render(promptTemplateStatements.updateRecord(id, c));
  return database.prepare<PromptTemplateRow, never[]>(text).get(...params);
}

export function insertPromptTemplateHistorySync(
  database: Database,
  row: PromptTemplateHistoryRow,
): void {
  const { text, params } = render(promptTemplateStatements.insertHistory(row));
  database.prepare(text).run(...params);
}
