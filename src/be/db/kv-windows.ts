import { getDbClient } from "./runtime";

/**
 * The key `offset` rows past `afterKey` inside `[prefix, prefixUpper)`, or
 * null when fewer remain. Reads the primary-key index only, so it is cheap
 * next to a value scan; callers use it to cut a long scan into key windows.
 */
export async function kvKeyAfter(
  namespace: string,
  prefixUpper: string,
  afterKey: string,
  offset: number,
): Promise<string | null> {
  const row = await getDbClient().get<{ key: string }>(
    `SELECT key FROM kv_entries
        WHERE namespace = ? AND key > ? AND key < ?
        ORDER BY key
        LIMIT 1 OFFSET ?`,
    [namespace, afterKey, prefixUpper, offset],
  );
  return row?.key ?? null;
}
