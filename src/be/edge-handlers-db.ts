import type {
  EdgeHandler,
  EdgeHandlerEdge,
  EdgeHandlerFlavor,
  EdgeHandlerMatcher,
  EdgeHandlerMode,
} from "../types";
import { getDb } from "./db";

interface EdgeHandlerRow {
  id: string;
  name: string;
  edge: string;
  scriptName: string;
  description: string | null;
  flavor: string;
  mode: string;
  priority: number;
  matcher: string | null;
  timeoutMs: number | null;
  enabled: number;
  createdByAgentId: string | null;
  created_by: string | null;
  updated_by: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToEdgeHandler(row: EdgeHandlerRow): EdgeHandler {
  return {
    id: row.id,
    name: row.name,
    edge: row.edge as EdgeHandlerEdge,
    scriptName: row.scriptName,
    description: row.description ?? undefined,
    flavor: row.flavor as EdgeHandlerFlavor,
    mode: row.mode as EdgeHandlerMode,
    priority: row.priority,
    matcher: row.matcher ? (JSON.parse(row.matcher) as EdgeHandlerMatcher) : undefined,
    timeoutMs: row.timeoutMs ?? undefined,
    enabled: row.enabled === 1,
    createdByAgentId: row.createdByAgentId ?? undefined,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createEdgeHandler(args: {
  name: string;
  edge: EdgeHandlerEdge;
  scriptName: string;
  description?: string;
  flavor: EdgeHandlerFlavor;
  mode: EdgeHandlerMode;
  priority?: number;
  matcher?: EdgeHandlerMatcher;
  timeoutMs?: number;
  enabled?: boolean;
  createdByAgentId?: string;
  createdBy?: string;
}): EdgeHandler {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO edge_handlers
         (id, name, edge, scriptName, description, flavor, mode, priority, matcher, timeoutMs,
          enabled, createdByAgentId, created_by, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.name,
      args.edge,
      args.scriptName,
      args.description ?? null,
      args.flavor,
      args.mode,
      args.priority ?? 100,
      args.matcher === undefined ? null : JSON.stringify(args.matcher),
      args.timeoutMs ?? null,
      args.enabled === false ? 0 : 1,
      args.createdByAgentId ?? null,
      args.createdBy ?? null,
      now,
      now,
    );
  const created = getEdgeHandlerById(id);
  if (!created) throw new Error("Failed to create edge handler");
  return created;
}

export function getEdgeHandlerById(id: string): EdgeHandler | null {
  const row = getDb()
    .prepare("SELECT * FROM edge_handlers WHERE id = ?")
    .get(id) as EdgeHandlerRow | null;
  return row ? rowToEdgeHandler(row) : null;
}

export function getEdgeHandlerByName(name: string): EdgeHandler | null {
  const row = getDb()
    .prepare("SELECT * FROM edge_handlers WHERE name = ?")
    .get(name) as EdgeHandlerRow | null;
  return row ? rowToEdgeHandler(row) : null;
}

export function listEdgeHandlers(): EdgeHandler[] {
  const rows = getDb()
    .prepare("SELECT * FROM edge_handlers ORDER BY edge, priority, name")
    .all() as EdgeHandlerRow[];
  return rows.map(rowToEdgeHandler);
}

export function listEnabledHandlersForEdge(edge: EdgeHandlerEdge): EdgeHandler[] {
  const rows = getDb()
    .prepare("SELECT * FROM edge_handlers WHERE edge = ? AND enabled = 1 ORDER BY priority, name")
    .all(edge) as EdgeHandlerRow[];
  return rows.map(rowToEdgeHandler);
}

export function patchEdgeHandler(
  id: string,
  patch: {
    name?: string;
    edge?: EdgeHandlerEdge;
    scriptName?: string;
    description?: string | null;
    flavor?: EdgeHandlerFlavor;
    mode?: EdgeHandlerMode;
    priority?: number;
    matcher?: EdgeHandlerMatcher | null;
    timeoutMs?: number | null;
    enabled?: boolean;
    updatedBy?: string;
  },
): EdgeHandler | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  const fields: Array<[keyof typeof patch, string]> = [
    ["name", "name"],
    ["edge", "edge"],
    ["scriptName", "scriptName"],
    ["description", "description"],
    ["flavor", "flavor"],
    ["mode", "mode"],
    ["priority", "priority"],
    ["timeoutMs", "timeoutMs"],
  ];
  for (const [key, column] of fields) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
  }
  if (patch.matcher !== undefined) {
    sets.push("matcher = ?");
    values.push(patch.matcher === null ? null : JSON.stringify(patch.matcher));
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return getEdgeHandlerById(id);
  if (patch.updatedBy !== undefined) {
    sets.push("updated_by = ?");
    values.push(patch.updatedBy);
  }
  sets.push("updatedAt = ?");
  values.push(new Date().toISOString(), id);
  getDb()
    .prepare(`UPDATE edge_handlers SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number | null)[]));
  return getEdgeHandlerById(id);
}

export function deleteEdgeHandler(id: string): boolean {
  const res = getDb().prepare("DELETE FROM edge_handlers WHERE id = ?").run(id);
  return res.changes > 0;
}
