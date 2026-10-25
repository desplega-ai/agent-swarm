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
