import type { TrackerAgentMapping, TrackerSync } from "../../tracker/types";
import { normalizeDateRequired } from "../date-utils";
import { getDb } from "../db";

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

export function getTrackerSync(
  provider: string,
  entityType: "task",
  swarmId: string,
): TrackerSync | null {
  const row = getDb()
    .query("SELECT * FROM tracker_sync WHERE provider = ? AND entityType = ? AND swarmId = ?")
    .get(provider, entityType, swarmId) as TrackerSync | null;
  return row ? normalizeTrackerSync(row) : null;
}

export function getTrackerSyncByExternalId(
  provider: string,
  entityType: "task",
  externalId: string,
): TrackerSync | null {
  const row = getDb()
    .query("SELECT * FROM tracker_sync WHERE provider = ? AND entityType = ? AND externalId = ?")
    .get(provider, entityType, externalId) as TrackerSync | null;
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
export function createTrackerSyncIfAbsent(data: {
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
}): { inserted: boolean; sync: TrackerSync } {
  const insertResult = getDb()
    .query(
      `INSERT INTO tracker_sync (provider, entityType, providerEntityType, swarmId, externalId, externalIdentifier, externalUrl, lastSyncOrigin, lastDeliveryId, syncDirection)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, entityType, externalId) DO NOTHING
       RETURNING *`,
    )
    .get(
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
    ) as TrackerSync | null;

  if (insertResult) {
    return { inserted: true, sync: normalizeTrackerSync(insertResult) };
  }

  // Row already existed — fetch it for the caller.
  const existing = getTrackerSyncByExternalId(data.provider, data.entityType, data.externalId);
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
export function updateTrackerSyncSwarmId(id: string, swarmId: string): void {
  getDb().query("UPDATE tracker_sync SET swarmId = ? WHERE id = ?").run(swarmId, id);
}

export function createTrackerSync(data: {
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
}): TrackerSync {
  const result = getDb()
    .query(
      `INSERT INTO tracker_sync (provider, entityType, providerEntityType, swarmId, externalId, externalIdentifier, externalUrl, lastSyncOrigin, lastDeliveryId, syncDirection)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
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
    ) as TrackerSync;
  return normalizeTrackerSync(result);
}

export function updateTrackerSync(
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
): void {
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
  getDb()
    .query(`UPDATE tracker_sync SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
}

export function deleteTrackerSync(id: string): void {
  getDb().query("DELETE FROM tracker_sync WHERE id = ?").run(id);
}

/**
 * Check whether a `tracker_sync` row exists for `provider` with the given
 * `lastDeliveryId`. Used by inbound webhook handlers (Jira) to dedupe
 * deliveries via DB-persisted state instead of a process-local Map.
 *
 * Returns `false` when `deliveryId` is falsy/empty so callers don't have to
 * branch.
 */
export function hasTrackerDelivery(
  provider: string,
  deliveryId: string | null | undefined,
): boolean {
  if (!deliveryId) return false;
  const row = getDb()
    .query("SELECT 1 AS hit FROM tracker_sync WHERE provider = ? AND lastDeliveryId = ? LIMIT 1")
    .get(provider, deliveryId) as { hit: number } | null;
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
export function markTrackerDelivery(
  provider: string,
  entityType: "task",
  externalId: string,
  deliveryId: string,
): void {
  getDb()
    .query(
      "UPDATE tracker_sync SET lastDeliveryId = ? WHERE provider = ? AND entityType = ? AND externalId = ?",
    )
    .run(deliveryId, provider, entityType, externalId);
}

export function getAllTrackerSyncs(provider?: string, entityType?: "task"): TrackerSync[] {
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
  return (
    getDb()
      .query(`SELECT * FROM tracker_sync ${where} ORDER BY createdAt DESC`)
      .all(...values) as TrackerSync[]
  ).map(normalizeTrackerSync);
}

// ── Tracker Agent Mapping ──

export function getTrackerAgentMapping(
  provider: string,
  agentId: string,
): TrackerAgentMapping | null {
  const row = getDb()
    .query("SELECT * FROM tracker_agent_mapping WHERE provider = ? AND agentId = ?")
    .get(provider, agentId) as TrackerAgentMapping | null;
  return row ? normalizeTrackerAgentMapping(row) : null;
}

export function getTrackerAgentMappingByExternalUser(
  provider: string,
  externalUserId: string,
): TrackerAgentMapping | null {
  const row = getDb()
    .query("SELECT * FROM tracker_agent_mapping WHERE provider = ? AND externalUserId = ?")
    .get(provider, externalUserId) as TrackerAgentMapping | null;
  return row ? normalizeTrackerAgentMapping(row) : null;
}

export function createTrackerAgentMapping(data: {
  provider: string;
  agentId: string;
  externalUserId: string;
  agentName: string;
}): TrackerAgentMapping {
  const result = getDb()
    .query(
      `INSERT INTO tracker_agent_mapping (provider, agentId, externalUserId, agentName)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    )
    .get(data.provider, data.agentId, data.externalUserId, data.agentName) as TrackerAgentMapping;
  return normalizeTrackerAgentMapping(result);
}

export function deleteTrackerAgentMapping(provider: string, agentId: string): void {
  getDb()
    .query("DELETE FROM tracker_agent_mapping WHERE provider = ? AND agentId = ?")
    .run(provider, agentId);
}

export function getAllTrackerAgentMappings(provider?: string): TrackerAgentMapping[] {
  if (provider) {
    return (
      getDb()
        .query("SELECT * FROM tracker_agent_mapping WHERE provider = ? ORDER BY createdAt DESC")
        .all(provider) as TrackerAgentMapping[]
    ).map(normalizeTrackerAgentMapping);
  }
  return (
    getDb()
      .query("SELECT * FROM tracker_agent_mapping ORDER BY createdAt DESC")
      .all() as TrackerAgentMapping[]
  ).map(normalizeTrackerAgentMapping);
}
