import type { TrackerAgentMapping, TrackerSync } from "../../tracker/types";
import { normalizeDateRequired } from "../date-utils";
import { getDbClient } from "../db";

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
  const row = await getDbClient().get<TrackerSync>(
    "SELECT * FROM tracker_sync WHERE provider = ? AND entityType = ? AND swarmId = ?",
    [provider, entityType, swarmId],
  );
  return row ? normalizeTrackerSync(row) : null;
}

export async function getTrackerSyncByExternalId(
  provider: string,
  entityType: "task",
  externalId: string,
): Promise<TrackerSync | null> {
  const row = await getDbClient().get<TrackerSync>(
    "SELECT * FROM tracker_sync WHERE provider = ? AND entityType = ? AND externalId = ?",
    [provider, entityType, externalId],
  );
  return row ? normalizeTrackerSync(row) : null;
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
  const insertResult = await getDbClient().get<TrackerSync>(
    `INSERT INTO tracker_sync (provider, entityType, providerEntityType, swarmId, externalId, externalIdentifier, externalUrl, lastSyncOrigin, lastDeliveryId, syncDirection)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, entityType, externalId) DO NOTHING
       RETURNING *`,
    [
      data.provider,
      data.entityType,
      data.providerEntityType ?? null,
      data.swarmId,
      data.externalId,
      data.externalIdentifier ?? null,
      data.externalUrl ?? null,
      data.lastSyncOrigin ?? null,
      data.lastDeliveryId ?? null,
      data.syncDirection ?? "inbound",
    ],
  );

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
  await getDbClient().run("UPDATE tracker_sync SET swarmId = ? WHERE id = ?", [swarmId, id]);
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
  const result = await getDbClient().run("UPDATE tracker_sync SET swarmId = ? WHERE swarmId = ?", [
    newSwarmId,
    oldSwarmId,
  ]);
  return Number(result.changes ?? 0);
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
  const result = await getDbClient().get<TrackerSync>(
    `INSERT INTO tracker_sync (provider, entityType, providerEntityType, swarmId, externalId, externalIdentifier, externalUrl, lastSyncOrigin, lastDeliveryId, syncDirection)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    [
      data.provider,
      data.entityType,
      data.providerEntityType ?? null,
      data.swarmId,
      data.externalId,
      data.externalIdentifier ?? null,
      data.externalUrl ?? null,
      data.lastSyncOrigin ?? null,
      data.lastDeliveryId ?? null,
      data.syncDirection ?? "inbound",
    ],
  );
  return normalizeTrackerSync(result!);
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
  const sets: string[] = [];
  const values: (string | null)[] = [];

  if (data.lastSyncedAt !== undefined) {
    sets.push("lastSyncedAt = ?");
    values.push(data.lastSyncedAt);
  }
  if (data.lastSyncOrigin !== undefined) {
    sets.push("lastSyncOrigin = ?");
    values.push(data.lastSyncOrigin);
  }
  if (data.lastDeliveryId !== undefined) {
    sets.push("lastDeliveryId = ?");
    values.push(data.lastDeliveryId);
  }
  if (data.syncDirection !== undefined) {
    sets.push("syncDirection = ?");
    values.push(data.syncDirection);
  }
  if (data.externalUrl !== undefined) {
    sets.push("externalUrl = ?");
    values.push(data.externalUrl);
  }
  if (data.externalIdentifier !== undefined) {
    sets.push("externalIdentifier = ?");
    values.push(data.externalIdentifier);
  }

  if (sets.length === 0) return;

  values.push(id);
  await getDbClient().run(`UPDATE tracker_sync SET ${sets.join(", ")} WHERE id = ?`, values);
}

export async function deleteTrackerSync(id: string): Promise<void> {
  await getDbClient().run("DELETE FROM tracker_sync WHERE id = ?", [id]);
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
  const row = await getDbClient().get<{ hit: number }>(
    "SELECT 1 AS hit FROM tracker_sync WHERE provider = ? AND lastDeliveryId = ? LIMIT 1",
    [provider, deliveryId],
  );
  return !!row;
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
  await getDbClient().run(
    "UPDATE tracker_sync SET lastDeliveryId = ? WHERE provider = ? AND entityType = ? AND externalId = ?",
    [deliveryId, provider, entityType, externalId],
  );
}

export async function getAllTrackerSyncs(
  provider?: string,
  entityType?: "task",
): Promise<TrackerSync[]> {
  const conditions: string[] = [];
  const values: string[] = [];

  if (provider) {
    conditions.push("provider = ?");
    values.push(provider);
  }
  if (entityType) {
    conditions.push("entityType = ?");
    values.push(entityType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await getDbClient().query<TrackerSync>(
    `SELECT * FROM tracker_sync ${where} ORDER BY createdAt DESC`,
    values,
  );
  return rows.map(normalizeTrackerSync);
}

// ── Tracker Agent Mapping ──

export async function getTrackerAgentMapping(
  provider: string,
  agentId: string,
): Promise<TrackerAgentMapping | null> {
  const row = await getDbClient().get<TrackerAgentMapping>(
    "SELECT * FROM tracker_agent_mapping WHERE provider = ? AND agentId = ?",
    [provider, agentId],
  );
  return row ? normalizeTrackerAgentMapping(row) : null;
}

export async function getTrackerAgentMappingByExternalUser(
  provider: string,
  externalUserId: string,
): Promise<TrackerAgentMapping | null> {
  const row = await getDbClient().get<TrackerAgentMapping>(
    "SELECT * FROM tracker_agent_mapping WHERE provider = ? AND externalUserId = ?",
    [provider, externalUserId],
  );
  return row ? normalizeTrackerAgentMapping(row) : null;
}

export async function createTrackerAgentMapping(data: {
  provider: string;
  agentId: string;
  externalUserId: string;
  agentName: string;
}): Promise<TrackerAgentMapping> {
  const result = await getDbClient().get<TrackerAgentMapping>(
    `INSERT INTO tracker_agent_mapping (provider, agentId, externalUserId, agentName)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    [data.provider, data.agentId, data.externalUserId, data.agentName],
  );
  return normalizeTrackerAgentMapping(result!);
}

export async function deleteTrackerAgentMapping(provider: string, agentId: string): Promise<void> {
  await getDbClient().run("DELETE FROM tracker_agent_mapping WHERE provider = ? AND agentId = ?", [
    provider,
    agentId,
  ]);
}

export async function getAllTrackerAgentMappings(
  provider?: string,
): Promise<TrackerAgentMapping[]> {
  if (provider) {
    const rows = await getDbClient().query<TrackerAgentMapping>(
      "SELECT * FROM tracker_agent_mapping WHERE provider = ? ORDER BY createdAt DESC",
      [provider],
    );
    return rows.map(normalizeTrackerAgentMapping);
  }
  const rows = await getDbClient().query<TrackerAgentMapping>(
    "SELECT * FROM tracker_agent_mapping ORDER BY createdAt DESC",
  );
  return rows.map(normalizeTrackerAgentMapping);
}
