import { isoTimestampText, jsonText, likeAsciiCi } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlIdent, sqlJoin } from "../sql";

/**
 * Domain: assets and import (`asset_key_mappings`, `asset_key_history`,
 * `import_items`, `import_pending_assignments`), plus the reads of the asset
 * key audit, which walks the `key` column of every keyed table.
 */

/** The tables whose rows carry an asset key, in audit order. */
export const ASSET_KEY_TABLES = [
  "agent_tasks",
  "workflows",
  "scheduled_tasks",
  "pages",
  "apps",
  "scripts",
  "asset_key_mappings",
] as const;
export type AssetKeyTable = (typeof ASSET_KEY_TABLES)[number];

export type AssetKeyRow = { id: string; key: string | null };

export type AttachmentMappingAuditRow = { attachment_id: string; mapping_id: string | null };

export type MappingSourceAuditRow = {
  mapping_id: string;
  source_entity_id: string;
  attachment_id: string | null;
  task_key: string | null;
  mapping_key: string;
  /** 1 when the mapping's provider tuple equals its attachment's, else 0. */
  tuple_matches: number;
};

/** Everything the asset key audit reads, except user existence. */
export type AssetKeyAuditData = {
  /** One entry per `ASSET_KEY_TABLES` table, in that order. */
  keyRows: { table: AssetKeyTable; rows: AssetKeyRow[] }[];
  /** Agent-fs attachments with their logical mapping, if any. */
  attachmentMappings: AttachmentMappingAuditRow[];
  /** Mappings sourced from a task attachment, with the drift inputs. */
  sourcedMappings: MappingSourceAuditRow[];
};

export type NewImportItem = {
  sourceId: string;
  kind: string;
  itemKey: string;
  entityId: string;
  now: string;
};

export type ImportPendingAssignmentRow = {
  sourceId: string;
  agentKey: string;
  instructions: string | null;
  instructionsHash: string | null;
  /** JSON array text. */
  skillKeys: string;
};

export type NewImportPendingAssignment = {
  sourceId: string;
  agentKey: string;
  agentId: string | null;
  agentName: string | null;
  instructions: string | null;
  instructionsHash: string | null;
  /** JSON array text. */
  skillKeys: string;
  now: string;
};

/** One `asset_key_mappings` row (org and drive ids are '' when absent). */
export type AssetKeyMappingRow = {
  id: string;
  provider_id: string;
  provider_org_id: string;
  provider_drive_id: string;
  provider_key: string;
  key: string;
  source_entity_type: string | null;
  source_entity_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

/** The entity kinds that carry an asset namespace `key`. */
export type AssetEntityKind = "task" | "workflow" | "schedule" | "page" | "app" | "script" | "file";

/** One row of the cross-entity asset summary. */
export type AssetSummaryRow = {
  entityType: string;
  id: string;
  key: string;
  label: string;
  updatedAt: string;
  providerId: string | null;
  providerOrgId: string | null;
  providerDriveId: string | null;
  providerKey: string | null;
};

const ASSET_SUMMARY_SELECTS: Record<AssetEntityKind, SqlQuery> = {
  task: sql`SELECT 'task' AS "entityType", id, "key", 'Task ' || substr(id, 1, 8) AS label,
    ${isoTimestampText(sql`"lastUpdatedAt"`)} AS "updatedAt", NULL AS "providerId", NULL AS "providerOrgId",
    NULL AS "providerDriveId", NULL AS "providerKey"
    FROM agent_tasks`,
  workflow: sql`SELECT 'workflow' AS "entityType", id, "key", name AS label,
    "lastUpdatedAt" AS "updatedAt", NULL AS "providerId", NULL AS "providerOrgId",
    NULL AS "providerDriveId", NULL AS "providerKey"
    FROM workflows`,
  schedule: sql`SELECT 'schedule' AS "entityType", id, "key", name AS label,
    ${isoTimestampText(sql`"lastUpdatedAt"`)} AS "updatedAt", NULL AS "providerId", NULL AS "providerOrgId",
    NULL AS "providerDriveId", NULL AS "providerKey"
    FROM scheduled_tasks`,
  page: sql`SELECT 'page' AS "entityType", id, "key", title AS label,
    "updatedAt", NULL AS "providerId", NULL AS "providerOrgId",
    NULL AS "providerDriveId", NULL AS "providerKey"
    FROM pages`,
  app: sql`SELECT 'app' AS "entityType", id, "key", name AS label,
    ${isoTimestampText(sql`updated_at`)} AS "updatedAt", NULL AS "providerId", NULL AS "providerOrgId",
    NULL AS "providerDriveId", NULL AS "providerKey"
    FROM apps`,
  script: sql`SELECT 'script' AS "entityType", id, "key", name AS label,
    ${isoTimestampText(sql`"updatedAt"`)} AS "updatedAt", NULL AS "providerId", NULL AS "providerOrgId",
    NULL AS "providerDriveId", NULL AS "providerKey"
    FROM scripts`,
  file: sql`SELECT 'file' AS "entityType", id, "key", provider_key AS label,
    ${isoTimestampText(sql`updated_at`)} AS "updatedAt", provider_id AS "providerId",
    NULLIF(provider_org_id, '') AS "providerOrgId",
    NULLIF(provider_drive_id, '') AS "providerDriveId",
    provider_key AS "providerKey"
    FROM asset_key_mappings`,
};

const ASSET_TABLES: Record<AssetEntityKind, string> = {
  task: "agent_tasks",
  workflow: "workflows",
  schedule: "scheduled_tasks",
  page: "pages",
  app: "apps",
  script: "scripts",
  file: "asset_key_mappings",
};

export interface AssetsRepository {
  /** Rows of each list come in insertion order. */
  readAssetKeyAuditData(): Promise<AssetKeyAuditData>;
  /** The subset of `ids` that name an existing user. */
  existingUserIds(ids: readonly string[]): Promise<Set<string>>;

  // ---- import_items ----
  /** The entity a source item owns, or null. */
  findImportedEntityId(sourceId: string, kind: string, itemKey: string): Promise<string | null>;
  /** True when any import source owns `entityId` of `kind`. */
  isImportedEntity(kind: string, entityId: string): Promise<boolean>;
  /** Records (or moves) the ownership of a source item; keeps `createdAt` on conflict. */
  upsertImportItem(row: NewImportItem): Promise<void>;

  // ---- import_pending_assignments ----
  deletePendingAssignmentsBySource(sourceId: string): Promise<void>;
  insertPendingAssignment(row: NewImportPendingAssignment): Promise<void>;
  /** Pending rows naming the agent by id or by name. Insertion order. */
  listPendingAssignmentsForAgent(
    agentId: string,
    agentName: string,
  ): Promise<ImportPendingAssignmentRow[]>;
  deletePendingAssignment(sourceId: string, agentKey: string): Promise<void>;
  // ---- asset_key_history ----
  insertAssetKeyHistory(row: {
    id: string;
    entity_type: string;
    entity_id: string;
    previous_key: string | null;
    new_key: string;
    changed_by: string | null;
  }): Promise<void>;

  // ---- asset_key_mappings ----
  findAssetKeyMappingByProvider(t: {
    providerId: string;
    providerOrgId: string;
    providerDriveId: string;
    providerKey: string;
  }): Promise<AssetKeyMappingRow | null>;
  findAssetKeyMapping(id: string): Promise<AssetKeyMappingRow | null>;
  insertAssetKeyMapping(row: AssetKeyMappingRow): Promise<AssetKeyMappingRow | null>;
  updateAssetKeyMapping(
    id: string,
    u: Pick<
      AssetKeyMappingRow,
      "key" | "source_entity_type" | "source_entity_id" | "updated_at" | "updated_by"
    >,
  ): Promise<AssetKeyMappingRow | null>;

  // ---- cross-entity namespaces ----
  /**
   * Every keyed entity of `types` (key in the LIKE `keyPattern`, `\` escapes):
   * by key, then newest update; rows that tie on both come in no fixed order.
   */
  listAssetSummaries(
    types: readonly AssetEntityKind[],
    keyPattern: string | null,
    limit: number,
  ): Promise<AssetSummaryRow[]>;
  findAssetKey(kind: AssetEntityKind, id: string): Promise<string | null>;
  /** Sets the key of a non-task entity with its update time and audit columns. */
  setAssetKey(
    kind: Exclude<AssetEntityKind, "task">,
    id: string,
    m: { key: string; now: string; changedBy: string | null; changedByAgentId: string | null },
  ): Promise<void>;

  // ---- asset keys across resources ----
  /**
   * Distinct asset keys of the schedules, pages and workflows `userId`
   * created, newest first by the latest `createdAt` per key, then by key.
   * At most `limit` keys.
   */
  listUserCreatedKeys(userId: string, limit: number): Promise<string[]>;
}

export abstract class BaseAssetsRepository implements AssetsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  abstract readAssetKeyAuditData(): Promise<AssetKeyAuditData>;
  abstract existingUserIds(ids: readonly string[]): Promise<Set<string>>;

  // ---- import_items ----

  async findImportedEntityId(
    sourceId: string,
    kind: string,
    itemKey: string,
  ): Promise<string | null> {
    const row = await this.db.get<{ entityId: string }>(sql`
      SELECT "entityId" FROM import_items
       WHERE "sourceId" = ${sourceId} AND kind = ${kind} AND "itemKey" = ${itemKey}`);
    return row?.entityId ?? null;
  }

  async isImportedEntity(kind: string, entityId: string): Promise<boolean> {
    const row = await this.db.get<{ n: number }>(
      sql`SELECT 1 AS n FROM import_items WHERE kind = ${kind} AND "entityId" = ${entityId} LIMIT 1`,
    );
    return row !== null;
  }

  async upsertImportItem(r: NewImportItem): Promise<void> {
    await this.db.run(sql`
      INSERT INTO import_items ("sourceId", kind, "itemKey", "entityId", "createdAt", "updatedAt")
      VALUES (${r.sourceId}, ${r.kind}, ${r.itemKey}, ${r.entityId}, ${r.now}, ${r.now})
      ON CONFLICT ("sourceId", kind, "itemKey") DO UPDATE SET
        "entityId" = excluded."entityId", "updatedAt" = excluded."updatedAt"`);
  }

  // ---- import_pending_assignments ----

  async deletePendingAssignmentsBySource(sourceId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM import_pending_assignments WHERE "sourceId" = ${sourceId}`);
  }

  async insertPendingAssignment(r: NewImportPendingAssignment): Promise<void> {
    await this.db.run(sql`
      INSERT INTO import_pending_assignments
        ("sourceId", "agentKey", "agentId", "agentName", instructions, "instructionsHash", "skillKeys", "createdAt")
      VALUES (${r.sourceId}, ${r.agentKey}, ${r.agentId}, ${r.agentName}, ${r.instructions},
              ${r.instructionsHash}, ${jsonText(r.skillKeys)}, ${r.now})`);
  }

  /** Insertion order differs per engine (SQLite `rowid`). */
  abstract listPendingAssignmentsForAgent(
    agentId: string,
    agentName: string,
  ): Promise<ImportPendingAssignmentRow[]>;

  async deletePendingAssignment(sourceId: string, agentKey: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM import_pending_assignments
       WHERE "sourceId" = ${sourceId} AND "agentKey" = ${agentKey}`);
  }

  // ---- asset_key_history ----

  async insertAssetKeyHistory(r: {
    id: string;
    entity_type: string;
    entity_id: string;
    previous_key: string | null;
    new_key: string;
    changed_by: string | null;
  }): Promise<void> {
    await this.db.run(sql`
      INSERT INTO asset_key_history (id, entity_type, entity_id, previous_key, new_key, changed_by)
      VALUES (${r.id}, ${r.entity_type}, ${r.entity_id}, ${r.previous_key}, ${r.new_key}, ${r.changed_by})`);
  }

  // ---- asset_key_mappings ----

  findAssetKeyMappingByProvider(t: {
    providerId: string;
    providerOrgId: string;
    providerDriveId: string;
    providerKey: string;
  }): Promise<AssetKeyMappingRow | null> {
    return this.db.get<AssetKeyMappingRow>(sql`
      SELECT * FROM asset_key_mappings
      WHERE provider_id = ${t.providerId} AND provider_org_id = ${t.providerOrgId}
        AND provider_drive_id = ${t.providerDriveId} AND provider_key = ${t.providerKey}`);
  }

  findAssetKeyMapping(id: string): Promise<AssetKeyMappingRow | null> {
    return this.db.get<AssetKeyMappingRow>(sql`SELECT * FROM asset_key_mappings WHERE id = ${id}`);
  }

  insertAssetKeyMapping(r: AssetKeyMappingRow): Promise<AssetKeyMappingRow | null> {
    return this.db.get<AssetKeyMappingRow>(sql`
      INSERT INTO asset_key_mappings (
        id, provider_id, provider_org_id, provider_drive_id, provider_key,
        "key", source_entity_type, source_entity_id,
        created_at, updated_at, created_by, updated_by
      ) VALUES (${r.id}, ${r.provider_id}, ${r.provider_org_id}, ${r.provider_drive_id},
        ${r.provider_key}, ${r.key}, ${r.source_entity_type}, ${r.source_entity_id}, ${r.created_at},
        ${r.updated_at}, ${r.created_by}, ${r.updated_by})
      RETURNING *`);
  }

  updateAssetKeyMapping(
    id: string,
    u: Pick<
      AssetKeyMappingRow,
      "key" | "source_entity_type" | "source_entity_id" | "updated_at" | "updated_by"
    >,
  ): Promise<AssetKeyMappingRow | null> {
    return this.db.get<AssetKeyMappingRow>(sql`
      UPDATE asset_key_mappings
      SET "key" = ${u.key}, source_entity_type = ${u.source_entity_type},
        source_entity_id = ${u.source_entity_id}, updated_at = ${u.updated_at},
        updated_by = ${u.updated_by}
      WHERE id = ${id} RETURNING *`);
  }

  // ---- cross-entity namespaces ----

  listAssetSummaries(
    types: readonly AssetEntityKind[],
    keyPattern: string | null,
    limit: number,
  ): Promise<AssetSummaryRow[]> {
    if (types.length === 0) return Promise.resolve([]);
    const union = sqlJoin(
      types.map((type) => ASSET_SUMMARY_SELECTS[type]),
      sql` UNION ALL `,
    );
    const where = keyPattern
      ? sql` WHERE ${likeAsciiCi(sql`"key"`, sql`${keyPattern}`, "\\")}`
      : EMPTY;
    return this.db.query<AssetSummaryRow>(sql`
      SELECT * FROM (${union}) AS assets${where}
      ORDER BY "key" ASC, "updatedAt" DESC LIMIT ${limit}`);
  }

  async findAssetKey(kind: AssetEntityKind, id: string): Promise<string | null> {
    const row = await this.db.get<{ key: string }>(
      sql`SELECT "key" AS key FROM ${sqlIdent(ASSET_TABLES[kind])} WHERE id = ${id}`,
    );
    return row?.key ?? null;
  }

  async setAssetKey(
    kind: Exclude<AssetEntityKind, "task">,
    id: string,
    m: { key: string; now: string; changedBy: string | null; changedByAgentId: string | null },
  ): Promise<void> {
    switch (kind) {
      case "workflow":
        await this.db.run(sql`
          UPDATE workflows SET "key" = ${m.key}, "lastUpdatedAt" = ${m.now}, updated_by = ${m.changedBy},
            "updatedByAgentId" = ${m.changedByAgentId}
          WHERE id = ${id}`);
        return;
      case "schedule":
        await this.db.run(sql`
          UPDATE scheduled_tasks SET "key" = ${m.key}, "lastUpdatedAt" = ${m.now},
            updated_by = ${m.changedBy}, "updatedByAgentId" = ${m.changedByAgentId}
          WHERE id = ${id}`);
        return;
      case "page":
        await this.db.run(sql`
          UPDATE pages SET "key" = ${m.key}, "updatedAt" = ${m.now}, updated_by = ${m.changedBy}
          WHERE id = ${id}`);
        return;
      case "app":
        await this.db.run(
          sql`UPDATE apps SET "key" = ${m.key}, updated_at = ${m.now} WHERE id = ${id}`,
        );
        return;
      case "script":
        await this.db.run(sql`
          UPDATE scripts SET "key" = ${m.key}, "updatedAt" = ${m.now}, updated_by = ${m.changedBy},
            "updatedByAgentId" = ${m.changedByAgentId}
          WHERE id = ${id}`);
        return;
      case "file":
        await this.db.run(sql`
          UPDATE asset_key_mappings SET "key" = ${m.key}, updated_at = ${m.now}, updated_by = ${m.changedBy}
          WHERE id = ${id}`);
        return;
    }
  }

  // ---- asset keys across resources ----

  /**
   * Engine-specific: the three `createdAt` columns are stored text on SQLite
   * (compared as text, mixed formats included) and typed differently on other
   * engines, so the union needs each engine's text rendering.
   */
  abstract listUserCreatedKeys(userId: string, limit: number): Promise<string[]>;
}
