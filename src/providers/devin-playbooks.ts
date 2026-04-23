/**
 * Playbook cache helper for Devin provider.
 *
 * Maintains an in-memory SHA-256 hash → playbook_id cache so repeated sessions
 * with the same system prompt reuse the same playbook without re-creating it.
 */

import { createPlaybook } from "./devin-api";

/** In-memory cache: SHA-256 hash of body -> playbook_id */
const playbookCache = new Map<string, string>();

/**
 * Return the playbook_id for the given body, creating the playbook via the
 * Devin API if it has not been seen before in this process.
 */
export async function getOrCreatePlaybook(
  orgId: string,
  apiKey: string,
  title: string,
  body: string,
): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const cached = playbookCache.get(hash);
  if (cached) return cached;

  const response = await createPlaybook(orgId, apiKey, { title, body });
  playbookCache.set(hash, response.playbook_id);
  return response.playbook_id;
}
