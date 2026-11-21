import {
  SESSION_RESOURCE_KINDS,
  type SessionResourceGroup,
  sessionResourceGroupOf,
} from "../../assets/key";
import { upsertKv } from "../db";
import { getStorage } from "../storage";

const NAMESPACE = "session-labels";

export async function getSessionLabels(keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const rows = await getStorage().repos.sessions.listLiveKvValues(NAMESPACE, keys, Date.now());
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
      // The sessions repository names the table and column of each kind.
      const rows = await getStorage().repos.sessions.listResourceNames(kind, ids);
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
