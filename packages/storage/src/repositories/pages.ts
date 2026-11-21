import { likeAsciiCi } from "../dialect";
import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql, sqlWhere } from "../sql";

/**
 * Domain: pages, metrics, apps (`apps`, `user_favorites` of apps,
 * `page_versions`, `primitive_objects`). Rows come back in the SQLite value
 * shape on every engine (JSON as text, timestamps as the text the column
 * stores).
 */

export type AppRow = {
  id: string;
  name: string;
  description: string | null;
  definition: string;
  created_at: string;
  updated_at: string;
};

export type NewApp = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  definition: string;
  now: string;
};

export type AppUpdate = {
  name: string;
  description: string | null;
  definition: string;
  updatedAt: string;
};

export type PrimitiveObjectRow = {
  id: string;
  kind: string;
  orgId: string;
  driveId: string;
  path: string;
  title: string | null;
  fileVersion: number | null;
  ownerAgentId: string | null;
  deletedAt: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PrimitiveObjectSave = {
  id: string;
  kind: string;
  orgId: string;
  driveId: string;
  path: string;
  title: string | null;
  fileVersion: number | null;
  ownerAgentId: string | null;
  now: string;
};

/** Live objects of one drive; `prefix` matches the start of the path literally. */
export type PrimitiveObjectFilter = {
  orgId: string;
  driveId: string;
  kind?: string;
  prefix?: string;
};

export interface PagesRepository {
  // ---- apps ----
  insertApp(app: NewApp): Promise<AppRow | null>;
  findApp(id: string): Promise<AppRow | null>;
  /**
   * Newest first, then id. `pattern` is a LIKE pattern with `\` escapes,
   * matched against name or description, folding ASCII case.
   */
  listApps(filter: { pattern?: string; limit?: number }): Promise<AppRow[]>;
  /** Oldest first, then id. */
  listAllApps(): Promise<AppRow[]>;
  updateApp(id: string, update: AppUpdate): Promise<AppRow | null>;
  /** Removes the app from every user's favorites. */
  deleteAppFavorites(appId: string): Promise<void>;
  deleteApp(id: string): Promise<number>;
  appExists(id: string): Promise<boolean>;
  getAppDefinition(id: string): Promise<string | null>;
  /** The columns a recovery snapshot copies, read raw. */
  getStoredApp(
    id: string,
  ): Promise<{ name: string; description: string | null; definition: string } | null>;
  /** Every other app's definition, ordered by name, then id. */
  listOtherAppDefinitions(
    appId: string,
  ): Promise<{ id: string; name: string; definition: string }[]>;

  // ---- app_user_config ----
  /** The stored JSON text of the (app, scope) config, or null. */
  getAppUserConfig(appId: string, scope: string): Promise<string | null>;
  /** Insert, or replace the values of, the (app, scope) config. */
  upsertAppUserConfig(row: {
    id: string;
    appId: string;
    scope: string;
    valuesJson: string;
    now: string;
  }): Promise<void>;

  // ---- pages ----
  pageExists(id: string): Promise<boolean>;

  // ---- page_versions ----
  /** The highest stored version of the page, or null before the first snapshot. */
  latestPageVersion(pageId: string): Promise<number | null>;

  // ---- primitive_objects ----
  /** Deletes the row at the path when it carries another id. */
  deleteObjectAtPathExcept(orgId: string, driveId: string, path: string, id: string): Promise<void>;
  /**
   * Insert, or update the row with the same id (title kept when the new one is
   * NULL, tombstone cleared). `onlyNewer` skips the update unless the path
   * changed or the stored version is older.
   */
  upsertObject(row: PrimitiveObjectSave, onlyNewer: boolean): Promise<void>;
  findObjectById(id: string): Promise<PrimitiveObjectRow | null>;
  findObjectOnDrive(id: string, orgId: string, driveId: string): Promise<PrimitiveObjectRow | null>;
  findObjectByPath(
    orgId: string,
    driveId: string,
    path: string,
  ): Promise<PrimitiveObjectRow | null>;
  setObjectFileVersion(id: string, fileVersion: number | null, now: string): Promise<void>;
  setObjectEditor(id: string, userId: string | null): Promise<void>;
  /** Live objects, most recently updated first, then id. */
  listObjects(
    filter: PrimitiveObjectFilter,
    limit: number,
    offset: number,
  ): Promise<PrimitiveObjectRow[]>;
  countObjects(filter: PrimitiveObjectFilter): Promise<number>;
  /** Every path of the kind on the drive (tombstones included), ordered by path. */
  listObjectPaths(orgId: string, driveId: string, kind: string): Promise<string[]>;
  /** Distinct drives that hold objects, ordered by orgId, then driveId. */
  listObjectDrives(limit: number): Promise<{ orgId: string; driveId: string }[]>;
  /** Tombstones the row at `path` while its version is older than `version`. Returns the change count. */
  tombstoneObjectIfOlder(id: string, path: string, version: number, now: string): Promise<number>;
  /**
   * Clears the tombstone of the row at `path` while its version is older than
   * `version`; `owned` also sets the file version to `read`.
   */
  reviveObjectIfOlder(
    id: string,
    path: string,
    version: number,
    owned: boolean,
    read: number,
    now: string,
  ): Promise<number>;
  /** Tombstones the live row at `path` while its version equals `fileVersion`. */
  tombstoneObjectAtVersion(
    id: string,
    path: string,
    fileVersion: number,
    now: string,
  ): Promise<number>;
}

const APP_COLUMNS = sql`id, name, description, definition, created_at, updated_at`;

function objectConditions(f: PrimitiveObjectFilter): SqlQuery[] {
  const conditions = [
    sql`"orgId" = ${f.orgId}`,
    sql`"driveId" = ${f.driveId}`,
    sql`"deletedAt" IS NULL`,
  ];
  if (f.kind) conditions.push(sql`kind = ${f.kind}`);
  // A literal prefix test, not LIKE: a path may hold % or _.
  if (f.prefix) conditions.push(sql`substr(path, 1, length(${f.prefix})) = ${f.prefix}`);
  return conditions;
}

export abstract class BasePagesRepository implements PagesRepository {
  constructor(protected readonly db: SqlExecutor) {}

  // ---- apps ----

  insertApp(a: NewApp): Promise<AppRow | null> {
    return this.db.get<AppRow>(sql`
      INSERT INTO apps (id, name, description, definition, created_at, updated_at, "key")
      VALUES (${a.id}, ${a.name}, ${a.description}, ${a.definition}, ${a.now}, ${a.now}, ${a.key})
      RETURNING ${APP_COLUMNS}`);
  }

  findApp(id: string): Promise<AppRow | null> {
    return this.db.get<AppRow>(sql`SELECT ${APP_COLUMNS} FROM apps WHERE id = ${id}`);
  }

  listApps(filter: { pattern?: string; limit?: number }): Promise<AppRow[]> {
    const where =
      filter.pattern === undefined
        ? sql``
        : sql` WHERE ${likeAsciiCi(sql`name`, sql`${filter.pattern}`, "\\")} OR ${likeAsciiCi(
            sql`description`,
            sql`${filter.pattern}`,
            "\\",
          )}`;
    const limit = filter.limit === undefined ? sql`` : sql` LIMIT ${filter.limit}`;
    return this.db.query<AppRow>(
      sql`SELECT ${APP_COLUMNS} FROM apps${where} ORDER BY created_at DESC, id${limit}`,
    );
  }

  listAllApps(): Promise<AppRow[]> {
    return this.db.query<AppRow>(
      sql`SELECT ${APP_COLUMNS} FROM apps ORDER BY created_at ASC, id ASC`,
    );
  }

  updateApp(id: string, u: AppUpdate): Promise<AppRow | null> {
    return this.db.get<AppRow>(sql`
      UPDATE apps
      SET name = ${u.name}, description = ${u.description}, definition = ${u.definition},
        updated_at = ${u.updatedAt}
      WHERE id = ${id}
      RETURNING ${APP_COLUMNS}`);
  }

  async deleteAppFavorites(appId: string): Promise<void> {
    await this.db.run(
      sql`DELETE FROM user_favorites WHERE "itemType" = 'app' AND "itemId" = ${appId}`,
    );
  }

  async deleteApp(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM apps WHERE id = ${id}`)).changes;
  }

  async appExists(id: string): Promise<boolean> {
    return (await this.db.get(sql`SELECT 1 AS present FROM apps WHERE id = ${id}`)) !== null;
  }

  async getAppDefinition(id: string): Promise<string | null> {
    const row = await this.db.get<{ definition: string }>(
      sql`SELECT definition FROM apps WHERE id = ${id}`,
    );
    return row ? row.definition : null;
  }

  getStoredApp(
    id: string,
  ): Promise<{ name: string; description: string | null; definition: string } | null> {
    return this.db.get<{ name: string; description: string | null; definition: string }>(
      sql`SELECT name, description, definition FROM apps WHERE id = ${id}`,
    );
  }

  listOtherAppDefinitions(
    appId: string,
  ): Promise<{ id: string; name: string; definition: string }[]> {
    return this.db.query<{ id: string; name: string; definition: string }>(
      sql`SELECT id, name, definition FROM apps WHERE id != ${appId} ORDER BY name, id`,
    );
  }

  // ---- app_user_config ----

  async getAppUserConfig(appId: string, scope: string): Promise<string | null> {
    const row = await this.db.get<{ storedValues: string }>(sql`
      SELECT "values" AS "storedValues" FROM app_user_config WHERE "appId" = ${appId} AND scope = ${scope}`);
    return row ? row.storedValues : null;
  }

  async upsertAppUserConfig(r: {
    id: string;
    appId: string;
    scope: string;
    valuesJson: string;
    now: string;
  }): Promise<void> {
    await this.db.run(sql`
      INSERT INTO app_user_config (id, "appId", scope, "values", "createdAt", "updatedAt")
      VALUES (${r.id}, ${r.appId}, ${r.scope}, ${r.valuesJson}, ${r.now}, ${r.now})
      ON CONFLICT ("appId", scope) DO UPDATE SET
        "values" = excluded."values", "updatedAt" = excluded."updatedAt"`);
  }

  // ---- pages ----

  async pageExists(id: string): Promise<boolean> {
    return (await this.db.get(sql`SELECT 1 AS present FROM pages WHERE id = ${id}`)) !== null;
  }

  // ---- page_versions ----

  async latestPageVersion(pageId: string): Promise<number | null> {
    const row = await this.db.get<{ latest: number | null }>(
      sql`SELECT MAX(version) AS latest FROM page_versions WHERE "pageId" = ${pageId}`,
    );
    return row?.latest ?? null;
  }

  // ---- primitive_objects ----

  async deleteObjectAtPathExcept(
    orgId: string,
    driveId: string,
    path: string,
    id: string,
  ): Promise<void> {
    await this.db.run(sql`
      DELETE FROM primitive_objects
      WHERE "orgId" = ${orgId} AND "driveId" = ${driveId} AND path = ${path} AND id <> ${id}`);
  }

  async upsertObject(r: PrimitiveObjectSave, onlyNewer: boolean): Promise<void> {
    const guard = onlyNewer
      ? sql`
        WHERE primitive_objects.path <> excluded.path
          OR primitive_objects."fileVersion" IS NULL
          OR primitive_objects."fileVersion" < excluded."fileVersion"`
      : sql``;
    await this.db.run(sql`
      INSERT INTO primitive_objects
        (id, kind, "orgId", "driveId", path, title, "fileVersion", "ownerAgentId", "createdAt", "updatedAt")
      VALUES (
        ${r.id}, ${r.kind}, ${r.orgId}, ${r.driveId}, ${r.path}, ${r.title}, ${r.fileVersion},
        ${r.ownerAgentId}, ${r.now}, ${r.now}
      )
      ON CONFLICT (id) DO UPDATE SET
        kind = excluded.kind, "orgId" = excluded."orgId", "driveId" = excluded."driveId",
        path = excluded.path, title = COALESCE(excluded.title, primitive_objects.title),
        "fileVersion" = excluded."fileVersion", "deletedAt" = NULL, "updatedAt" = excluded."updatedAt"${guard}`);
  }

  findObjectById(id: string): Promise<PrimitiveObjectRow | null> {
    return this.db.get<PrimitiveObjectRow>(sql`SELECT * FROM primitive_objects WHERE id = ${id}`);
  }

  findObjectOnDrive(
    id: string,
    orgId: string,
    driveId: string,
  ): Promise<PrimitiveObjectRow | null> {
    return this.db.get<PrimitiveObjectRow>(sql`
      SELECT * FROM primitive_objects WHERE id = ${id} AND "orgId" = ${orgId} AND "driveId" = ${driveId}`);
  }

  findObjectByPath(
    orgId: string,
    driveId: string,
    path: string,
  ): Promise<PrimitiveObjectRow | null> {
    return this.db.get<PrimitiveObjectRow>(sql`
      SELECT * FROM primitive_objects WHERE "orgId" = ${orgId} AND "driveId" = ${driveId} AND path = ${path}`);
  }

  async setObjectFileVersion(id: string, fileVersion: number | null, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE primitive_objects SET "fileVersion" = ${fileVersion}, "updatedAt" = ${now} WHERE id = ${id}`);
  }

  async setObjectEditor(id: string, userId: string | null): Promise<void> {
    await this.db.run(sql`UPDATE primitive_objects SET updated_by = ${userId} WHERE id = ${id}`);
  }

  listObjects(
    filter: PrimitiveObjectFilter,
    limit: number,
    offset: number,
  ): Promise<PrimitiveObjectRow[]> {
    return this.db.query<PrimitiveObjectRow>(sql`
      SELECT * FROM primitive_objects${sqlWhere(objectConditions(filter))}
      ORDER BY "updatedAt" DESC, id LIMIT ${limit} OFFSET ${offset}`);
  }

  async countObjects(filter: PrimitiveObjectFilter): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM primitive_objects${sqlWhere(objectConditions(filter))}`,
    );
    return Number(row?.n ?? 0);
  }

  async listObjectPaths(orgId: string, driveId: string, kind: string): Promise<string[]> {
    const rows = await this.db.query<{ path: string }>(sql`
      SELECT path FROM primitive_objects
      WHERE "orgId" = ${orgId} AND "driveId" = ${driveId} AND kind = ${kind}
      ORDER BY path`);
    return rows.map((row) => row.path);
  }

  listObjectDrives(limit: number): Promise<{ orgId: string; driveId: string }[]> {
    return this.db.query<{ orgId: string; driveId: string }>(sql`
      SELECT DISTINCT "orgId", "driveId" FROM primitive_objects
      ORDER BY "orgId", "driveId" LIMIT ${limit}`);
  }

  async tombstoneObjectIfOlder(
    id: string,
    path: string,
    version: number,
    now: string,
  ): Promise<number> {
    return (
      await this.db.run(sql`
        UPDATE primitive_objects SET "deletedAt" = ${now}, "fileVersion" = ${version}, "updatedAt" = ${now}
        WHERE id = ${id} AND path = ${path} AND ("fileVersion" IS NULL OR "fileVersion" < ${version})`)
    ).changes;
  }

  async reviveObjectIfOlder(
    id: string,
    path: string,
    version: number,
    owned: boolean,
    read: number,
    now: string,
  ): Promise<number> {
    return (
      await this.db.run(sql`
        UPDATE primitive_objects
        SET "deletedAt" = NULL, "updatedAt" = ${now},
          "fileVersion" = CASE WHEN ${owned} THEN ${read} ELSE "fileVersion" END
        WHERE id = ${id} AND path = ${path} AND ("fileVersion" IS NULL OR "fileVersion" < ${version})`)
    ).changes;
  }

  async tombstoneObjectAtVersion(
    id: string,
    path: string,
    fileVersion: number,
    now: string,
  ): Promise<number> {
    return (
      await this.db.run(sql`
        UPDATE primitive_objects SET "deletedAt" = ${now}, "updatedAt" = ${now}
        WHERE id = ${id} AND path = ${path} AND "fileVersion" = ${fileVersion} AND "deletedAt" IS NULL`)
    ).changes;
  }
}
