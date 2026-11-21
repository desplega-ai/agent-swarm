import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql, sqlJoin, sqlWhere } from "../sql";

/**
 * Domain: trackers (`tracker_sync`, `tracker_agent_mapping`). Rows come back in the SQLite value shape
 * on every engine (timestamps as the text the column stores).
 */

export type TrackerSyncRow = {
  id: string;
  provider: string;
  entityType: string;
  providerEntityType: string | null;
  swarmId: string;
  externalId: string;
  externalIdentifier: string | null;
  externalUrl: string | null;
  lastSyncedAt: string;
  lastSyncOrigin: string | null;
  lastDeliveryId: string | null;
  syncDirection: string;
  createdAt: string;
};

export type NewTrackerSync = {
  provider: string;
  entityType: string;
  providerEntityType: string | null;
  swarmId: string;
  externalId: string;
  externalIdentifier: string | null;
  externalUrl: string | null;
  lastSyncOrigin: string | null;
  lastDeliveryId: string | null;
  syncDirection: string;
};

/** Columns an update may set. `undefined` leaves a column unchanged. */
export type TrackerSyncUpdate = {
  lastSyncedAt?: string | null;
  lastSyncOrigin?: string | null;
  lastDeliveryId?: string | null;
  syncDirection?: string | null;
  externalUrl?: string | null;
  externalIdentifier?: string | null;
};

export type TrackerAgentMappingRow = {
  id: string;
  provider: string;
  agentId: string;
  externalUserId: string;
  agentName: string | null;
  createdAt: string;
};

export interface TrackersRepository {
  findSync(provider: string, entityType: string, swarmId: string): Promise<TrackerSyncRow | null>;
  findSyncByExternalId(
    provider: string,
    entityType: string,
    externalId: string,
  ): Promise<TrackerSyncRow | null>;
  /** Inserts the row; null when `(provider, entityType, externalId)` already has one. */
  insertSyncIfAbsent(row: NewTrackerSync): Promise<TrackerSyncRow | null>;
  insertSync(row: NewTrackerSync): Promise<TrackerSyncRow>;
  setSyncSwarmId(id: string, swarmId: string): Promise<void>;
  /** Moves every row of `oldSwarmId` to `newSwarmId`; returns the count. */
  repointSyncSwarmId(oldSwarmId: string, newSwarmId: string): Promise<number>;
  updateSync(id: string, update: TrackerSyncUpdate): Promise<void>;
  deleteSync(id: string): Promise<boolean>;
  hasDelivery(provider: string, deliveryId: string): Promise<boolean>;
  markDelivery(
    provider: string,
    entityType: string,
    externalId: string,
    deliveryId: string,
  ): Promise<void>;
  /** Order: `createdAt` descending, then insertion. */
  listSyncs(filters: { provider?: string; entityType?: string }): Promise<TrackerSyncRow[]>;

  findAgentMapping(provider: string, agentId: string): Promise<TrackerAgentMappingRow | null>;
  findAgentMappingByExternalUser(
    provider: string,
    externalUserId: string,
  ): Promise<TrackerAgentMappingRow | null>;
  insertAgentMapping(row: {
    provider: string;
    agentId: string;
    externalUserId: string;
    agentName: string;
  }): Promise<TrackerAgentMappingRow>;
  deleteAgentMapping(provider: string, agentId: string): Promise<void>;
  /** Order: `createdAt` descending, then insertion. */
  listAgentMappings(provider?: string): Promise<TrackerAgentMappingRow[]>;
}

export abstract class BaseTrackersRepository implements TrackersRepository {
  constructor(protected readonly db: SqlExecutor) {}

  findSync(provider: string, entityType: string, swarmId: string): Promise<TrackerSyncRow | null> {
    return this.db.get<TrackerSyncRow>(sql`
      SELECT * FROM tracker_sync
      WHERE provider = ${provider} AND "entityType" = ${entityType} AND "swarmId" = ${swarmId}`);
  }

  findSyncByExternalId(
    provider: string,
    entityType: string,
    externalId: string,
  ): Promise<TrackerSyncRow | null> {
    return this.db.get<TrackerSyncRow>(sql`
      SELECT * FROM tracker_sync
      WHERE provider = ${provider} AND "entityType" = ${entityType} AND "externalId" = ${externalId}`);
  }

  private syncValues(row: NewTrackerSync): SqlQuery {
    return sql`(${row.provider}, ${row.entityType}, ${row.providerEntityType}, ${row.swarmId},
      ${row.externalId}, ${row.externalIdentifier}, ${row.externalUrl}, ${row.lastSyncOrigin},
      ${row.lastDeliveryId}, ${row.syncDirection})`;
  }

  insertSyncIfAbsent(row: NewTrackerSync): Promise<TrackerSyncRow | null> {
    return this.db.get<TrackerSyncRow>(sql`
      INSERT INTO tracker_sync (provider, "entityType", "providerEntityType", "swarmId", "externalId",
        "externalIdentifier", "externalUrl", "lastSyncOrigin", "lastDeliveryId", "syncDirection")
      VALUES ${this.syncValues(row)}
      ON CONFLICT (provider, "entityType", "externalId") DO NOTHING
      RETURNING *`);
  }

  async insertSync(row: NewTrackerSync): Promise<TrackerSyncRow> {
    const inserted = await this.db.get<TrackerSyncRow>(sql`
      INSERT INTO tracker_sync (provider, "entityType", "providerEntityType", "swarmId", "externalId",
        "externalIdentifier", "externalUrl", "lastSyncOrigin", "lastDeliveryId", "syncDirection")
      VALUES ${this.syncValues(row)}
      RETURNING *`);
    return inserted as TrackerSyncRow;
  }

  async setSyncSwarmId(id: string, swarmId: string): Promise<void> {
    await this.db.run(sql`UPDATE tracker_sync SET "swarmId" = ${swarmId} WHERE id = ${id}`);
  }

  async repointSyncSwarmId(oldSwarmId: string, newSwarmId: string): Promise<number> {
    const result = await this.db.run(
      sql`UPDATE tracker_sync SET "swarmId" = ${newSwarmId} WHERE "swarmId" = ${oldSwarmId}`,
    );
    return Number(result.changes ?? 0);
  }

  async updateSync(id: string, update: TrackerSyncUpdate): Promise<void> {
    const sets: SqlQuery[] = [];
    if (update.lastSyncedAt !== undefined) sets.push(sql`"lastSyncedAt" = ${update.lastSyncedAt}`);
    if (update.lastSyncOrigin !== undefined)
      sets.push(sql`"lastSyncOrigin" = ${update.lastSyncOrigin}`);
    if (update.lastDeliveryId !== undefined)
      sets.push(sql`"lastDeliveryId" = ${update.lastDeliveryId}`);
    if (update.syncDirection !== undefined)
      sets.push(sql`"syncDirection" = ${update.syncDirection}`);
    if (update.externalUrl !== undefined) sets.push(sql`"externalUrl" = ${update.externalUrl}`);
    if (update.externalIdentifier !== undefined)
      sets.push(sql`"externalIdentifier" = ${update.externalIdentifier}`);
    if (sets.length === 0) return;
    await this.db.run(sql`UPDATE tracker_sync SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id}`);
  }

  async deleteSync(id: string): Promise<boolean> {
    const result = await this.db.run(sql`DELETE FROM tracker_sync WHERE id = ${id}`);
    return result.changes > 0;
  }

  async hasDelivery(provider: string, deliveryId: string): Promise<boolean> {
    const row = await this.db.get<{ hit: number }>(sql`
      SELECT 1 AS hit FROM tracker_sync
      WHERE provider = ${provider} AND "lastDeliveryId" = ${deliveryId} LIMIT 1`);
    return !!row;
  }

  async markDelivery(
    provider: string,
    entityType: string,
    externalId: string,
    deliveryId: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE tracker_sync SET "lastDeliveryId" = ${deliveryId}
      WHERE provider = ${provider} AND "entityType" = ${entityType} AND "externalId" = ${externalId}`);
  }

  abstract listSyncs(filters: {
    provider?: string;
    entityType?: string;
  }): Promise<TrackerSyncRow[]>;

  protected syncFilters(filters: { provider?: string; entityType?: string }): SqlQuery {
    const conditions: SqlQuery[] = [];
    if (filters.provider) conditions.push(sql`provider = ${filters.provider}`);
    if (filters.entityType) conditions.push(sql`"entityType" = ${filters.entityType}`);
    return sqlWhere(conditions);
  }

  findAgentMapping(provider: string, agentId: string): Promise<TrackerAgentMappingRow | null> {
    return this.db.get<TrackerAgentMappingRow>(sql`
      SELECT * FROM tracker_agent_mapping WHERE provider = ${provider} AND "agentId" = ${agentId}`);
  }

  findAgentMappingByExternalUser(
    provider: string,
    externalUserId: string,
  ): Promise<TrackerAgentMappingRow | null> {
    return this.db.get<TrackerAgentMappingRow>(sql`
      SELECT * FROM tracker_agent_mapping
      WHERE provider = ${provider} AND "externalUserId" = ${externalUserId}`);
  }

  async insertAgentMapping(row: {
    provider: string;
    agentId: string;
    externalUserId: string;
    agentName: string;
  }): Promise<TrackerAgentMappingRow> {
    const inserted = await this.db.get<TrackerAgentMappingRow>(sql`
      INSERT INTO tracker_agent_mapping (provider, "agentId", "externalUserId", "agentName")
      VALUES (${row.provider}, ${row.agentId}, ${row.externalUserId}, ${row.agentName})
      RETURNING *`);
    return inserted as TrackerAgentMappingRow;
  }

  async deleteAgentMapping(provider: string, agentId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM tracker_agent_mapping WHERE provider = ${provider} AND "agentId" = ${agentId}`);
  }

  abstract listAgentMappings(provider?: string): Promise<TrackerAgentMappingRow[]>;
}
