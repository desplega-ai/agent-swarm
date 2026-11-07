import {
  SESSION_RESOURCE_KINDS,
  type SessionResourceGroup,
  type SessionResourceKind,
  sessionResourceGroupOf,
} from "../../assets/key";
import { getDbClient, upsertKv } from "../db";

const NAMESPACE = "session-labels";

export async function getSessionLabels(keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const rows = await getDbClient().query<{ key: string; value: string }>(
    `SELECT key, value FROM kv_entries
     WHERE namespace = ? AND key IN (${keys.map(() => "?").join(", ")})
       AND (expires_at IS NULL OR expires_at > ?)`,
    [NAMESPACE, ...keys, Date.now()],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function rememberSessionLabel(
  key: string,
  label: string,
  ttlMs?: number,
): Promise<void> {
  await upsertKv({
    namespace: NAMESPACE,
    key,
    value: label,
    valueType: "string",
    expiresAt: ttlMs === undefined ? null : Date.now() + ttlMs,
  });
}

/** The table and name column of each resource kind a session group can name. */
const RESOURCE_NAMES: Record<SessionResourceKind, { table: string; column: string }> = {
  page: { table: "pages", column: "title" },
  workflow: { table: "workflows", column: "name" },
  schedule: { table: "scheduled_tasks", column: "name" },
  app: { table: "apps", column: "name" },
  script: { table: "scripts", column: "name" },
  fs: { table: "asset_key_mappings", column: "provider_key" },
};

/**
 * Labels of resource session groups (`sessionResourceGroupOf`), one query per
 * kind: the resource's name, and an app action's name. A deleted resource
 * gets no label; the UI falls back to "<Kind> · <short id>".
 */
export async function getResourceSessionLabels(keys: string[]): Promise<Record<string, string>> {
  const groups = keys.flatMap((key) => {
    const resource = sessionResourceGroupOf(key);
    return resource ? [{ key, resource }] : [];
  });
  const labels: Record<string, string> = {};
  for (const { key, resource } of groups) {
    if (resource.action) labels[key] = resource.action;
  }
  // An `fs` id keeps its provider (`agent-fs:<id>`): the mapping id is the last part.
  const rowId = (resource: SessionResourceGroup) =>
    resource.kind === "fs" ? resource.id.slice(resource.id.lastIndexOf(":") + 1) : resource.id;
  await Promise.all(
    SESSION_RESOURCE_KINDS.map(async (kind) => {
      const wanted = groups.filter(({ resource }) => resource.kind === kind && !resource.action);
      if (wanted.length === 0) return;
      const ids = [...new Set(wanted.map(({ resource }) => rowId(resource)))];
      const { table, column } = RESOURCE_NAMES[kind];
      const rows = await getDbClient().query<{ id: string; name: string | null }>(
        // Keys are lower case, and so are generated ids: `id IN` keeps the primary key index.
        `SELECT lower(id) AS id, NULLIF(trim(${column}), '') AS name FROM ${table}
         WHERE id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
      const names = new Map(rows.map((row) => [row.id, row.name]));
      for (const { key, resource } of wanted) {
        const name = names.get(rowId(resource));
        if (!name) continue;
        // A file reads as its last path segment.
        labels[key] = kind === "fs" ? name.replace(/\/+$/, "").split("/").pop() || name : name;
      }
    }),
  );
  return labels;
}
