import type {
  Extension,
  ExtensionManifest,
  ExtensionRun,
  ExtensionStatus,
  ExtensionVersion,
} from "../../types";
import { computeContentHash, getDbClient } from "../db";

type ExtensionRow = Omit<Extension, "enabled"> & { enabled: number };
type ExtensionVersionRow = ExtensionVersion;
type ExtensionRunRow = ExtensionRun;

export type InstallExtensionArgs = {
  manifest: ExtensionManifest;
  files: Record<string, string>;
  priority?: number;
  config?: Record<string, unknown>;
  agentId?: string | null;
  createdBy?: string | null;
  activate?: boolean;
  changeReason?: string | null;
};

export type InstallExtensionResult = {
  extension: Extension;
  isNew: boolean;
  contentDeduped: boolean;
};

function rowToExtension(row: ExtensionRow): Extension {
  return {
    ...row,
    enabled: row.enabled === 1,
    lastError: row.lastError ?? null,
    agentId: row.agentId ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
  };
}

function canonicalFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function bundleContentHash(manifest: ExtensionManifest, files: Record<string, string>): string {
  return computeContentHash(JSON.stringify({ manifest, files: canonicalFiles(files) }));
}

export async function installExtension(
  args: InstallExtensionArgs,
): Promise<InstallExtensionResult> {
  const files = canonicalFiles(args.files);
  const manifestJson = JSON.stringify(args.manifest);
  const filesJson = JSON.stringify(files);
  const contentHash = bundleContentHash(args.manifest, files);
  const actor = args.createdBy ?? null;

  return await getDbClient().transaction(async (tx) => {
    const existingRow = await tx.get<ExtensionRow>("SELECT * FROM extensions WHERE name = ?", [
      args.manifest.name,
    ]);
    const existing = existingRow ? rowToExtension(existingRow) : null;
    const now = new Date().toISOString();

    if (!existing) {
      const id = crypto.randomUUID();
      const row = await tx.get<ExtensionRow>(
        `INSERT INTO extensions (
          id, name, description, runtime, manifestJson, contentHash, version,
          activeVersion, enabled, priority, configJson, status,
          consecutiveFailures, lastError, agentId, createdByAgentId,
          created_by, updated_by, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?, 'disabled', 0, NULL, NULL, ?, ?, ?, ?, ?)
        RETURNING *`,
        [
          id,
          args.manifest.name,
          args.manifest.description,
          args.manifest.runtime,
          manifestJson,
          contentHash,
          args.priority ?? 100,
          JSON.stringify(args.config ?? {}),
          args.agentId ?? null,
          actor,
          actor,
          now,
          now,
        ],
      );
      if (!row) throw new Error("Failed to insert extension");

      for (const [path, content] of Object.entries(files)) {
        await tx.run(
          `INSERT INTO extension_files (
            id, extensionId, path, content, contentHash, created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), id, path, content, computeContentHash(content), actor, actor],
        );
      }

      await tx.run(
        `INSERT INTO extension_versions (
          id, extensionId, version, manifestJson, filesJson, contentHash,
          changedByAgentId, changedAt, changeReason, created_by, updated_by
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          id,
          manifestJson,
          filesJson,
          contentHash,
          args.agentId ?? null,
          now,
          args.changeReason ?? "Initial installation",
          actor,
          actor,
        ],
      );

      return { extension: rowToExtension(row), isNew: true, contentDeduped: false };
    }

    if (existing.contentHash === contentHash) {
      const row = await tx.get<ExtensionRow>(
        `UPDATE extensions SET
          priority = ?, configJson = ?, activeVersion = ?, updated_by = ?, updatedAt = ?
        WHERE id = ?
        RETURNING *`,
        [
          args.priority ?? existing.priority,
          args.config === undefined ? existing.configJson : JSON.stringify(args.config),
          args.activate ? existing.version : existing.activeVersion,
          actor,
          now,
          existing.id,
        ],
      );
      if (!row) throw new Error("Failed to update extension metadata");
      return { extension: rowToExtension(row), isNew: false, contentDeduped: true };
    }

    const newVersion = existing.version + 1;
    const row = await tx.get<ExtensionRow>(
      `UPDATE extensions SET
        description = ?, runtime = ?, manifestJson = ?, contentHash = ?, version = ?,
        activeVersion = ?, priority = ?, configJson = ?, updated_by = ?, updatedAt = ?
      WHERE id = ?
      RETURNING *`,
      [
        args.manifest.description,
        args.manifest.runtime,
        manifestJson,
        contentHash,
        newVersion,
        args.activate ? newVersion : existing.activeVersion,
        args.priority ?? existing.priority,
        args.config === undefined ? existing.configJson : JSON.stringify(args.config),
        actor,
        now,
        existing.id,
      ],
    );
    if (!row) throw new Error("Failed to update extension");

    await tx.run("DELETE FROM extension_files WHERE extensionId = ?", [existing.id]);
    for (const [path, content] of Object.entries(files)) {
      await tx.run(
        `INSERT INTO extension_files (
          id, extensionId, path, content, contentHash, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          existing.id,
          path,
          content,
          computeContentHash(content),
          actor,
          actor,
        ],
      );
    }

    await tx.run(
      `INSERT INTO extension_versions (
        id, extensionId, version, manifestJson, filesJson, contentHash,
        changedByAgentId, changedAt, changeReason, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        existing.id,
        newVersion,
        manifestJson,
        filesJson,
        contentHash,
        args.agentId ?? null,
        now,
        args.changeReason ?? null,
        actor,
        actor,
      ],
    );

    return { extension: rowToExtension(row), isNew: false, contentDeduped: false };
  });
}

export async function getExtensionFiles(extensionId: string): Promise<Record<string, string>> {
  const rows = await getDbClient().query<{ path: string; content: string }>(
    "SELECT path, content FROM extension_files WHERE extensionId = ? ORDER BY path",
    [extensionId],
  );
  return Object.fromEntries(rows.map((row) => [row.path, row.content]));
}

export async function getExtensionById(id: string): Promise<Extension | null> {
  const row = await getDbClient().get<ExtensionRow>("SELECT * FROM extensions WHERE id = ?", [id]);
  return row ? rowToExtension(row) : null;
}

export async function getExtensionByName(name: string): Promise<Extension | null> {
  const row = await getDbClient().get<ExtensionRow>("SELECT * FROM extensions WHERE name = ?", [
    name,
  ]);
  return row ? rowToExtension(row) : null;
}

export async function listExtensions(): Promise<Extension[]> {
  const rows = await getDbClient().query<ExtensionRow>(
    "SELECT * FROM extensions ORDER BY priority ASC, name ASC",
  );
  return rows.map(rowToExtension);
}

export async function listExtensionVersions(extensionId: string): Promise<ExtensionVersion[]> {
  return await getDbClient().query<ExtensionVersionRow>(
    "SELECT * FROM extension_versions WHERE extensionId = ? ORDER BY version DESC",
    [extensionId],
  );
}

export async function getExtensionVersion(
  extensionId: string,
  version: number,
): Promise<ExtensionVersion | null> {
  return (
    (await getDbClient().get<ExtensionVersionRow>(
      "SELECT * FROM extension_versions WHERE extensionId = ? AND version = ?",
      [extensionId, version],
    )) ?? null
  );
}

export async function activateExtensionVersionSnapshot(
  extensionId: string,
  version: number,
  updatedBy?: string | null,
): Promise<Extension | null> {
  return await getDbClient().transaction(async (tx) => {
    const snapshot = await tx.get<ExtensionVersionRow>(
      "SELECT * FROM extension_versions WHERE extensionId = ? AND version = ?",
      [extensionId, version],
    );
    if (!snapshot) return null;

    const manifest = JSON.parse(snapshot.manifestJson) as ExtensionManifest;
    const files = JSON.parse(snapshot.filesJson) as Record<string, string>;
    const now = new Date().toISOString();
    const row = await tx.get<ExtensionRow>(
      `UPDATE extensions SET
        description = ?, runtime = ?, manifestJson = ?, contentHash = ?, activeVersion = ?,
        updated_by = ?, updatedAt = ?
       WHERE id = ?
       RETURNING *`,
      [
        manifest.description,
        manifest.runtime,
        snapshot.manifestJson,
        snapshot.contentHash,
        version,
        updatedBy ?? null,
        now,
        extensionId,
      ],
    );
    if (!row) return null;

    await tx.run("DELETE FROM extension_files WHERE extensionId = ?", [extensionId]);
    for (const [path, content] of Object.entries(files)) {
      await tx.run(
        `INSERT INTO extension_files (
          id, extensionId, path, content, contentHash, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          extensionId,
          path,
          content,
          computeContentHash(content),
          updatedBy ?? null,
          updatedBy ?? null,
        ],
      );
    }
    return rowToExtension(row);
  });
}

export async function updateExtensionMeta(
  id: string,
  args: {
    priority?: number;
    config?: Record<string, unknown>;
    description?: string;
    updatedBy?: string | null;
  },
): Promise<Extension | null> {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (args.priority !== undefined) {
    sets.push("priority = ?");
    values.push(args.priority);
  }
  if (args.config !== undefined) {
    sets.push("configJson = ?");
    values.push(JSON.stringify(args.config));
  }
  if (args.description !== undefined) {
    sets.push("description = ?");
    values.push(args.description);
  }
  if (sets.length === 0) return getExtensionById(id);

  sets.push("updated_by = ?", "updatedAt = ?");
  values.push(args.updatedBy ?? null, new Date().toISOString(), id);
  const row = await getDbClient().get<ExtensionRow>(
    `UPDATE extensions SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    values,
  );
  return row ? rowToExtension(row) : null;
}

export async function setExtensionState(
  id: string,
  args: {
    enabled?: boolean;
    status?: ExtensionStatus;
    activeVersion?: number;
    agentId?: string | null;
    consecutiveFailures?: number;
    lastError?: string | null;
    updatedBy?: string | null;
  },
): Promise<Extension | null> {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const fields = [
    ["enabled", args.enabled === undefined ? undefined : args.enabled ? 1 : 0],
    ["status", args.status],
    ["activeVersion", args.activeVersion],
    ["agentId", args.agentId],
    ["consecutiveFailures", args.consecutiveFailures],
    ["lastError", args.lastError],
  ] as const;
  for (const [column, value] of fields) {
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (sets.length === 0) return getExtensionById(id);

  sets.push("updated_by = ?", "updatedAt = ?");
  values.push(args.updatedBy ?? null, new Date().toISOString(), id);
  const row = await getDbClient().get<ExtensionRow>(
    `UPDATE extensions SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    values,
  );
  return row ? rowToExtension(row) : null;
}

export async function recordExtensionFailure(
  id: string,
  lastError: string,
  maxConsecutiveFailures: number,
): Promise<Extension | null> {
  const row = await getDbClient().get<ExtensionRow>(
    `UPDATE extensions SET
      consecutiveFailures = consecutiveFailures + 1,
      lastError = ?,
      enabled = CASE WHEN consecutiveFailures + 1 >= ? THEN 0 ELSE enabled END,
      status = CASE
        WHEN consecutiveFailures + 1 >= ? THEN 'auto-disabled'
        ELSE status
      END,
      updatedAt = ?
     WHERE id = ?
     RETURNING *`,
    [lastError, maxConsecutiveFailures, maxConsecutiveFailures, new Date().toISOString(), id],
  );
  return row ? rowToExtension(row) : null;
}

export async function deleteExtension(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM extensions WHERE id = ?", [id]);
  return result.changes > 0;
}

export async function insertExtensionRun(args: {
  extensionId: string;
  version: number;
  event: string;
  action: ExtensionRun["action"];
  durationMs?: number | null;
  message?: string | null;
  agentId?: string | null;
  subject?: string | null;
}): Promise<ExtensionRun> {
  const row = await getDbClient().get<ExtensionRunRow>(
    `INSERT INTO extension_runs (
      id, extensionId, version, event, action, durationMs, message, agentId, subject, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      crypto.randomUUID(),
      args.extensionId,
      args.version,
      args.event,
      args.action,
      args.durationMs ?? null,
      args.message ?? null,
      args.agentId ?? null,
      args.subject ?? null,
      new Date().toISOString(),
    ],
  );
  if (!row) throw new Error("Failed to insert extension run");
  return row;
}

export async function pruneExtensionRuns(extensionId: string, keep = 500): Promise<void> {
  await getDbClient().run(
    `DELETE FROM extension_runs
     WHERE extensionId = ? AND id IN (
       SELECT id FROM extension_runs
       WHERE extensionId = ?
       ORDER BY createdAt DESC, rowid DESC
       LIMIT -1 OFFSET ?
     )`,
    [extensionId, extensionId, keep],
  );
}

export async function listExtensionRuns(extensionId: string, limit = 100): Promise<ExtensionRun[]> {
  return await getDbClient().query<ExtensionRunRow>(
    `SELECT * FROM extension_runs
     WHERE extensionId = ?
     ORDER BY createdAt DESC, rowid DESC
     LIMIT ?`,
    [extensionId, Math.max(1, Math.min(500, limit))],
  );
}
