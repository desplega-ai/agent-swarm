import { getStorage } from "../storage";

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
  return getStorage().repos.kv.keyAfter(namespace, prefixUpper, afterKey, offset);
}
