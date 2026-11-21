import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql } from "../sql";

/**
 * Domain: prompt templates (`prompt_templates`, `prompt_template_history`).
 * Rows come back in the SQLite value shape on every engine (flags 0/1,
 * timestamps as stored text).
 */

/** One `prompt_templates` row. */
export type PromptTemplateRow = {
  id: string;
  eventType: string;
  scope: string;
  scopeId: string | null;
  state: string;
  body: string;
  isDefault: number;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One `prompt_template_history` row. */
export type PromptTemplateHistoryRow = {
  id: string;
  templateId: string;
  version: number;
  body: string;
  state: string;
  changedBy: string | null;
  changedAt: string;
  changeReason: string | null;
};

export interface PromptTemplatesRepository {
  findPromptTemplate(id: string): Promise<PromptTemplateRow | null>;
  deletePromptTemplate(id: string): Promise<number>;
  /** One template's history, newest version first, then insertion order (newest first). */
  listPromptTemplateHistory(templateId: string): Promise<PromptTemplateHistoryRow[]>;
  /** The history entry of one version (the first written when two share it). */
  findPromptTemplateHistoryVersion(
    templateId: string,
    version: number,
  ): Promise<PromptTemplateHistoryRow | null>;
  /** Sets the body, state and version of a template. */
  setPromptTemplateContent(
    id: string,
    c: { body: string; state: string; version: number; updatedAt: string },
  ): Promise<PromptTemplateRow | null>;
  insertPromptTemplateHistory(row: PromptTemplateHistoryRow): Promise<void>;
}

export abstract class BasePromptTemplatesRepository implements PromptTemplatesRepository {
  constructor(protected readonly db: SqlExecutor) {}

  /** The insertion-order column (SQLite `rowid`), for ORDER BY tiebreaks only. */
  protected abstract insertionOrder(): SqlQuery;

  findPromptTemplate(id: string): Promise<PromptTemplateRow | null> {
    return this.db.get<PromptTemplateRow>(sql`SELECT * FROM prompt_templates WHERE id = ${id}`);
  }

  async deletePromptTemplate(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM prompt_templates WHERE id = ${id}`)).changes;
  }

  listPromptTemplateHistory(templateId: string): Promise<PromptTemplateHistoryRow[]> {
    return this.db.query<PromptTemplateHistoryRow>(sql`
      SELECT * FROM prompt_template_history WHERE "templateId" = ${templateId}
      ORDER BY version DESC, ${this.insertionOrder()} DESC`);
  }

  findPromptTemplateHistoryVersion(
    templateId: string,
    version: number,
  ): Promise<PromptTemplateHistoryRow | null> {
    return this.db.get<PromptTemplateHistoryRow>(sql`
      SELECT * FROM prompt_template_history WHERE "templateId" = ${templateId} AND version = ${version}
      ORDER BY ${this.insertionOrder()} LIMIT 1`);
  }

  setPromptTemplateContent(
    id: string,
    c: { body: string; state: string; version: number; updatedAt: string },
  ): Promise<PromptTemplateRow | null> {
    return this.db.get<PromptTemplateRow>(sql`
      UPDATE prompt_templates SET body = ${c.body}, state = ${c.state}, version = ${c.version},
        "updatedAt" = ${c.updatedAt}
      WHERE id = ${id} RETURNING *`);
  }

  async insertPromptTemplateHistory(r: PromptTemplateHistoryRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO prompt_template_history (id, "templateId", version, body, state, "changedBy",
        "changedAt", "changeReason")
      VALUES (${r.id}, ${r.templateId}, ${r.version}, ${r.body}, ${r.state}, ${r.changedBy},
        ${r.changedAt}, ${r.changeReason})`);
  }
}
