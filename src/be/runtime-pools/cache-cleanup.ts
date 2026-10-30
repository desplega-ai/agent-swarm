import type { ControllerCommands } from "../../runtime-providers/controller";
import type { RuntimeCacheReference } from "../../runtime-providers/types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient } from "../db";

interface CacheRelease extends RuntimeCacheReference {
  id: string;
  controllerId: string;
}

/** Runs only from the supervisor's serialized tick. All network calls are outside DB transactions. */
export async function reconcileCacheReleases(
  commands: (id: string) => Promise<ControllerCommands>,
  signal: AbortSignal,
): Promise<void> {
  const jobs = await getDbClient().query<CacheRelease>(
    `SELECT id, pool_id AS poolId, controller_id AS controllerId, owner_id AS ownerId,
     cache_key AS key FROM runtime_cache_releases ORDER BY created_at`,
  );
  for (const job of jobs) {
    if (signal.aborted) return;
    // One atomic write claims only uncancelled jobs whose original runtimes stopped.
    const reserved = await getDbClient().run(
      `UPDATE runtime_cache_releases SET state = 'deleting', updated_at = ?
       WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM runtime_instances WHERE status != 'offline'
         AND id IN (SELECT value FROM json_each(runtime_cache_releases.runtime_ids))
       )`,
      [new Date().toISOString(), job.id],
    );
    if (!reserved.changes) continue;
    try {
      signal.throwIfAborted();
      const controller = await commands(job.controllerId);
      if (!controller.releaseCache)
        throw new Error("Controller cannot release caches; upgrade it before cleanup");
      await controller.releaseCache({ key: job.key, poolId: job.poolId, ownerId: job.ownerId });
      await getDbClient().run("DELETE FROM runtime_cache_releases WHERE id = ?", [job.id]);
    } catch (error) {
      const message = scrubSecrets(String(error));
      await getDbClient().run(
        "UPDATE runtime_cache_releases SET state = 'pending', last_error = ?, updated_at = ? WHERE id = ?",
        [message, new Date().toISOString(), job.id],
      );
      if (!signal.aborted) console.error("[runtime-pools] Cache cleanup deferred:", message);
    }
  }
}
