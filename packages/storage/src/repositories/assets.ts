import type { SqlExecutor } from "../executor";

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

export interface AssetsRepository {
  /** Rows of each list come in insertion order. */
  readAssetKeyAuditData(): Promise<AssetKeyAuditData>;
  /** The subset of `ids` that name an existing user. */
  existingUserIds(ids: readonly string[]): Promise<Set<string>>;
}

export abstract class BaseAssetsRepository implements AssetsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  abstract readAssetKeyAuditData(): Promise<AssetKeyAuditData>;
  abstract existingUserIds(ids: readonly string[]): Promise<Set<string>>;
}
