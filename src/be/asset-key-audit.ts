import type { Database } from "bun:sqlite";
import { isCanonicalAssetKey, parseAssetKey } from "../assets/key";

export type AssetKeyAuditSeverity = "fatal" | "warning";
export type AssetKeyAuditCode =
  | "missing-key"
  | "noncanonical-key"
  | "unknown-personal-user"
  | "missing-provider-mapping"
  | "provider-mapping-drift";

export type AssetKeyAuditIssue = {
  severity: AssetKeyAuditSeverity;
  code: AssetKeyAuditCode;
  entityType: "task" | "workflow" | "schedule" | "page" | "app" | "script" | "file";
  entityId: string;
  message: string;
};

export type AssetKeyAuditResult = {
  ok: boolean;
  structuralValid: boolean;
  checked: number;
  fatalCount: number;
  warningCount: number;
  issues: AssetKeyAuditIssue[];
};

type KeyRow = { id: string; key: string | null };

const KEY_TABLES = [
  { entityType: "task", sql: 'SELECT id, "key" as key FROM agent_tasks' },
  { entityType: "workflow", sql: 'SELECT id, "key" as key FROM workflows' },
  { entityType: "schedule", sql: 'SELECT id, "key" as key FROM scheduled_tasks' },
  { entityType: "page", sql: 'SELECT id, "key" as key FROM pages' },
  { entityType: "app", sql: 'SELECT id, "key" as key FROM apps' },
  { entityType: "script", sql: 'SELECT id, "key" as key FROM scripts' },
  { entityType: "file", sql: 'SELECT id, "key" as key FROM asset_key_mappings' },
] as const;

function auditKeyRow(
  db: Database,
  entityType: AssetKeyAuditIssue["entityType"],
  row: KeyRow,
): AssetKeyAuditIssue[] {
  if (!row.key) {
    return [
      {
        severity: "fatal",
        code: "missing-key",
        entityType,
        entityId: row.id,
        message: "Asset key is missing or empty.",
      },
    ];
  }
  if (!isCanonicalAssetKey(row.key)) {
    return [
      {
        severity: "fatal",
        code: "noncanonical-key",
        entityType,
        entityId: row.id,
        message: "Asset key is not in canonical v1 form.",
      },
    ];
  }

  const parsed = parseAssetKey(row.key);
  if (parsed.root === "personal") {
    const user = db
      .prepare<{ present: number }, [string]>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id = ?) AS present",
      )
      .get(parsed.userId);
    if (!user?.present) {
      return [
        {
          severity: "warning",
          code: "unknown-personal-user",
          entityType,
          entityId: row.id,
          message: "Personal namespace references a user that no longer exists.",
        },
      ];
    }
  }
  return [];
}

type AttachmentMappingAuditRow = {
  attachment_id: string;
  task_key: string;
  mapping_id: string | null;
  mapping_key: string | null;
};

type MappingSourceAuditRow = {
  mapping_id: string;
  source_entity_id: string;
  attachment_id: string | null;
  task_key: string | null;
  mapping_key: string;
  tuple_matches: number;
};

export function auditAssetKeys(db: Database): AssetKeyAuditResult {
  const issues: AssetKeyAuditIssue[] = [];
  let checked = 0;

  for (const table of KEY_TABLES) {
    const rows = db.prepare<KeyRow, []>(table.sql).all();
    checked += rows.length;
    for (const row of rows) issues.push(...auditKeyRow(db, table.entityType, row));
  }

  const attachmentMappings = db
    .prepare<AttachmentMappingAuditRow, []>(
      `SELECT
         a.id AS attachment_id,
         t."key" AS task_key,
         m.id AS mapping_id,
         m."key" AS mapping_key
       FROM task_attachments a
       JOIN agent_tasks t ON t.id = a.task_id
       LEFT JOIN asset_key_mappings m
         ON m.provider_id = COALESCE(NULLIF(a.provider_id, ''), 'agent-fs')
        AND m.provider_org_id = COALESCE(a.agent_fs_org_id, '')
        AND m.provider_drive_id = COALESCE(a.agent_fs_drive_id, '')
        AND m.provider_key = COALESCE(NULLIF(a.provider_key, ''), a.path)
       WHERE a.kind = 'agent-fs'
         AND COALESCE(NULLIF(a.provider_key, ''), a.path) IS NOT NULL`,
    )
    .all();
  for (const row of attachmentMappings) {
    if (!row.mapping_id) {
      issues.push({
        severity: "warning",
        code: "missing-provider-mapping",
        entityType: "file",
        entityId: row.attachment_id,
        message: "Agent-fs attachment has no logical namespace mapping.",
      });
    } else if (row.mapping_key !== row.task_key) {
      issues.push({
        severity: "warning",
        code: "provider-mapping-drift",
        entityType: "file",
        entityId: row.mapping_id,
        message: "Provider mapping namespace differs from its parent task namespace.",
      });
    }
  }

  const sourcedMappings = db
    .prepare<MappingSourceAuditRow, []>(
      `SELECT
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
       WHERE m.source_entity_type = 'task-attachment'`,
    )
    .all();
  for (const row of sourcedMappings) {
    if (!row.attachment_id || row.tuple_matches !== 1 || row.task_key !== row.mapping_key) {
      issues.push({
        severity: "warning",
        code: "provider-mapping-drift",
        entityType: "file",
        entityId: row.mapping_id,
        message: "Provider mapping source or tuple has drifted from its attachment.",
      });
    }
  }

  const fatalCount = issues.filter((issue) => issue.severity === "fatal").length;
  const warningCount = issues.length - fatalCount;
  return {
    ok: issues.length === 0,
    structuralValid: fatalCount === 0,
    checked,
    fatalCount,
    warningCount,
    issues,
  };
}

export function enforceAssetKeyStartupAudit(db: Database): AssetKeyAuditResult {
  const result = auditAssetKeys(db);
  if (result.warningCount > 0) {
    console.warn(`[asset-keys] Startup audit found ${result.warningCount} repairable warning(s)`);
  }
  if (result.structuralValid) return result;

  const message = `[asset-keys] Startup audit found ${result.fatalCount} structurally invalid row(s)`;
  if (process.env.ASSET_KEY_AUDIT_DISABLE_STARTUP_HARD_FAIL === "true") {
    console.warn(`${message}; hard-fail temporarily disabled`);
    return result;
  }
  throw new Error(message);
}
