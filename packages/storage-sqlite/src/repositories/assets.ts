import type { Database } from "bun:sqlite";
import {
  ASSET_KEY_TABLES,
  type AssetKeyAuditData,
  type AssetKeyRow,
  type AssetKeyTable,
  type AttachmentMappingAuditRow,
  BaseAssetsRepository,
  type ImportPendingAssignmentRow,
  type MappingSourceAuditRow,
  type SqlQuery,
  sql,
  sqlIdent,
  sqlList,
} from "@desplega/storage";
import { sqliteDialect } from "../dialect";

// The audit reads are shared by the async repository and by the synchronous
// SQLite start path (the startup audit runs inside initDb, before any request).

const keyRows = (table: AssetKeyTable): SqlQuery =>
  sql`SELECT id, "key" AS key FROM ${sqlIdent(table)} ORDER BY rowid`;

const attachmentMappings: SqlQuery = sql`
  SELECT
    a.id AS attachment_id,
    m.id AS mapping_id
  FROM task_attachments a
  JOIN agent_tasks t ON t.id = a.task_id
  LEFT JOIN asset_key_mappings m
    ON m.provider_id = COALESCE(NULLIF(a.provider_id, ''), 'agent-fs')
   AND m.provider_org_id = COALESCE(a.agent_fs_org_id, '')
   AND m.provider_drive_id = COALESCE(a.agent_fs_drive_id, '')
   AND m.provider_key = COALESCE(NULLIF(a.provider_key, ''), a.path)
  WHERE a.kind = 'agent-fs'
    AND COALESCE(NULLIF(a.provider_key, ''), a.path) IS NOT NULL
  ORDER BY a.rowid, m.rowid`;

const sourcedMappings: SqlQuery = sql`
  SELECT
    m.id AS mapping_id,
    m.source_entity_id,
    a.id AS attachment_id,
    t."key" AS task_key,
    m."key" AS mapping_key,
    CASE WHEN a.id IS NOT NULL
      AND m.provider_id = COALESCE(NULLIF(a.provider_id, ''), 'agent-fs')
      AND m.provider_org_id = COALESCE(a.agent_fs_org_id, '')
      AND m.provider_drive_id = COALESCE(a.agent_fs_drive_id, '')
      AND m.provider_key = COALESCE(NULLIF(a.provider_key, ''), a.path)
    THEN 1 ELSE 0 END AS tuple_matches
  FROM asset_key_mappings m
  LEFT JOIN task_attachments a ON a.id = m.source_entity_id
  LEFT JOIN agent_tasks t ON t.id = a.task_id
  WHERE m.source_entity_type = 'task-attachment'
  ORDER BY m.rowid`;

const USER_ID_CHUNK = 500;

const existingUsers = (ids: readonly string[]): SqlQuery =>
  sql`SELECT id FROM users WHERE id IN (${sqlList(ids)})`;

function chunks(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += USER_ID_CHUNK) {
    out.push(unique.slice(i, i + USER_ID_CHUNK));
  }
  return out;
}

function allSync<T>(database: Database, query: SqlQuery): T[] {
  const { text, params } = query.render(sqliteDialect);
  return database.prepare(text).all(...(params as never[])) as T[];
}

export class SqliteAssetsRepository extends BaseAssetsRepository {
  async readAssetKeyAuditData(): Promise<AssetKeyAuditData> {
    const rows: AssetKeyAuditData["keyRows"] = [];
    for (const table of ASSET_KEY_TABLES) {
      rows.push({ table, rows: await this.db.query<AssetKeyRow>(keyRows(table)) });
    }
    return {
      keyRows: rows,
      attachmentMappings: await this.db.query<AttachmentMappingAuditRow>(attachmentMappings),
      sourcedMappings: await this.db.query<MappingSourceAuditRow>(sourcedMappings),
    };
  }

  async existingUserIds(ids: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of chunks(ids)) {
      for (const row of await this.db.query<{ id: string }>(existingUsers(chunk))) {
        found.add(row.id);
      }
    }
    return found;
  }

  listPendingAssignmentsForAgent(
    agentId: string,
    agentName: string,
  ): Promise<ImportPendingAssignmentRow[]> {
    return this.db.query<ImportPendingAssignmentRow>(sql`
      SELECT "sourceId", "agentKey", instructions, "instructionsHash", "skillKeys"
        FROM import_pending_assignments
       WHERE "agentId" = ${agentId} OR "agentName" = ${agentName}
       ORDER BY rowid`);
  }

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

/** The audit reads on the synchronous SQLite start path. */
export function readAssetKeyAuditDataSync(database: Database): AssetKeyAuditData {
  return {
    keyRows: ASSET_KEY_TABLES.map((table) => ({
      table,
      rows: allSync<AssetKeyRow>(database, keyRows(table)),
    })),
    attachmentMappings: allSync<AttachmentMappingAuditRow>(database, attachmentMappings),
    sourcedMappings: allSync<MappingSourceAuditRow>(database, sourcedMappings),
  };
}

export function existingUserIdsSync(database: Database, ids: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const chunk of chunks(ids)) {
    for (const row of allSync<{ id: string }>(database, existingUsers(chunk))) found.add(row.id);
  }
  return found;
}
