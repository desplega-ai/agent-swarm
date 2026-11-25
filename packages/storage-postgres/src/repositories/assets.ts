import {
  ASSET_KEY_TABLES,
  type AssetKeyAuditData,
  type AssetKeyRow,
  type AttachmentMappingAuditRow,
  BaseAssetsRepository,
  type ImportPendingAssignmentRow,
  jsonText,
  type MappingSourceAuditRow,
  sql,
  sqlIdent,
} from "@desplega/storage";

// The same reads as the SQLite repository, with `_rowid` for the insertion
// order. Postgres has no synchronous start path: the startup audit calls
// these async methods.

const attachmentMappings = sql`
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
  ORDER BY a."_rowid", m."_rowid" NULLS FIRST`;

const sourcedMappings = sql`
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
  ORDER BY m."_rowid"`;

export class PostgresAssetsRepository extends BaseAssetsRepository {
  async readAssetKeyAuditData(): Promise<AssetKeyAuditData> {
    const rows: AssetKeyAuditData["keyRows"] = [];
    for (const table of ASSET_KEY_TABLES) {
      rows.push({
        table,
        rows: await this.db.query<AssetKeyRow>(
          sql`SELECT id, "key" AS key FROM ${sqlIdent(table)} ORDER BY "_rowid"`,
        ),
      });
    }
    return {
      keyRows: rows,
      attachmentMappings: await this.db.query<AttachmentMappingAuditRow>(attachmentMappings),
      sourcedMappings: await this.db.query<MappingSourceAuditRow>(sourcedMappings),
    };
  }

  /** One statement: the ids travel as one JSON array, so no bound-variable limit applies. */
  async existingUserIds(ids: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM users WHERE id IN (SELECT jsonb_array_elements_text(${jsonText(JSON.stringify(unique))}))`,
    );
    return new Set(rows.map((row) => row.id));
  }

  listPendingAssignmentsForAgent(
    agentId: string,
    agentName: string,
  ): Promise<ImportPendingAssignmentRow[]> {
    return this.db.query<ImportPendingAssignmentRow>(sql`
      SELECT "sourceId", "agentKey", instructions, "instructionsHash", "skillKeys"
        FROM import_pending_assignments
       WHERE "agentId" = ${agentId} OR "agentName" = ${agentName}
       ORDER BY "_rowid"`);
  }

  /**
   * SQLite compares the stored text: scheduled_tasks keeps ISO with ms and Z,
   * pages the space format, workflows is text (mixed formats) already. Each
   * timestamptz column is rendered in its SQLite text so MAX and the order
   * compare the same strings (byte order, C collation).
   */
  async listUserCreatedKeys(userId: string, limit: number): Promise<string[]> {
    const rows = await this.db.query<{ key: string }>(sql`
      SELECT "key", MAX("createdAt") AS newest FROM (
        SELECT "key", to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
          FROM scheduled_tasks WHERE created_by = ${userId}
        UNION ALL SELECT "key", to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
          FROM pages WHERE created_by = ${userId}
        UNION ALL SELECT "key", "createdAt" FROM workflows WHERE created_by = ${userId}
      ) AS created GROUP BY "key" ORDER BY newest DESC, "key" LIMIT ${limit}`);
    return rows.map((row) => row.key);
  }
}
