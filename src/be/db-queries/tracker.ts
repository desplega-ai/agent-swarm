import type { TrackerAgentMapping, TrackerSync } from "../../tracker/types";
import { getDb } from "../db";

// ── Tracker Sync ──

export function getTrackerSync(
  provider: string,
  entityType: "task" | "epic",
  swarmId: string,
): TrackerSync | null {
  return getDb()
    .query("SELECT * FROM tracker_sync WHERE provider = ? AND entityType = ? AND swarmId = ?")
    .get(provider, entityType, swarmId) as TrackerSync | null;
}

export function getTrackerSyncByExternalId(
  provider: string,
  entityType: "task" | "epic",
  externalId: string,
): TrackerSync | null {
  return getDb()
    .query("SELECT * FROM tracker_sync WHERE provider = ? AND entityType = ? AND externalId = ?")
    .get(provider, entityType, externalId) as TrackerSync | null;
}

export function createTrackerSync(data: {
  provider: string;
  entityType: "task" | "epic";
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
  return result;
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

export function getAllTrackerSyncs(provider?: string, entityType?: "task" | "epic"): TrackerSync[] {
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
  return getDb()
    .query(`SELECT * FROM tracker_sync ${where} ORDER BY createdAt DESC`)
    .all(...values) as TrackerSync[];
}

// ── Tracker Agent Mapping ──

export function getTrackerAgentMapping(
  provider: string,
  agentId: string,
): TrackerAgentMapping | null {
  return getDb()
    .query("SELECT * FROM tracker_agent_mapping WHERE provider = ? AND agentId = ?")
    .get(provider, agentId) as TrackerAgentMapping | null;
}

export function getTrackerAgentMappingByExternalUser(
  provider: string,
  externalUserId: string,
): TrackerAgentMapping | null {
  return getDb()
    .query("SELECT * FROM tracker_agent_mapping WHERE provider = ? AND externalUserId = ?")
    .get(provider, externalUserId) as TrackerAgentMapping | null;
}

export function createTrackerAgentMapping(data: {
  provider: string;
  agentId: string;
  externalUserId: string;
  agentName: string;
}): TrackerAgentMapping {
  return getDb()
    .query(
      `INSERT INTO tracker_agent_mapping (provider, agentId, externalUserId, agentName)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    )
    .get(data.provider, data.agentId, data.externalUserId, data.agentName) as TrackerAgentMapping;
}

export function deleteTrackerAgentMapping(provider: string, agentId: string): void {
  getDb()
    .query("DELETE FROM tracker_agent_mapping WHERE provider = ? AND agentId = ?")
    .run(provider, agentId);
}

export function getAllTrackerAgentMappings(provider?: string): TrackerAgentMapping[] {
  if (provider) {
    return getDb()
      .query("SELECT * FROM tracker_agent_mapping WHERE provider = ? ORDER BY createdAt DESC")
      .all(provider) as TrackerAgentMapping[];
  }
  return getDb()
    .query("SELECT * FROM tracker_agent_mapping ORDER BY createdAt DESC")
    .all() as TrackerAgentMapping[];
}
