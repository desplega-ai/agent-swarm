import { getStorage } from "../storage";

/**
 * Encrypted Codex device-login flow state. Kept out of `kv_entries` so
 * db-query can deny it by table. Returns null if missing or expired; an
 * expired row is deleted inline.
 */
export async function getCodexDeviceFlow(
  flowId: string,
): Promise<{ state: string; expiresAt: number } | null> {
  const repo = getStorage().repos.oauth;
  const row = await repo.getCodexDeviceFlow(flowId);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await repo.deleteCodexDeviceFlow(flowId);
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
  const repo = getStorage().repos.oauth;
  await repo.deleteExpiredCodexDeviceFlows(now);
  await repo.upsertCodexDeviceFlow(input.flowId, input.state, input.expiresAt, now);
}
