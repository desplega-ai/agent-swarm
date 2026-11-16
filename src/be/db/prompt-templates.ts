import type { PromptTemplate } from "../../types";
import { getDbClient } from "./runtime";

export type PromptTemplateFilters = {
  eventType?: string;
  scope?: string;
  scopeId?: string;
  isDefault?: boolean;
};

export function promptTemplateListQuery(filters?: PromptTemplateFilters) {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.eventType) {
    conditions.push("eventType = ?");
    params.push(filters.eventType);
  }
  if (filters?.scope) {
    conditions.push("scope = ?");
    params.push(filters.scope);
  }
  if (filters?.scopeId) {
    conditions.push("scopeId = ?");
    params.push(filters.scopeId);
  }
  if (filters?.isDefault !== undefined) {
    conditions.push("isDefault = ?");
    params.push(filters.isDefault ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT * FROM prompt_templates ${whereClause} ORDER BY eventType ASC`;

  return { query, params };
}

export type PromptTemplateRow = {
  id: string;
  eventType: string;
  scope: string;
  scopeId: string | null;
  state: string;
  body: string;
  isDefault: number; // SQLite boolean
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

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

/** Keep each mutation and its history on the transaction's connection. */
export async function upsertPromptTemplate(data: {
  eventType: string;
  scope: "global" | "agent" | "repo";
  scopeId?: string | null;
  state?: "enabled" | "default_prompt_fallback" | "skip_event";
  body: string;
  createdBy?: string | null;
  changedBy?: string | null;
  changeReason?: string | null;
  isDefault?: boolean;
}): Promise<PromptTemplate> {
  return getDbClient().transaction(async (tx) => {
    const now = new Date().toISOString();
    const scopeId = data.scope === "global" ? null : (data.scopeId ?? null);
    const state = data.state ?? "enabled";
    const createdBy = data.createdBy ?? data.changedBy ?? null;
    const changedBy = data.changedBy ?? data.createdBy ?? null;
    // NULL scope IDs need an explicit lookup because SQLite treats NULLs as distinct.
    const existing = await tx.get<PromptTemplateRow>(
      "SELECT * FROM prompt_templates WHERE eventType = ? AND scope = ? AND scopeId IS ?",
      [data.eventType, data.scope, scopeId],
    );
    const id = existing?.id ?? crypto.randomUUID();
    const version = (existing?.version ?? 0) + 1;
    const row = existing
      ? await tx.get<PromptTemplateRow>(
          `UPDATE prompt_templates SET body = ?, state = ?, isDefault = ?, version = ?, updatedAt = ?
           WHERE id = ? RETURNING *`,
          [
            data.body,
            state,
            data.scope === "global" && existing.isDefault === 1 ? 0 : existing.isDefault,
            version,
            now,
            id,
          ],
        )
      : await tx.get<PromptTemplateRow>(
          `INSERT INTO prompt_templates (id, eventType, scope, scopeId, state, body, isDefault, version, createdBy, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [
            id,
            data.eventType,
            data.scope,
            scopeId,
            state,
            data.body,
            data.isDefault ? 1 : 0,
            version,
            createdBy,
            now,
            now,
          ],
        );
    if (!row) throw new Error("Failed to upsert prompt template");
    await tx.run(
      `INSERT INTO prompt_template_history (id, templateId, version, body, state, changedBy, changedAt, changeReason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        id,
        version,
        data.body,
        state,
        changedBy,
        now,
        data.changeReason ?? (existing ? null : "Initial creation"),
      ],
    );
    return rowToPromptTemplate(row);
  });
}

export async function resetPromptTemplateToDefault(
  id: string,
  defaultBody: string,
): Promise<PromptTemplate> {
  return getDbClient().transaction(async (tx) => {
    const now = new Date().toISOString();
    const existing = await tx.get<PromptTemplateRow>(
      "SELECT * FROM prompt_templates WHERE id = ?",
      [id],
    );
    if (!existing) throw new Error(`Prompt template ${id} not found`);
    const version = existing.version + 1;
    const row = await tx.get<PromptTemplateRow>(
      `UPDATE prompt_templates SET body = ?, state = 'enabled', isDefault = 1, version = ?, updatedAt = ?
       WHERE id = ? RETURNING *`,
      [defaultBody, version, now, id],
    );
    if (!row) throw new Error("Failed to reset prompt template to default");
    await tx.run(
      `INSERT INTO prompt_template_history (id, templateId, version, body, state, changedBy, changedAt, changeReason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), id, version, defaultBody, "enabled", null, now, "Reset to default"],
    );
    return rowToPromptTemplate(row);
  });
}
