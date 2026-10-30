import { poolCacheKey } from "../../runtime-providers/types";
import type { RuntimePool } from "../../types";
import { getDbClient, getSwarmConfigs } from "../db";

/** Call in the pool write transaction; this schedules work without contacting infrastructure. */
export async function queuePoolCacheRelease(
  pool: RuntimePool,
  actor: string | null,
): Promise<void> {
  if (!pool.cache) return;
  const owner = (await getSwarmConfigs({ scope: "global", key: "runtime_owner_id" }))[0];
  // No runtime could have created an owned cache before the owner was allocated.
  if (!owner) return;
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
      poolCacheKey(pool.id),
      JSON.stringify(runtimes.map((r) => r.id)),
      actor,
      actor,
    ],
  );
}
