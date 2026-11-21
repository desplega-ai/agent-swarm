import type { Database } from "bun:sqlite";
import type { AssetKeyAuditData, AssetKeyTable } from "@desplega/storage";
import { isCanonicalAssetKey, parseAssetKey } from "../assets/key";
import { getStorage } from "./storage";
import { existingUserIdsSync, readAssetKeyAuditDataSync } from "./storage-root";

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

const ENTITY_TYPES: Record<AssetKeyTable, AssetKeyAuditIssue["entityType"]> = {
  agent_tasks: "task",
  workflows: "workflow",
  scheduled_tasks: "schedule",
  pages: "page",
  apps: "app",
  scripts: "script",
  asset_key_mappings: "file",
};

function auditKeyRow(
  existingUsers: ReadonlySet<string>,
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
    if (!existingUsers.has(parsed.userId)) {
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

/** User ids that personal-namespace keys name, for one existence lookup. */
function personalUserIds(data: AssetKeyAuditData): string[] {
  const ids: string[] = [];
  for (const { rows } of data.keyRows) {
    for (const row of rows) {
      if (!row.key || !isCanonicalAssetKey(row.key)) continue;
      const parsed = parseAssetKey(row.key);
      if (parsed.root === "personal") ids.push(parsed.userId);
    }
  }
  return ids;
}

/** The audit over a database handle on the synchronous SQLite start path. */
export function auditAssetKeys(db: Database): AssetKeyAuditResult {
  const data = readAssetKeyAuditDataSync(db);
  return evaluateAssetKeyAudit(data, existingUserIdsSync(db, personalUserIds(data)));
}

/** The audit through the storage repositories (any engine). */
export async function auditAssetKeysAsync(): Promise<AssetKeyAuditResult> {
  const assets = getStorage().repos.assets;
  const data = await assets.readAssetKeyAuditData();
  return evaluateAssetKeyAudit(data, await assets.existingUserIds(personalUserIds(data)));
}

function evaluateAssetKeyAudit(
  data: AssetKeyAuditData,
  existingUsers: ReadonlySet<string>,
): AssetKeyAuditResult {
  const issues: AssetKeyAuditIssue[] = [];
  let checked = 0;

  for (const { table, rows } of data.keyRows) {
    checked += rows.length;
    for (const row of rows as KeyRow[]) {
      issues.push(...auditKeyRow(existingUsers, ENTITY_TYPES[table], row));
    }
  }

  const { attachmentMappings, sourcedMappings } = data;
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
  return enforceStartupAuditResult(auditAssetKeys(db));
}

/** The startup audit through the storage repositories (the Postgres start). */
export async function enforceAssetKeyStartupAuditAsync(): Promise<AssetKeyAuditResult> {
  return enforceStartupAuditResult(await auditAssetKeysAsync());
}

function enforceStartupAuditResult(result: AssetKeyAuditResult): AssetKeyAuditResult {
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
