import type { Database } from "bun:sqlite";
import { isCanonicalAssetKey, parseAssetKey } from "../assets/key";
import type { DbExecutor } from "./db-client";

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
  users: ReadonlySet<string>,
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
    if (!users.has(parsed.userId)) {
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
  mapping_id: string | null;
};

type MappingSourceAuditRow = {
  mapping_id: string;
  source_entity_id: string;
  attachment_id: string | null;
  task_key: string | null;
  mapping_key: string;
  tuple_matches: number;
};

const USERS_SQL = "SELECT id FROM users";

const ATTACHMENT_MAPPINGS_SQL = `SELECT
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
         AND COALESCE(NULLIF(a.provider_key, ''), a.path) IS NOT NULL`;
const MAPPING_SOURCES_SQL = `SELECT
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
       WHERE m.source_entity_type = 'task-attachment'`;

export function auditAssetKeys(db: Database): AssetKeyAuditResult {
  return auditRows(
    KEY_TABLES.map((table) => db.prepare<KeyRow, []>(table.sql).all()),
    new Set(
      db
        .query<{ id: string }, []>(USERS_SQL)
        .all()
        .map((row) => row.id),
    ),
    db.prepare<AttachmentMappingAuditRow, []>(ATTACHMENT_MAPPINGS_SQL).all(),
    db.prepare<MappingSourceAuditRow, []>(MAPPING_SOURCES_SQL).all(),
  );
}

/** Reads from the transaction's connection, including uncommitted changes. */
export async function auditAssetKeysAsync(tx: DbExecutor): Promise<AssetKeyAuditResult> {
  const tables: KeyRow[][] = [];
  for (const table of KEY_TABLES) tables.push(await tx.query<KeyRow>(table.sql));
  const users = new Set((await tx.query<{ id: string }>(USERS_SQL)).map((row) => row.id));
  return auditRows(
    tables,
    users,
    await tx.query<AttachmentMappingAuditRow>(ATTACHMENT_MAPPINGS_SQL),
    await tx.query<MappingSourceAuditRow>(MAPPING_SOURCES_SQL),
  );
}

function auditRows(
  tables: KeyRow[][],
  users: ReadonlySet<string>,
  attachmentMappings: AttachmentMappingAuditRow[],
  sourcedMappings: MappingSourceAuditRow[],
): AssetKeyAuditResult {
  const issues: AssetKeyAuditIssue[] = [];
  let checked = 0;

  for (const [index, table] of KEY_TABLES.entries()) {
    const rows = tables[index]!;
    checked += rows.length;
    for (const row of rows) issues.push(...auditKeyRow(users, table.entityType, row));
  }

  // One file has one mapping, which follows its source attachment (checked below). Other
  // tasks may attach the same file from any namespace, and a mapping detached from its
  // deleted source keeps its own namespace, so neither is drift.
  for (const row of attachmentMappings) {
    if (!row.mapping_id) {
      issues.push({
        severity: "warning",
        code: "missing-provider-mapping",
        entityType: "file",
        entityId: row.attachment_id,
        message: "Agent-fs attachment has no logical namespace mapping.",
      });
    }
  }

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
