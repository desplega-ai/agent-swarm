import type { ControllerCommands } from "../../runtime-providers/controller";
import { poolCacheKey, type RuntimeCacheReference } from "../../runtime-providers/types";
import type { RuntimePool } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient, getSwarmConfigs } from "../db";

/** The stored key is private API metadata; legacy caches retain their original name. */
export async function getPoolCache(poolId: string): Promise<{
  key: string;
  mountPath: string;
  controllerId: string;
} | null> {
  const row = await getDbClient().get<{ cache: string | null; controllerId: string }>(
    "SELECT cache, json_extract(placements, '$[0]') AS controllerId FROM runtime_pools WHERE id = ?",
    [poolId],
  );
  if (!row?.cache) return null;
  const cache = JSON.parse(row.cache);
  return {
    key: cache.key ?? poolCacheKey(poolId),
    mountPath: cache.mountPath,
    controllerId: row.controllerId,
  };
}

/** Call in the pool write transaction; no infrastructure calls occur here. */
export async function queuePoolCacheRelease(
  pool: RuntimePool,
  actor: string | null,
): Promise<void> {
  if (!pool.cache) return;
  const owner = (await getSwarmConfigs({ scope: "global", key: "runtime_owner_id" }))[0];
  // No runtime could have created an owned cache before the owner was allocated.
  if (!owner) return;
  const cache = (await getPoolCache(pool.id))!;
  const runtimes = await getDbClient().query<{ id: string }>(
    `SELECT id FROM runtime_instances WHERE pool_id = ?
     AND (controller_id = ? OR controller_id IS NULL) AND status != 'offline'`,
    [pool.id, pool.placements[0]!],
  );
  await getDbClient().run(
    `INSERT INTO runtime_cache_releases
      (id, pool_id, controller_id, owner_id, cache_key, runtime_ids, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(controller_id, owner_id, cache_key) DO NOTHING`,
    [
      crypto.randomUUID(),
      pool.id,
      pool.placements[0]!,
      owner.value,
      cache.key,
      JSON.stringify(runtimes.map((r) => r.id)),
      actor,
      actor,
    ],
  );
}

interface CacheRelease extends RuntimeCacheReference {
  id: string;
  controllerId: string;
}

const RELEASE_LEASE_MS = 5 * 60_000;

/** Claims are atomic across reconcilers; all network calls are outside DB transactions. */
export async function reconcileCacheReleases(
  commands: (id: string) => Promise<ControllerCommands>,
  signal: AbortSignal,
  now?: Date,
): Promise<void> {
  const jobs = await getDbClient().query<CacheRelease>(
    `SELECT id, pool_id AS poolId, controller_id AS controllerId, owner_id AS ownerId,
     cache_key AS key FROM runtime_cache_releases ORDER BY created_at`,
  );
  for (const job of jobs) {
    if (signal.aborted) return;
    const claimed = now ?? new Date();
    const claimedAt = claimed.toISOString();
    // Reclaim abandoned work after five minutes; generation keys fence late provider calls.
    const reserved = await getDbClient().run(
      `UPDATE runtime_cache_releases SET state = 'deleting', updated_at = ?
       WHERE id = ? AND (state = 'pending' OR updated_at < ?) AND NOT EXISTS (
         SELECT 1 FROM runtime_instances WHERE status != 'offline'
         AND id IN (SELECT value FROM json_each(runtime_cache_releases.runtime_ids))
       )`,
      [claimedAt, job.id, new Date(claimed.getTime() - RELEASE_LEASE_MS).toISOString()],
    );
    if (!reserved.changes) continue;
    try {
      signal.throwIfAborted();
      const controller = await commands(job.controllerId);
      if (!controller.releaseCache)
        throw new Error("Controller cannot release caches; upgrade it before cleanup");
      await controller.releaseCache({ key: job.key, poolId: job.poolId, ownerId: job.ownerId });
      await getDbClient().run(
        "DELETE FROM runtime_cache_releases WHERE id = ? AND state = 'deleting' AND updated_at = ?",
        [job.id, claimedAt],
      );
    } catch (error) {
      const message = scrubSecrets(String(error));
      await getDbClient().run(
        `UPDATE runtime_cache_releases SET state = 'pending', last_error = ?, updated_at = ?
         WHERE id = ? AND state = 'deleting' AND updated_at = ?`,
        [message, new Date().toISOString(), job.id, claimedAt],
      );
      if (!signal.aborted) console.error("[runtime-pools] Cache cleanup deferred:", message);
    }
  }
}
