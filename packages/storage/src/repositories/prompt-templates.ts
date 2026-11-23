import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql, sqlWhere } from "../sql";

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

/** Filters of a template list; each one given narrows the list. */
export type PromptTemplateFilters = {
  eventType?: string;
  scope?: string;
  scopeId?: string;
  isDefault?: boolean;
};

/** The columns a full template update writes. */
export type PromptTemplateRecordUpdate = {
  body: string;
  state: string;
  isDefault: boolean;
  version: number;
  updatedAt: string;
};

/**
 * Statement texts shared by the async repository and the synchronous SQLite
 * start path (the default-template seed runs inside initDb).
 */
export const promptTemplateStatements = {
  /** WHERE of a template list (no ORDER BY: each engine orders). */
  listWhere(f: PromptTemplateFilters): SqlQuery {
    const conditions: SqlQuery[] = [];
    if (f.eventType) conditions.push(sql`"eventType" = ${f.eventType}`);
    if (f.scope) conditions.push(sql`scope = ${f.scope}`);
    if (f.scopeId) conditions.push(sql`"scopeId" = ${f.scopeId}`);
    if (f.isDefault !== undefined) conditions.push(sql`"isDefault" = ${f.isDefault}`);
    return sqlWhere(conditions);
  },
  insert(r: PromptTemplateRow): SqlQuery {
    return sql`
      INSERT INTO prompt_templates (id, "eventType", scope, "scopeId", state, body, "isDefault",
        version, "createdBy", "createdAt", "updatedAt")
      VALUES (${r.id}, ${r.eventType}, ${r.scope}, ${r.scopeId}, ${r.state}, ${r.body},
        ${r.isDefault === 1}, ${r.version}, ${r.createdBy}, ${r.createdAt}, ${r.updatedAt})
      RETURNING *`;
  },
  updateRecord(id: string, c: PromptTemplateRecordUpdate): SqlQuery {
    return sql`
      UPDATE prompt_templates SET body = ${c.body}, state = ${c.state}, "isDefault" = ${c.isDefault},
        version = ${c.version}, "updatedAt" = ${c.updatedAt}
      WHERE id = ${id} RETURNING *`;
  },
  insertHistory(r: PromptTemplateHistoryRow): SqlQuery {
    return sql`
      INSERT INTO prompt_template_history (id, "templateId", version, body, state, "changedBy",
        "changedAt", "changeReason")
      VALUES (${r.id}, ${r.templateId}, ${r.version}, ${r.body}, ${r.state}, ${r.changedBy},
        ${r.changedAt}, ${r.changeReason})`;
  },
};

export interface PromptTemplatesRepository {
  /**
   * Templates matching the filters, by event type ascending. Ties (one event
   * type at several scopes) come in the SQLite query-plan order, which the
   * SQLite engine keeps unchanged from before the move (not a total order).
   */
  listPromptTemplates(filters: PromptTemplateFilters): Promise<PromptTemplateRow[]>;
  /** The template of one event type at one scope (`scopeId` null: the scope-wide row). */
  findPromptTemplateAtScope(
    eventType: string,
    scope: string,
    scopeId: string | null,
  ): Promise<PromptTemplateRow | null>;
  /** Inserts a template; returns the stored row. */
  insertPromptTemplate(row: PromptTemplateRow): Promise<PromptTemplateRow | null>;
  /** Sets body, state, default flag, version and update time of a template. */
  updatePromptTemplateRecord(
    id: string,
    c: PromptTemplateRecordUpdate,
  ): Promise<PromptTemplateRow | null>;
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

  abstract listPromptTemplates(filters: PromptTemplateFilters): Promise<PromptTemplateRow[]>;

  findPromptTemplateAtScope(
    eventType: string,
    scope: string,
    scopeId: string | null,
  ): Promise<PromptTemplateRow | null> {
    const scopeIdMatch = scopeId === null ? sql`"scopeId" IS NULL` : sql`"scopeId" = ${scopeId}`;
    return this.db.get<PromptTemplateRow>(sql`
      SELECT * FROM prompt_templates
      WHERE "eventType" = ${eventType} AND scope = ${scope} AND ${scopeIdMatch}`);
  }

  insertPromptTemplate(row: PromptTemplateRow): Promise<PromptTemplateRow | null> {
    return this.db.get<PromptTemplateRow>(promptTemplateStatements.insert(row));
  }

  updatePromptTemplateRecord(
    id: string,
    c: PromptTemplateRecordUpdate,
  ): Promise<PromptTemplateRow | null> {
    return this.db.get<PromptTemplateRow>(promptTemplateStatements.updateRecord(id, c));
  }

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
    await this.db.run(promptTemplateStatements.insertHistory(r));
  }
}
