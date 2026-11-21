/**
 * Prompt-template helpers shared by the async facade functions in
 * src/be/db.ts and the synchronous default-template seed, which runs on the
 * SQLite start path inside initDb (src/be/seed-prompt-templates.ts).
 */
import type {
  PromptTemplateFilters,
  PromptTemplateHistoryRow,
  PromptTemplateRecordUpdate,
  PromptTemplateRow,
} from "@desplega/storage";
import type { PromptTemplate } from "../../types";
import { promptTemplateSqliteStart } from "../storage-root";

export function rowToPromptTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    eventType: row.eventType,
    scope: row.scope as "global" | "agent" | "repo",
    scopeId: row.scopeId ?? null,
    state: row.state as "enabled" | "default_prompt_fallback" | "skip_event",
    body: row.body,
    isDefault: row.isDefault === 1,
    version: row.version,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type PromptTemplateUpsert = {
  eventType: string;
  scope: "global" | "agent" | "repo";
  scopeId?: string | null;
  state?: "enabled" | "default_prompt_fallback" | "skip_event";
  body: string;
  createdBy?: string | null;
  changedBy?: string | null;
  changeReason?: string | null;
  isDefault?: boolean;
};

/** The template row and its first history entry of a new template. */
export function newPromptTemplateRows(
  data: PromptTemplateUpsert,
  scopeId: string | null,
  now: string,
): { row: PromptTemplateRow; history: PromptTemplateHistoryRow } {
  const state = data.state ?? "enabled";
  const id = crypto.randomUUID();
  return {
    row: {
      id,
      eventType: data.eventType,
      scope: data.scope,
      scopeId,
      state,
      body: data.body,
      isDefault: data.isDefault ? 1 : 0,
      version: 1,
      createdBy: data.createdBy ?? data.changedBy ?? null,
      createdAt: now,
      updatedAt: now,
    },
    history: {
      id: crypto.randomUUID(),
      templateId: id,
      version: 1,
      body: data.body,
      state,
      changedBy: data.changedBy ?? data.createdBy ?? null,
      changedAt: now,
      changeReason: data.changeReason ?? "Initial creation",
    },
  };
}

/** The update and history entry that reset a template to its code default. */
export function resetPromptTemplateRows(
  id: string,
  existingVersion: number,
  defaultBody: string,
  now: string,
): { update: PromptTemplateRecordUpdate; history: PromptTemplateHistoryRow } {
  const newVersion = existingVersion + 1;
  return {
    update: {
      body: defaultBody,
      state: "enabled",
      isDefault: true,
      version: newVersion,
      updatedAt: now,
    },
    history: {
      id: crypto.randomUUID(),
      templateId: id,
      version: newVersion,
      body: defaultBody,
      state: "enabled",
      changedBy: null,
      changedAt: now,
      changeReason: "Reset to default",
    },
  };
}

/**
 * `getPromptTemplates` on the synchronous SQLite start path: the default
 * template seed (src/be/seed-prompt-templates.ts) runs inside `initDb`.
 */
export function getPromptTemplatesOnSqliteStart(filters?: PromptTemplateFilters): PromptTemplate[] {
  return promptTemplateSqliteStart.list(filters ?? {}).map(rowToPromptTemplate);
}

/**
 * Insert a new template on the synchronous SQLite start path (the default
 * template seed, which calls it only when no global record exists).
 */
export function insertPromptTemplateOnSqliteStart(data: PromptTemplateUpsert): PromptTemplate {
  const now = new Date().toISOString();
  const scopeId = data.scope === "global" ? null : (data.scopeId ?? null);
  const created = newPromptTemplateRows(data, scopeId, now);
  const row = promptTemplateSqliteStart.insert(created.row);
  promptTemplateSqliteStart.insertHistory(created.history);
  if (!row) throw new Error("Failed to upsert prompt template");
  return rowToPromptTemplate(row);
}

/**
 * `resetPromptTemplateToDefault` on the synchronous SQLite start path (the
 * default template seed). `existing` is the record the seed just read.
 */
export function resetPromptTemplateToDefaultOnSqliteStart(
  existing: PromptTemplate,
  defaultBody: string,
): PromptTemplate {
  const now = new Date().toISOString();
  const reset = resetPromptTemplateRows(existing.id, existing.version, defaultBody, now);
  const row = promptTemplateSqliteStart.updateRecord(existing.id, reset.update);
  if (!row) throw new Error("Failed to reset prompt template to default");
  promptTemplateSqliteStart.insertHistory(reset.history);
  return rowToPromptTemplate(row);
}
