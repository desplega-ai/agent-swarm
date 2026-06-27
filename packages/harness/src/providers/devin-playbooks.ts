/**
 * Playbook cache helper for Devin provider.
 *
 * Maintains a SHA-256 hash → playbook_id cache backed by swarm_config so
 * playbook IDs survive process restarts. An in-memory Map sits in front
 * to avoid repeated HTTP round-trips within the same process.
 */

import { createPlaybook } from "./devin-api";

const CONFIG_KEY_PREFIX = "devin_playbook_";

/** In-memory cache: SHA-256 hash of body -> playbook_id */
const playbookCache = new Map<string, string>();

async function loadFromConfig(
  swarmApiUrl: string,
  swarmApiKey: string,
  hash: string,
): Promise<string | null> {
  try {
    const key = `${CONFIG_KEY_PREFIX}${hash}`;
    const res = await fetch(`${swarmApiUrl}/api/config/resolved?key=${key}`, {
      headers: { Authorization: `Bearer ${swarmApiKey}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { configs: Array<{ key: string; value: string }> };
    const entry = data.configs?.find((c) => c.key === key);
    return entry?.value ?? null;
  } catch {
    return null;
  }
}

async function saveToConfig(
  swarmApiUrl: string,
  swarmApiKey: string,
  hash: string,
  playbookId: string,
): Promise<void> {
  await fetch(`${swarmApiUrl}/api/config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${swarmApiKey}`,
    },
    body: JSON.stringify({
      scope: "global",
      key: `${CONFIG_KEY_PREFIX}${hash}`,
      value: playbookId,
      description: `Devin playbook cache (hash: ${hash.slice(0, 12)}...)`,
    }),
  });
}

/**
 * Return the playbook_id for the given body, creating the playbook via the
 * Devin API if it has not been seen before.
 */
export async function getOrCreatePlaybook(
  orgId: string,
  apiKey: string,
  title: string,
  body: string,
  swarmApiUrl?: string,
  swarmApiKey?: string,
): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");

  const cached = playbookCache.get(hash);
  if (cached) return cached;

  if (swarmApiUrl && swarmApiKey) {
    const persisted = await loadFromConfig(swarmApiUrl, swarmApiKey, hash);
    if (persisted) {
      playbookCache.set(hash, persisted);
      return persisted;
    }
  }

  const response = await createPlaybook(orgId, apiKey, { title, body });
  playbookCache.set(hash, response.playbook_id);

  if (swarmApiUrl && swarmApiKey) {
    saveToConfig(swarmApiUrl, swarmApiKey, hash, response.playbook_id).catch((err) =>
      console.warn(`[devin] playbook cache save failed: ${err}`),
    );
  }

  return response.playbook_id;
}
