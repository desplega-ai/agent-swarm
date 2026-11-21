import type { ControllerCommands } from "../../runtime-providers/controller";
import { poolCacheKey, type RuntimeCacheReference } from "../../runtime-providers/types";
import type { RuntimePool } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getSwarmConfigs } from "../db";
import { getStorage } from "../storage";

const repo = () => getStorage().repos.runtimePools;

/** The stored key is private API metadata; legacy caches retain their original name. */
export async function getPoolCache(poolId: string): Promise<{
  key: string;
  mountPath: string;
  controllerId: string;
} | null> {
  const row = await repo().findPoolCache(poolId);
  if (!row?.cache) return null;
  const cache = JSON.parse(row.cache);
  return {
    key: cache.key ?? poolCacheKey(poolId),
    mountPath: cache.mountPath,
    // json_extract(placements, '$[0]') before the move: NULL for an empty list.
    controllerId: JSON.parse(row.placements)[0] ?? null,
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
  const runtimeIds = await repo().listNonOfflinePoolRuntimeIds(pool.id, pool.placements[0]!);
  await repo().insertCacheRelease({
    id: crypto.randomUUID(),
    poolId: pool.id,
    controllerId: pool.placements[0]!,
    ownerId: owner.value,
    cacheKey: cache.key,
    runtimeIdsJson: JSON.stringify(runtimeIds),
    actor,
  });
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
  const jobs: CacheRelease[] = await repo().listCacheReleases();
  for (const job of jobs) {
    if (signal.aborted) return;
    const claimed = now ?? new Date();
    const claimedAt = claimed.toISOString();
    // Reclaim abandoned work after five minutes; generation keys fence late provider calls.
    const reserved = await repo().claimCacheRelease(
      job.id,
      claimedAt,
      new Date(claimed.getTime() - RELEASE_LEASE_MS).toISOString(),
    );
    if (!reserved) continue;
    try {
      signal.throwIfAborted();
      const controller = await commands(job.controllerId);
      if (!controller.releaseCache)
        throw new Error("Controller cannot release caches; upgrade it before cleanup");
      await controller.releaseCache({ key: job.key, poolId: job.poolId, ownerId: job.ownerId });
      await repo().deleteClaimedCacheRelease(job.id, claimedAt);
    } catch (error) {
      const message = scrubSecrets(String(error));
      await repo().releaseCacheReleaseClaim(job.id, claimedAt, message, new Date().toISOString());
      if (!signal.aborted) console.error("[runtime-pools] Cache cleanup deferred:", message);
    }
  }
}
