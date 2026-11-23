import type { TrackerAgentMapping, TrackerSync } from "../../tracker/types";
import { normalizeDateRequired } from "../date-utils";
import { getStorage } from "../storage";

function normalizeTrackerSync(row: TrackerSync): TrackerSync {
  return {
    ...row,
    lastSyncedAt: normalizeDateRequired(row.lastSyncedAt),
    createdAt: normalizeDateRequired(row.createdAt),
  };
}

function normalizeTrackerAgentMapping(row: TrackerAgentMapping): TrackerAgentMapping {
  return {
    ...row,
    createdAt: normalizeDateRequired(row.createdAt),
  };
}

// ── Tracker Sync ──

export async function getTrackerSync(
  provider: string,
  entityType: "task",
  swarmId: string,
): Promise<TrackerSync | null> {
  const row = await getStorage().repos.trackers.findSync(provider, entityType, swarmId);
  return row ? normalizeTrackerSync(row as TrackerSync) : null;
}

export async function getTrackerSyncByExternalId(
  provider: string,
  entityType: "task",
  externalId: string,
): Promise<TrackerSync | null> {
  const row = await getStorage().repos.trackers.findSyncByExternalId(
    provider,
    entityType,
    externalId,
  );
  return row ? normalizeTrackerSync(row as TrackerSync) : null;
}

/**
 * Idempotent UNIQUE-gated insert into `tracker_sync`. Returns
 * `{ inserted: true, sync }` when a fresh row was created, or
 * `{ inserted: false, sync }` when the `(provider, entityType, externalId)`
 * tuple already had a row. Used by inbound webhook handlers (currently Jira)
 * to gate task creation atomically: insert sync row first, only call
 * `createTaskExtended` if `inserted === true`.
 *
 * Note: this is a "claim" insert — `swarmId` is initially the sentinel value
 * passed in (callers typically pass a placeholder like `""` or a known UUID),
 * then update it with `updateTrackerSyncSwarmId` once the task is created.
 */
export async function createTrackerSyncIfAbsent(data: {
  provider: string;
  entityType: "task";
  providerEntityType?: string | null;
  swarmId: string;
  externalId: string;
  externalIdentifier?: string | null;
  externalUrl?: string | null;
  lastSyncOrigin?: "swarm" | "external" | null;
  lastDeliveryId?: string | null;
  syncDirection?: "inbound" | "outbound" | "bidirectional";
}): Promise<{ inserted: boolean; sync: TrackerSync }> {
  const insertResult = (await getStorage().repos.trackers.insertSyncIfAbsent({
    provider: data.provider,
    entityType: data.entityType,
    providerEntityType: data.providerEntityType ?? null,
    swarmId: data.swarmId,
    externalId: data.externalId,
    externalIdentifier: data.externalIdentifier ?? null,
    externalUrl: data.externalUrl ?? null,
    lastSyncOrigin: data.lastSyncOrigin ?? null,
    lastDeliveryId: data.lastDeliveryId ?? null,
    syncDirection: data.syncDirection ?? "inbound",
  })) as TrackerSync | null;

  if (insertResult) {
    return { inserted: true, sync: normalizeTrackerSync(insertResult) };
  }

  // Row already existed — fetch it for the caller.
  const existing = await getTrackerSyncByExternalId(
    data.provider,
    data.entityType,
    data.externalId,
  );
  if (!existing) {
    // Should be unreachable: ON CONFLICT means a row exists, but this guard
    // satisfies the type system and surfaces unexpected races loudly.
    throw new Error(
      `[tracker] createTrackerSyncIfAbsent: ON CONFLICT fired but no existing row found for (${data.provider}, ${data.entityType}, ${data.externalId})`,
    );
  }
  return { inserted: false, sync: existing };
}

/**
 * Update the `swarmId` on an existing `tracker_sync` row. Used after the
 * idempotent `createTrackerSyncIfAbsent` returned `{ inserted: true }` and
 * we've now created the swarm task that should own this row.
 */
export async function updateTrackerSyncSwarmId(id: string, swarmId: string): Promise<void> {
  await getStorage().repos.trackers.setSyncSwarmId(id, swarmId);
}

/**
 * Repoint ALL `tracker_sync` rows currently keyed to `oldSwarmId` to
 * `newSwarmId`. Returns the number of rows updated.
 *
 * Used when a task is superseded (PR #594): the supersede parent becomes
 * terminal but the Linear/Jira issue is still active, and outbound
 * completion posts + inbound webhooks lookup by swarmId. Without
 * repointing, the resume child's completion never makes it back to the
 * tracker and subsequent inbound events load the terminal parent and
 * create duplicates.
 *
 * Safe to call when no rows match (no-op, returns 0). Repoints across
 * all providers (Linear AND Jira) and all entity types in one call.
 */
export async function repointTrackerSyncBySwarmId(
  oldSwarmId: string,
  newSwarmId: string,
): Promise<number> {
  return getStorage().repos.trackers.repointSyncSwarmId(oldSwarmId, newSwarmId);
}

export async function createTrackerSync(data: {
  provider: string;
  entityType: "task";
  providerEntityType?: string | null;
  swarmId: string;
  externalId: string;
  externalIdentifier?: string | null;
  externalUrl?: string | null;
  lastSyncOrigin?: "swarm" | "external" | null;
  lastDeliveryId?: string | null;
  syncDirection?: "inbound" | "outbound" | "bidirectional";
}): Promise<TrackerSync> {
  const result = await getStorage().repos.trackers.insertSync({
    provider: data.provider,
    entityType: data.entityType,
    providerEntityType: data.providerEntityType ?? null,
    swarmId: data.swarmId,
    externalId: data.externalId,
    externalIdentifier: data.externalIdentifier ?? null,
    externalUrl: data.externalUrl ?? null,
    lastSyncOrigin: data.lastSyncOrigin ?? null,
    lastDeliveryId: data.lastDeliveryId ?? null,
    syncDirection: data.syncDirection ?? "inbound",
  });
  return normalizeTrackerSync(result as TrackerSync);
}

export async function updateTrackerSync(
  id: string,
  data: Partial<
    Pick<
      TrackerSync,
      | "lastSyncedAt"
      | "lastSyncOrigin"
      | "lastDeliveryId"
      | "syncDirection"
      | "externalUrl"
      | "externalIdentifier"
    >
  >,
): Promise<void> {
  await getStorage().repos.trackers.updateSync(id, data);
}

/** Whether a mapping with `id` existed and was removed. */
export async function deleteTrackerSync(id: string): Promise<boolean> {
  return getStorage().repos.trackers.deleteSync(id);
}

/**
 * Check whether a `tracker_sync` row exists for `provider` with the given
 * `lastDeliveryId`. Used by inbound webhook handlers (Jira) to dedupe
 * deliveries via DB-persisted state instead of a process-local Map.
 *
 * Returns `false` when `deliveryId` is falsy/empty so callers don't have to
 * branch.
 */
export async function hasTrackerDelivery(
  provider: string,
  deliveryId: string | null | undefined,
): Promise<boolean> {
  if (!deliveryId) return false;
  return getStorage().repos.trackers.hasDelivery(provider, deliveryId);
}

/**
 * Mark a delivery as processed by writing `deliveryId` into the relevant
 * `tracker_sync` row identified by `(provider, entityType, externalId)`.
 *
 * No-op when the row doesn't exist yet (the very first inbound event creates
 * the row via `createTrackerSyncIfAbsent` — recording delivery happens after
 * that). Caller is responsible for ordering.
 */
export async function markTrackerDelivery(
  provider: string,
  entityType: "task",
  externalId: string,
  deliveryId: string,
): Promise<void> {
  await getStorage().repos.trackers.markDelivery(provider, entityType, externalId, deliveryId);
}

export async function getAllTrackerSyncs(
  provider?: string,
  entityType?: "task",
): Promise<TrackerSync[]> {
  const rows = await getStorage().repos.trackers.listSyncs({ provider, entityType });
  return (rows as TrackerSync[]).map(normalizeTrackerSync);
}

// ── Tracker Agent Mapping ──

export async function getTrackerAgentMapping(
  provider: string,
  agentId: string,
): Promise<TrackerAgentMapping | null> {
  const row = await getStorage().repos.trackers.findAgentMapping(provider, agentId);
  return row ? normalizeTrackerAgentMapping(row as TrackerAgentMapping) : null;
}

export async function getTrackerAgentMappingByExternalUser(
  provider: string,
  externalUserId: string,
): Promise<TrackerAgentMapping | null> {
  const row = await getStorage().repos.trackers.findAgentMappingByExternalUser(
    provider,
    externalUserId,
  );
  return row ? normalizeTrackerAgentMapping(row as TrackerAgentMapping) : null;
}

export async function createTrackerAgentMapping(data: {
  provider: string;
  agentId: string;
  externalUserId: string;
  agentName: string;
}): Promise<TrackerAgentMapping> {
  const result = await getStorage().repos.trackers.insertAgentMapping(data);
  return normalizeTrackerAgentMapping(result as TrackerAgentMapping);
}

export async function deleteTrackerAgentMapping(provider: string, agentId: string): Promise<void> {
  await getStorage().repos.trackers.deleteAgentMapping(provider, agentId);
}

export async function getAllTrackerAgentMappings(
  provider?: string,
): Promise<TrackerAgentMapping[]> {
  const rows = await getStorage().repos.trackers.listAgentMappings(provider);
  return (rows as TrackerAgentMapping[]).map(normalizeTrackerAgentMapping);
}
