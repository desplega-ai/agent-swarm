import type { SqlExecutor } from "../executor";
import { sql } from "../sql";

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
              ${r.instructionsHash}, ${r.skillKeys}, ${r.now})`);
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

  // ---- asset keys across resources ----

  async listUserCreatedKeys(userId: string, limit: number): Promise<string[]> {
    const rows = await this.db.query<{ key: string }>(sql`
      SELECT "key", MAX("createdAt") AS newest FROM (
        SELECT "key", "createdAt" FROM scheduled_tasks WHERE created_by = ${userId}
        UNION ALL SELECT "key", "createdAt" FROM pages WHERE created_by = ${userId}
        UNION ALL SELECT "key", "createdAt" FROM workflows WHERE created_by = ${userId}
      ) AS created GROUP BY "key" ORDER BY newest DESC, "key" LIMIT ${limit}`);
    return rows.map((row) => row.key);
  }
}
