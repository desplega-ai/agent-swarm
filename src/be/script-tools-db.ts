import type { ScriptTool } from "../types";
import { getDb } from "./db";

interface ScriptToolRow {
  id: string;
  toolName: string;
  scriptName: string;
  description: string;
  enabled: number;
  createdByAgentId: string | null;
  created_by: string | null;
  updated_by: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToScriptTool(row: ScriptToolRow): ScriptTool {
  return {
    id: row.id,
    toolName: row.toolName,
    scriptName: row.scriptName,
    description: row.description,
    enabled: row.enabled === 1,
    createdByAgentId: row.createdByAgentId ?? undefined,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createScriptTool(args: {
  toolName: string;
  scriptName: string;
  description: string;
  enabled?: boolean;
  createdByAgentId?: string;
  createdBy?: string;
}): ScriptTool {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO script_tools
         (id, toolName, scriptName, description, enabled, createdByAgentId, created_by, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.toolName,
      args.scriptName,
      args.description,
      args.enabled === false ? 0 : 1,
      args.createdByAgentId ?? null,
      args.createdBy ?? null,
      now,
      now,
    );
  const created = getScriptToolByName(args.toolName);
  if (!created) throw new Error("Failed to create script tool");
  return created;
}

export function getScriptToolByName(toolName: string): ScriptTool | null {
  const row = getDb()
    .prepare("SELECT * FROM script_tools WHERE toolName = ?")
    .get(toolName) as ScriptToolRow | null;
  return row ? rowToScriptTool(row) : null;
}

export function listScriptTools(args?: { enabledOnly?: boolean }): ScriptTool[] {
  const rows = (
    args?.enabledOnly
      ? getDb().prepare("SELECT * FROM script_tools WHERE enabled = 1 ORDER BY toolName")
      : getDb().prepare("SELECT * FROM script_tools ORDER BY toolName")
  ).all() as ScriptToolRow[];
  return rows.map(rowToScriptTool);
}

export function deleteScriptTool(toolName: string): boolean {
  const res = getDb().prepare("DELETE FROM script_tools WHERE toolName = ?").run(toolName);
  return res.changes > 0;
}

export function setScriptToolEnabled(
  toolName: string,
  enabled: boolean,
  updatedBy?: string,
): boolean {
  const res = getDb()
    .prepare(
      "UPDATE script_tools SET enabled = ?, updated_by = COALESCE(?, updated_by), updatedAt = ? WHERE toolName = ?",
    )
    .run(enabled ? 1 : 0, updatedBy ?? null, new Date().toISOString(), toolName);
  return res.changes > 0;
}
