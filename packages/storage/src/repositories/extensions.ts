import { jsonText } from "../dialect";
import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql, sqlJoin } from "../sql";

/**
 * Domain: extensions (`extensions`, `extension_files`, `extension_versions`,
 * `extension_runs`). Rows come back in the SQLite value shape on every engine
 * (flags 0/1, JSON as text, timestamps as the text the column stores).
 */

export type ExtensionRow = {
  id: string;
  name: string;
  description: string;
  runtime: "api" | "worker";
  manifestJson: string;
  contentHash: string;
  version: number;
  activeVersion: number;
  enabled: number;
  priority: number;
  configJson: string;
  status: "disabled" | "enabled" | "error" | "auto-disabled";
  consecutiveFailures: number;
  lastError: string | null;
  agentId: string | null;
  createdByAgentId: string | null;
  created_by: string | null;
  updated_by: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExtensionVersionRow = {
  id: string;
  extensionId: string;
  version: number;
  manifestJson: string;
  filesJson: string;
  contentHash: string;
  changedByAgentId: string | null;
  changedAt: string;
  changeReason: string | null;
  created_by: string | null;
  updated_by: string | null;
};

export type ExtensionRunRow = {
  id: string;
  extensionId: string;
  version: number;
  event: string;
  action: "continue" | "modify" | "block" | "error" | "timeout" | "load-error";
  durationMs: number | null;
  message: string | null;
  agentId: string | null;
  subject: string | null;
  createdAt: string;
};

export type NewExtension = {
  id: string;
  name: string;
  description: string;
  runtime: string;
  manifestJson: string;
  contentHash: string;
  priority: number;
  configJson: string;
  createdByAgentId: string | null;
  actor: string | null;
  now: string;
};

export type NewExtensionFile = {
  id: string;
  extensionId: string;
  path: string;
  content: string;
  contentHash: string;
  actor: string | null;
};

export type NewExtensionVersion = {
  id: string;
  extensionId: string;
  version: number;
  manifestJson: string;
  filesJson: string;
  contentHash: string;
  changedByAgentId: string | null;
  changedAt: string;
  changeReason: string | null;
  actor: string | null;
};

export type ExtensionContentUpdate = {
  description: string;
  runtime: string;
  manifestJson: string;
  contentHash: string;
  activeVersion: number;
  actor: string | null;
  now: string;
};

/** Columns a metadata or state update may set. `undefined` leaves a column unchanged. */
export type ExtensionColumnUpdate = {
  priority?: number;
  configJson?: string;
  description?: string;
  enabled?: boolean;
  status?: ExtensionRow["status"];
  activeVersion?: number;
  agentId?: string | null;
  consecutiveFailures?: number;
  lastError?: string | null;
};

export type ExtensionAssetRow = {
  id: string;
  extensionId: string;
  kind: "script" | "schedule" | "workflow" | "skill";
  assetId: string;
  name: string;
  seededHash: string;
  enabledBefore: number | null;
  created_by: string | null;
  updated_by: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExtensionAssetUpsert = {
  id: string;
  extensionId: string;
  kind: string;
  assetId: string;
  name: string;
  seededHash: string;
  enabledBefore: number | null;
  actor: string | null;
  now: string;
};

export type NewExtensionRun = {
  id: string;
  extensionId: string;
  version: number;
  event: string;
  action: string;
  durationMs: number | null;
  message: string | null;
  agentId: string | null;
  subject: string | null;
  createdAt: string;
};

export interface ExtensionsRepository {
  findById(id: string): Promise<ExtensionRow | null>;
  findByName(name: string): Promise<ExtensionRow | null>;
  /** Ordered by priority, then name. */
  list(): Promise<ExtensionRow[]>;
  insert(extension: NewExtension): Promise<ExtensionRow | null>;
  /** Same content: only priority, config and the active version change. */
  updateMetadata(
    id: string,
    update: {
      priority: number;
      configJson: string;
      activeVersion: number;
      actor: string | null;
      now: string;
    },
  ): Promise<ExtensionRow | null>;
  /** New content: bumps the stored version. */
  updateContent(
    id: string,
    update: ExtensionContentUpdate & { version: number; priority: number; configJson: string },
  ): Promise<ExtensionRow | null>;
  /** Points the extension at an older snapshot without a version bump. */
  activateSnapshot(id: string, update: ExtensionContentUpdate): Promise<ExtensionRow | null>;
  /**
   * Sets the given columns plus the audit columns. `ownerOnly` limits the write
   * to the owner's own disabled draft, inside the same statement.
   */
  updateColumns(
    id: string,
    update: ExtensionColumnUpdate,
    audit: { actor: string | null; now: string },
    ownerOnly?: string,
  ): Promise<ExtensionRow | null>;
  /** Counts one failure; disables the extension at `maxConsecutiveFailures`. */
  recordFailure(
    id: string,
    lastError: string,
    maxConsecutiveFailures: number,
    now: string,
  ): Promise<ExtensionRow | null>;
  /** Deletes the extension. `ownerOnly` limits it to the owner's own disabled draft. */
  delete(id: string, ownerOnly?: string): Promise<number>;

  /** Files ordered by path. */
  listFiles(extensionId: string): Promise<{ path: string; content: string }[]>;
  insertFile(file: NewExtensionFile): Promise<void>;
  deleteFiles(extensionId: string): Promise<void>;

  /** Newest version first. */
  listVersions(extensionId: string): Promise<ExtensionVersionRow[]>;
  getVersion(extensionId: string, version: number): Promise<ExtensionVersionRow | null>;
  insertVersion(version: NewExtensionVersion): Promise<void>;

  /** Asset provenance rows, ordered by kind, then name. */
  listAssets(extensionId: string): Promise<ExtensionAssetRow[]>;
  /** Insert, or update the row with the same extension, kind and name. */
  upsertAsset(asset: ExtensionAssetUpsert): Promise<void>;
  setAssetEnabledBefore(
    id: string,
    enabledBefore: number | null,
    actor: string | null,
    now: string,
  ): Promise<void>;
  deleteAsset(id: string): Promise<void>;

  insertRun(run: NewExtensionRun): Promise<ExtensionRunRow | null>;
  /** Keeps the newest `keep` runs of the extension. */
  pruneRuns(extensionId: string, keep: number): Promise<void>;
  /** Newest first; ties keep reverse insertion order. */
  listRuns(extensionId: string, limit: number): Promise<ExtensionRunRow[]>;
}

/** A nullable 0/1 flag bound as a JS boolean (SQLite stores 1/0, Postgres a boolean). */
function flag(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

export abstract class BaseExtensionsRepository implements ExtensionsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  findById(id: string): Promise<ExtensionRow | null> {
    return this.db.get<ExtensionRow>(sql`SELECT * FROM extensions WHERE id = ${id}`);
  }

  findByName(name: string): Promise<ExtensionRow | null> {
    return this.db.get<ExtensionRow>(sql`SELECT * FROM extensions WHERE name = ${name}`);
  }

  list(): Promise<ExtensionRow[]> {
    return this.db.query<ExtensionRow>(
      sql`SELECT * FROM extensions ORDER BY priority ASC, name ASC`,
    );
  }

  insert(e: NewExtension): Promise<ExtensionRow | null> {
    return this.db.get<ExtensionRow>(sql`
      INSERT INTO extensions (
        id, name, description, runtime, "manifestJson", "contentHash", version,
        "activeVersion", enabled, priority, "configJson", status,
        "consecutiveFailures", "lastError", "agentId", "createdByAgentId",
        created_by, updated_by, "createdAt", "updatedAt"
      ) VALUES (
        ${e.id}, ${e.name}, ${e.description}, ${e.runtime}, ${jsonText(e.manifestJson)}, ${e.contentHash}, 1,
        1, ${false}, ${e.priority}, ${e.configJson}, 'disabled',
        0, NULL, NULL, ${e.createdByAgentId},
        ${e.actor}, ${e.actor}, ${e.now}, ${e.now}
      )
      RETURNING *`);
  }

  updateMetadata(
    id: string,
    u: {
      priority: number;
      configJson: string;
      activeVersion: number;
      actor: string | null;
      now: string;
    },
  ): Promise<ExtensionRow | null> {
    return this.db.get<ExtensionRow>(sql`
      UPDATE extensions SET
        priority = ${u.priority}, "configJson" = ${u.configJson}, "activeVersion" = ${u.activeVersion},
        updated_by = ${u.actor}, "updatedAt" = ${u.now}
      WHERE id = ${id}
      RETURNING *`);
  }

  updateContent(
    id: string,
    u: ExtensionContentUpdate & { version: number; priority: number; configJson: string },
  ): Promise<ExtensionRow | null> {
    return this.db.get<ExtensionRow>(sql`
      UPDATE extensions SET
        description = ${u.description}, runtime = ${u.runtime}, "manifestJson" = ${jsonText(u.manifestJson)},
        "contentHash" = ${u.contentHash}, version = ${u.version}, "activeVersion" = ${u.activeVersion},
        priority = ${u.priority}, "configJson" = ${u.configJson}, updated_by = ${u.actor},
        "updatedAt" = ${u.now}
      WHERE id = ${id}
      RETURNING *`);
  }

  activateSnapshot(id: string, u: ExtensionContentUpdate): Promise<ExtensionRow | null> {
    return this.db.get<ExtensionRow>(sql`
      UPDATE extensions SET
        description = ${u.description}, runtime = ${u.runtime}, "manifestJson" = ${jsonText(u.manifestJson)},
        "contentHash" = ${u.contentHash}, "activeVersion" = ${u.activeVersion},
        updated_by = ${u.actor}, "updatedAt" = ${u.now}
      WHERE id = ${id}
      RETURNING *`);
  }

  updateColumns(
    id: string,
    u: ExtensionColumnUpdate,
    audit: { actor: string | null; now: string },
    ownerOnly?: string,
  ): Promise<ExtensionRow | null> {
    const sets: SqlQuery[] = [];
    if (u.priority !== undefined) sets.push(sql`priority = ${u.priority}`);
    if (u.configJson !== undefined) sets.push(sql`"configJson" = ${u.configJson}`);
    if (u.description !== undefined) sets.push(sql`description = ${u.description}`);
    if (u.enabled !== undefined) sets.push(sql`enabled = ${u.enabled}`);
    if (u.status !== undefined) sets.push(sql`status = ${u.status}`);
    if (u.activeVersion !== undefined) sets.push(sql`"activeVersion" = ${u.activeVersion}`);
    if (u.agentId !== undefined) sets.push(sql`"agentId" = ${u.agentId}`);
    if (u.consecutiveFailures !== undefined)
      sets.push(sql`"consecutiveFailures" = ${u.consecutiveFailures}`);
    if (u.lastError !== undefined) sets.push(sql`"lastError" = ${u.lastError}`);
    sets.push(sql`updated_by = ${audit.actor}`, sql`"updatedAt" = ${audit.now}`);
    // The enabled check is part of the write: a lead may enable the draft after
    // the HTTP handler authorized it but before this UPDATE executes.
    const owner =
      ownerOnly === undefined
        ? sql``
        : sql` AND "createdByAgentId" = ${ownerOnly} AND enabled = ${false}`;
    return this.db.get<ExtensionRow>(
      sql`UPDATE extensions SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id}${owner} RETURNING *`,
    );
  }

  recordFailure(
    id: string,
    lastError: string,
    maxConsecutiveFailures: number,
    now: string,
  ): Promise<ExtensionRow | null> {
    return this.db.get<ExtensionRow>(sql`
      UPDATE extensions SET
        "consecutiveFailures" = "consecutiveFailures" + 1,
        "lastError" = ${lastError},
        enabled = CASE WHEN "consecutiveFailures" + 1 >= ${maxConsecutiveFailures} THEN ${false} ELSE enabled END,
        status = CASE
          WHEN "consecutiveFailures" + 1 >= ${maxConsecutiveFailures} THEN 'auto-disabled'
          ELSE status
        END,
        "updatedAt" = ${now}
      WHERE id = ${id}
      RETURNING *`);
  }

  async delete(id: string, ownerOnly?: string): Promise<number> {
    const owner =
      ownerOnly === undefined
        ? sql``
        : sql` AND "createdByAgentId" = ${ownerOnly} AND enabled = ${false}`;
    const result = await this.db.run(sql`DELETE FROM extensions WHERE id = ${id}${owner}`);
    return result.changes;
  }

  listFiles(extensionId: string): Promise<{ path: string; content: string }[]> {
    return this.db.query<{ path: string; content: string }>(
      sql`SELECT path, content FROM extension_files WHERE "extensionId" = ${extensionId} ORDER BY path`,
    );
  }

  async insertFile(f: NewExtensionFile): Promise<void> {
    await this.db.run(sql`
      INSERT INTO extension_files (
        id, "extensionId", path, content, "contentHash", created_by, updated_by
      ) VALUES (${f.id}, ${f.extensionId}, ${f.path}, ${f.content}, ${f.contentHash}, ${f.actor}, ${f.actor})`);
  }

  async deleteFiles(extensionId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM extension_files WHERE "extensionId" = ${extensionId}`);
  }

  listVersions(extensionId: string): Promise<ExtensionVersionRow[]> {
    return this.db.query<ExtensionVersionRow>(
      sql`SELECT * FROM extension_versions WHERE "extensionId" = ${extensionId} ORDER BY version DESC`,
    );
  }

  getVersion(extensionId: string, version: number): Promise<ExtensionVersionRow | null> {
    return this.db.get<ExtensionVersionRow>(
      sql`SELECT * FROM extension_versions WHERE "extensionId" = ${extensionId} AND version = ${version}`,
    );
  }

  async insertVersion(v: NewExtensionVersion): Promise<void> {
    await this.db.run(sql`
      INSERT INTO extension_versions (
        id, "extensionId", version, "manifestJson", "filesJson", "contentHash",
        "changedByAgentId", "changedAt", "changeReason", created_by, updated_by
      ) VALUES (
        ${v.id}, ${v.extensionId}, ${v.version}, ${jsonText(v.manifestJson)}, ${jsonText(v.filesJson)}, ${v.contentHash},
        ${v.changedByAgentId}, ${v.changedAt}, ${v.changeReason}, ${v.actor}, ${v.actor}
      )`);
  }

  listAssets(extensionId: string): Promise<ExtensionAssetRow[]> {
    return this.db.query<ExtensionAssetRow>(
      sql`SELECT * FROM extension_assets WHERE "extensionId" = ${extensionId} ORDER BY kind, name`,
    );
  }

  async upsertAsset(a: ExtensionAssetUpsert): Promise<void> {
    await this.db.run(sql`
      INSERT INTO extension_assets (
        id, "extensionId", kind, "assetId", name, "seededHash", "enabledBefore",
        created_by, updated_by, "createdAt", "updatedAt"
      ) VALUES (
        ${a.id}, ${a.extensionId}, ${a.kind}, ${a.assetId}, ${a.name}, ${a.seededHash}, ${flag(a.enabledBefore)},
        ${a.actor}, ${a.actor}, ${a.now}, ${a.now}
      )
      ON CONFLICT ("extensionId", kind, name) DO UPDATE SET
        "assetId" = excluded."assetId", "seededHash" = excluded."seededHash",
        "enabledBefore" = excluded."enabledBefore", updated_by = excluded.updated_by,
        "updatedAt" = excluded."updatedAt"`);
  }

  async setAssetEnabledBefore(
    id: string,
    enabledBefore: number | null,
    actor: string | null,
    now: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE extension_assets SET "enabledBefore" = ${flag(enabledBefore)}, updated_by = ${actor}, "updatedAt" = ${now}
      WHERE id = ${id}`);
  }

  async deleteAsset(id: string): Promise<void> {
    await this.db.run(sql`DELETE FROM extension_assets WHERE id = ${id}`);
  }

  insertRun(r: NewExtensionRun): Promise<ExtensionRunRow | null> {
    return this.db.get<ExtensionRunRow>(sql`
      INSERT INTO extension_runs (
        id, "extensionId", version, event, action, "durationMs", message, "agentId", subject, "createdAt"
      ) VALUES (
        ${r.id}, ${r.extensionId}, ${r.version}, ${r.event}, ${r.action}, ${r.durationMs},
        ${r.message}, ${r.agentId}, ${r.subject}, ${r.createdAt}
      ) RETURNING *`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract pruneRuns(extensionId: string, keep: number): Promise<void>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listRuns(extensionId: string, limit: number): Promise<ExtensionRunRow[]>;
}
