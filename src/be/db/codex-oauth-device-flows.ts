import { getDbClient } from "./runtime";

/**
 * Encrypted Codex device-login flow state. Kept out of `kv_entries` so
 * db-query can deny it by table. Returns null if missing or expired; an
 * expired row is deleted inline.
 */
export async function getCodexDeviceFlow(
  flowId: string,
): Promise<{ state: string; expiresAt: number } | null> {
  const row = await getDbClient().get<{ state: string; expires_at: number }>(
    "SELECT state, expires_at FROM codex_oauth_device_flows WHERE flow_id = ?",
    [flowId],
  );
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await getDbClient().run("DELETE FROM codex_oauth_device_flows WHERE flow_id = ?", [flowId]);
    return null;
  }
  return { state: row.state, expiresAt: row.expires_at };
}

/** Upsert one device-login flow and drop every expired flow. */
export async function upsertCodexDeviceFlow(input: {
  flowId: string;
  state: string;
  expiresAt: number;
}): Promise<void> {
  const now = Date.now();
  await getDbClient().run("DELETE FROM codex_oauth_device_flows WHERE expires_at <= ?", [now]);
  await getDbClient().run(
    `INSERT INTO codex_oauth_device_flows (flow_id, state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(flow_id) DO UPDATE SET
         state = excluded.state,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    [input.flowId, input.state, input.expiresAt, now, now],
  );
}
