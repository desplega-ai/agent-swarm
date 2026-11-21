import { jsonText, likeAsciiCi } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlJoin, sqlWhere } from "../sql";

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

/** One `app_versions` / `page_versions` / `metric_versions` row (`snapshot` as JSON text). */
export type AppVersionRow = {
  id: string;
  appId: string;
  version: number;
  snapshot: string;
  changedByAgentId: string | null;
  createdAt: string;
};
export type PageVersionRow = Omit<AppVersionRow, "appId"> & { pageId: string };
export type MetricVersionRow = Omit<AppVersionRow, "appId"> & { metricId: string };

/** One `pages` row. */
export type PageRow = {
  id: string;
  key: string;
  agentId: string;
  slug: string;
  title: string;
  description: string | null;
  contentType: string;
  authMode: string;
  passwordHash: string | null;
  body: string;
  needsCredentials: string | null;
  createdAt: string;
  updatedAt: string;
  view_count: number;
  theme: string | null;
  theme_tokens: string | null;
  design_version: number;
};

export type NewPageRow = Omit<PageRow, "createdAt" | "updatedAt" | "view_count">;

/** Columns a page update may set. */
export type PageColumnUpdate = Partial<
  Pick<
    PageRow,
    | "key"
    | "title"
    | "description"
    | "contentType"
    | "authMode"
    | "passwordHash"
    | "body"
    | "needsCredentials"
    | "slug"
    | "theme"
    | "theme_tokens"
    | "design_version"
  >
>;

/** Page list filters. `keyPattern` and `searchPattern` are LIKE patterns with `\` escapes. */
export type PageFilter = {
  agentId?: string;
  key?: string;
  keyPattern?: string;
  /** Matches title, slug or description. */
  searchPattern?: string;
};

/** One `metrics` row (`definition` as JSON text). */
export type MetricRow = {
  id: string;
  agentId: string;
  slug: string;
  title: string;
  description: string | null;
  definition: string;
  createdAt: string;
  updatedAt: string;
};

export type MetricColumnUpdate = Partial<
  Pick<MetricRow, "title" | "description" | "definition" | "slug">
>;

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
  // ---- app_versions ----
  insertAppVersion(row: AppVersionRow): Promise<AppVersionRow | null>;
  /** Newest version first, then insertion order (newest first). */
  listAppVersions(appId: string): Promise<AppVersionRow[]>;
  findAppVersion(appId: string, version: number): Promise<AppVersionRow | null>;

  // ---- pages ----
  insertPage(row: NewPageRow): Promise<PageRow | null>;
  findPage(id: string): Promise<PageRow | null>;
  findPageBySlug(agentId: string, slug: string): Promise<PageRow | null>;
  /** The most recently updated page with the slug (insertion order breaks ties, newest first). */
  findLatestPageBySlug(slug: string): Promise<PageRow | null>;
  /** Newest `updatedAt` first, then insertion order (oldest first). */
  listPages(f: PageFilter, limit: number, offset: number): Promise<PageRow[]>;
  countPages(f: PageFilter): Promise<number>;
  /** Sets the given columns and `updatedAt`. */
  updatePage(id: string, update: PageColumnUpdate, updatedAt: string): Promise<PageRow | null>;
  /** Deletes the page, its favorites and its `task:page:<id>` kv namespace. Returns the page change count. */
  deletePageCascade(id: string): Promise<number>;
  incrementPageViewCount(id: string): Promise<number>;

  // ---- page_versions ----
  insertPageVersion(row: Omit<PageVersionRow, "id" | "createdAt">): Promise<PageVersionRow | null>;
  /** Newest version first, then insertion order (newest first). */
  listPageVersions(pageId: string): Promise<PageVersionRow[]>;
  findPageVersion(pageId: string, version: number): Promise<PageVersionRow | null>;

  // ---- metrics ----
  insertMetric(row: Omit<MetricRow, "id" | "createdAt" | "updatedAt">): Promise<MetricRow | null>;
  findMetric(id: string): Promise<MetricRow | null>;
  findMetricBySlug(agentId: string, slug: string): Promise<MetricRow | null>;
  /** Newest `updatedAt` first, then insertion order (newest first); optionally one agent's. */
  listMetrics(agentId: string | null, limit: number, offset: number): Promise<MetricRow[]>;
  countMetrics(agentId: string | null): Promise<number>;
  updateMetric(
    id: string,
    update: MetricColumnUpdate,
    updatedAt: string,
  ): Promise<MetricRow | null>;
  deleteMetric(id: string): Promise<number>;

  // ---- metric_versions ----
  insertMetricVersion(
    row: Omit<MetricVersionRow, "id" | "createdAt">,
  ): Promise<MetricVersionRow | null>;
  /** Newest version first, then insertion order (newest first). */
  listMetricVersions(metricId: string): Promise<MetricVersionRow[]>;
  findMetricVersion(metricId: string, version: number): Promise<MetricVersionRow | null>;
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
      VALUES (${a.id}, ${a.name}, ${a.description}, ${jsonText(a.definition)}, ${a.now}, ${a.now}, ${a.key})
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
      SET name = ${u.name}, description = ${u.description}, definition = ${jsonText(u.definition)},
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

  /** The insertion-order column (SQLite `rowid`), for ORDER BY tiebreaks only. */
  protected abstract insertionOrder(): SqlQuery;

  // ---- app_versions ----

  insertAppVersion(r: AppVersionRow): Promise<AppVersionRow | null> {
    return this.db.get<AppVersionRow>(sql`
      INSERT INTO app_versions (id, "appId", version, snapshot, "changedByAgentId", "createdAt")
      VALUES (${r.id}, ${r.appId}, ${r.version}, ${jsonText(r.snapshot)}, ${r.changedByAgentId}, ${r.createdAt})
      RETURNING *`);
  }

  listAppVersions(appId: string): Promise<AppVersionRow[]> {
    return this.db.query<AppVersionRow>(sql`
      SELECT * FROM app_versions WHERE "appId" = ${appId}
      ORDER BY version DESC, ${this.insertionOrder()} DESC`);
  }

  findAppVersion(appId: string, version: number): Promise<AppVersionRow | null> {
    return this.db.get<AppVersionRow>(sql`
      SELECT * FROM app_versions WHERE "appId" = ${appId} AND version = ${version}`);
  }

  // ---- pages ----

  insertPage(r: NewPageRow): Promise<PageRow | null> {
    return this.db.get<PageRow>(sql`
      INSERT INTO pages (id, "key", "agentId", slug, title, description, "contentType", "authMode",
        "passwordHash", body, "needsCredentials", theme, theme_tokens, design_version)
      VALUES (${r.id}, ${r.key}, ${r.agentId}, ${r.slug}, ${r.title}, ${r.description},
        ${r.contentType}, ${r.authMode}, ${r.passwordHash}, ${r.body}, ${r.needsCredentials},
        ${r.theme}, ${r.theme_tokens}, ${r.design_version})
      RETURNING *`);
  }

  findPage(id: string): Promise<PageRow | null> {
    return this.db.get<PageRow>(sql`SELECT * FROM pages WHERE id = ${id}`);
  }

  findPageBySlug(agentId: string, slug: string): Promise<PageRow | null> {
    return this.db.get<PageRow>(
      sql`SELECT * FROM pages WHERE "agentId" = ${agentId} AND slug = ${slug}`,
    );
  }

  findLatestPageBySlug(slug: string): Promise<PageRow | null> {
    return this.db.get<PageRow>(sql`
      SELECT * FROM pages WHERE slug = ${slug}
      ORDER BY "updatedAt" DESC, ${this.insertionOrder()} DESC LIMIT 1`);
  }

  private pageWhere(f: PageFilter): SqlQuery {
    const c: SqlQuery[] = [];
    if (f.agentId !== undefined) c.push(sql`"agentId" = ${f.agentId}`);
    if (f.key) c.push(sql`"key" = ${f.key}`);
    else if (f.keyPattern) c.push(sql`${likeAsciiCi(sql`"key"`, sql`${f.keyPattern}`, "\\")}`);
    if (f.searchPattern) {
      const p = sql`${f.searchPattern}`;
      c.push(sql`(${likeAsciiCi(sql`title`, p, "\\")} OR ${likeAsciiCi(sql`slug`, p, "\\")}
        OR ${likeAsciiCi(sql`description`, p, "\\")})`);
    }
    return sqlWhere(c);
  }

  listPages(f: PageFilter, limit: number, offset: number): Promise<PageRow[]> {
    return this.db.query<PageRow>(sql`
      SELECT * FROM pages${this.pageWhere(f)}
      ORDER BY "updatedAt" DESC, ${this.insertionOrder()} ASC LIMIT ${limit} OFFSET ${offset}`);
  }

  async countPages(f: PageFilter): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM pages${this.pageWhere(f)}`,
    );
    return row?.count ?? 0;
  }

  updatePage(id: string, u: PageColumnUpdate, updatedAt: string): Promise<PageRow | null> {
    const sets: SqlQuery[] = [];
    if (u.key !== undefined) sets.push(sql`"key" = ${u.key}`);
    if (u.title !== undefined) sets.push(sql`title = ${u.title}`);
    if (u.description !== undefined) sets.push(sql`description = ${u.description}`);
    if (u.contentType !== undefined) sets.push(sql`"contentType" = ${u.contentType}`);
    if (u.authMode !== undefined) sets.push(sql`"authMode" = ${u.authMode}`);
    if (u.passwordHash !== undefined) sets.push(sql`"passwordHash" = ${u.passwordHash}`);
    if (u.body !== undefined) sets.push(sql`body = ${u.body}`);
    if (u.needsCredentials !== undefined)
      sets.push(sql`"needsCredentials" = ${u.needsCredentials}`);
    if (u.slug !== undefined) sets.push(sql`slug = ${u.slug}`);
    if (u.theme !== undefined) sets.push(sql`theme = ${u.theme}`);
    if (u.theme_tokens !== undefined) sets.push(sql`theme_tokens = ${u.theme_tokens}`);
    if (u.design_version !== undefined) sets.push(sql`design_version = ${u.design_version}`);
    sets.push(sql`"updatedAt" = ${updatedAt}`);
    return this.db.get<PageRow>(
      sql`UPDATE pages SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  async deletePageCascade(id: string): Promise<number> {
    await this.db.run(
      sql`DELETE FROM user_favorites WHERE "itemType" = 'page' AND "itemId" = ${id}`,
    );
    await this.db.run(sql`DELETE FROM kv_entries WHERE namespace = ${`task:page:${id}`}`);
    // ON DELETE CASCADE on page_versions."pageId" handles history cleanup.
    return (await this.db.run(sql`DELETE FROM pages WHERE id = ${id}`)).changes;
  }

  async incrementPageViewCount(id: string): Promise<number> {
    const result = await this.db.run(
      sql`UPDATE pages SET view_count = view_count + 1 WHERE id = ${id}`,
    );
    return result.changes;
  }

  // ---- page_versions ----

  insertPageVersion(r: Omit<PageVersionRow, "id" | "createdAt">): Promise<PageVersionRow | null> {
    return this.db.get<PageVersionRow>(sql`
      INSERT INTO page_versions ("pageId", version, snapshot, "changedByAgentId")
      VALUES (${r.pageId}, ${r.version}, ${jsonText(r.snapshot)}, ${r.changedByAgentId}) RETURNING *`);
  }

  listPageVersions(pageId: string): Promise<PageVersionRow[]> {
    return this.db.query<PageVersionRow>(sql`
      SELECT * FROM page_versions WHERE "pageId" = ${pageId}
      ORDER BY version DESC, ${this.insertionOrder()} DESC`);
  }

  findPageVersion(pageId: string, version: number): Promise<PageVersionRow | null> {
    return this.db.get<PageVersionRow>(sql`
      SELECT * FROM page_versions WHERE "pageId" = ${pageId} AND version = ${version}`);
  }

  // ---- metrics ----

  insertMetric(r: Omit<MetricRow, "id" | "createdAt" | "updatedAt">): Promise<MetricRow | null> {
    return this.db.get<MetricRow>(sql`
      INSERT INTO metrics ("agentId", slug, title, description, definition)
      VALUES (${r.agentId}, ${r.slug}, ${r.title}, ${r.description}, ${jsonText(r.definition)}) RETURNING *`);
  }

  findMetric(id: string): Promise<MetricRow | null> {
    return this.db.get<MetricRow>(sql`SELECT * FROM metrics WHERE id = ${id}`);
  }

  findMetricBySlug(agentId: string, slug: string): Promise<MetricRow | null> {
    return this.db.get<MetricRow>(
      sql`SELECT * FROM metrics WHERE "agentId" = ${agentId} AND slug = ${slug}`,
    );
  }

  listMetrics(agentId: string | null, limit: number, offset: number): Promise<MetricRow[]> {
    const where = agentId === null ? EMPTY : sql` WHERE "agentId" = ${agentId}`;
    return this.db.query<MetricRow>(sql`
      SELECT * FROM metrics${where}
      ORDER BY "updatedAt" DESC, ${this.insertionOrder()} DESC LIMIT ${limit} OFFSET ${offset}`);
  }

  async countMetrics(agentId: string | null): Promise<number> {
    const where = agentId === null ? EMPTY : sql` WHERE "agentId" = ${agentId}`;
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM metrics${where}`,
    );
    return row?.count ?? 0;
  }

  updateMetric(id: string, u: MetricColumnUpdate, updatedAt: string): Promise<MetricRow | null> {
    const sets: SqlQuery[] = [];
    if (u.title !== undefined) sets.push(sql`title = ${u.title}`);
    if (u.description !== undefined) sets.push(sql`description = ${u.description}`);
    if (u.definition !== undefined) sets.push(sql`definition = ${u.definition}`);
    if (u.slug !== undefined) sets.push(sql`slug = ${u.slug}`);
    sets.push(sql`"updatedAt" = ${updatedAt}`);
    return this.db.get<MetricRow>(
      sql`UPDATE metrics SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  async deleteMetric(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM metrics WHERE id = ${id}`)).changes;
  }

  // ---- metric_versions ----

  insertMetricVersion(
    r: Omit<MetricVersionRow, "id" | "createdAt">,
  ): Promise<MetricVersionRow | null> {
    return this.db.get<MetricVersionRow>(sql`
      INSERT INTO metric_versions ("metricId", version, snapshot, "changedByAgentId")
      VALUES (${r.metricId}, ${r.version}, ${jsonText(r.snapshot)}, ${r.changedByAgentId}) RETURNING *`);
  }

  listMetricVersions(metricId: string): Promise<MetricVersionRow[]> {
    return this.db.query<MetricVersionRow>(sql`
      SELECT * FROM metric_versions WHERE "metricId" = ${metricId}
      ORDER BY version DESC, ${this.insertionOrder()} DESC`);
  }

  findMetricVersion(metricId: string, version: number): Promise<MetricVersionRow | null> {
    return this.db.get<MetricVersionRow>(sql`
      SELECT * FROM metric_versions WHERE "metricId" = ${metricId} AND version = ${version}`);
  }
}
