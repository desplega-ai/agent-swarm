import { jsonText } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlJoin, sqlList, sqlWhere } from "../sql";

/**
 * Domain: models (`model_catalog`, `model_catalog_meta`, `model_catalog_overlay`,
 * `model_groups`, `model_group_members`, `model_profiles`,
 * `model_alias_resolutions`, `harness_model_support`). Rows come back in the
 * SQLite value shape on every engine (flags 0/1, JSON as text, timestamps as
 * the value the column stores). The catalog tables, the overlay and
 * `harness_model_support` store epoch milliseconds as integers.
 */

export type ModelProfileRow = {
  id: string;
  name: string;
  harness: string;
  model: string;
  effort: string | null;
  allowCustomModel: number;
  description: string | null;
  seededFrom: string | null;
  credentialAllowlist: string | null;
  fallbacks: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

export type NewModelProfile = {
  id: string;
  name: string;
  harness: string;
  model: string;
  effort: string | null;
  allowCustomModel: boolean;
  description: string | null;
  seededFrom: string | null;
  credentialAllowlist: string | null;
  /** JSON array text. */
  fallbacks: string;
  actor: string | null;
  now: string;
};

/** Columns a profile update may set. `undefined` leaves a column unchanged. */
export type ModelProfileColumnUpdate = {
  model?: string;
  effort?: string | null;
  allowCustomModel?: boolean;
  description?: string | null;
  credentialAllowlist?: string | null;
  /** JSON array text. */
  fallbacks?: string;
};

export type ModelGroupRow = {
  id: string;
  name: string;
  description: string | null;
  seededFrom: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

export type NewModelGroup = {
  id: string;
  name: string;
  description: string | null;
  seededFrom: string | null;
  actor: string | null;
  now: string;
};

export type ModelGroupMemberRow = { groupId: string; profileName: string };

/**
 * The rule "a task still holds its profile or group" binds two values: the
 * oldest `finishedAt` the superseded-resume repair still covers, and the
 * failure reason of a superseded workflow-step cut (which gets no resume).
 */
export type TaskHoldWindow = {
  repairWindowStart: string;
  supersededWorkflowReason: string;
};

/** The fact columns shared by `model_catalog` and `model_catalog_overlay`. */
export type ModelCatalogFactRow = {
  provider: string;
  modelId: string;
  name: string | null;
  family: string | null;
  releaseDate: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  reasoning: number | null;
  reasoningOptions: string | null;
  pricing: string | null;
  status: string | null;
};

export type ModelCatalogRow = ModelCatalogFactRow & {
  providerName: string | null;
  checkedAt: number;
};

export type ModelCatalogOverlayRow = ModelCatalogFactRow & {
  reason: string;
  verifiedBy: string | null;
  expiresWhenUpstreamMatches: number;
  createdAt: number;
  updatedAt: number;
};

/** Fact values to write. JSON columns as text; `reasoning` as a JS boolean. */
export type ModelCatalogFactValues = {
  name: string | null;
  family: string | null;
  releaseDate: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  reasoning: boolean | null;
  reasoningOptions: string | null;
  pricing: string | null;
  status: string | null;
};

export type NewModelCatalogRow = ModelCatalogFactValues & {
  provider: string;
  modelId: string;
  providerName: string | null;
  checkedAt: number;
};

export type ModelCatalogOverlayUpsert = ModelCatalogFactValues & {
  provider: string;
  modelId: string;
  reason: string;
  verifiedBy: string | null;
  expiresWhenUpstreamMatches: boolean;
  /** Epoch ms: `createdAt` of a new row and `updatedAt`. */
  now: number;
  actor: string | null;
};

export type ModelCatalogMetaRow = {
  etag: string | null;
  lastModified: string | null;
  lastFetchAt: number | null;
  lastCheckedAt: number | null;
};

export type HarnessModelSupportStatusValue = "ok" | "unsupported" | "unknown";

export type HarnessModelSupportRecord = {
  harness: string;
  cliVersion: string;
  modelId: string;
  status: HarnessModelSupportStatusValue;
  checkedAt: number;
  error: string | null;
};

export interface ModelsRepository {
  // ─── Profiles ──────────────────────────────────────────────────────────────
  /** Ordered by harness, then name (unique). */
  listProfiles(filter?: { harness?: string }): Promise<ModelProfileRow[]>;
  findProfileByName(name: string): Promise<ModelProfileRow | null>;
  /** Inserts the profile; null when the name is taken. */
  insertProfile(profile: NewModelProfile): Promise<ModelProfileRow | null>;
  /** Sets the given columns plus the audit columns; null when no profile has the name. */
  updateProfile(
    name: string,
    update: ModelProfileColumnUpdate,
    audit: { actor: string | null; now: string },
  ): Promise<ModelProfileRow | null>;
  /** The names in `names` that are profiles, ordered by name. */
  listExistingProfileNames(names: readonly string[]): Promise<string[]>;
  /** Every profile's name, harness and stored fallbacks text, ordered by name. */
  listProfileFallbackGraph(): Promise<{ name: string; harness: string; fallbacks: string }[]>;
  /** Tasks that still hold `name` as their asked or resolved profile. */
  countTasksHoldingProfile(name: string, window: TaskHoldWindow): Promise<number>;
  /**
   * Profiles other than `name` whose fallback list names it, ordered by name.
   * A name appears once per listing (duplicates possible when a stored list
   * repeats it).
   */
  listProfilesWithFallback(name: string): Promise<string[]>;
  /** Groups that list `profileName` as a member, ordered by group name. */
  listGroupsWithMember(profileName: string): Promise<string[]>;
  /**
   * Deletes the profile unless something still points at it (a holding task,
   * an agent default under `defaultConfigKey`, a schedule, another profile's
   * fallbacks, a group membership). The check is part of the statement. True
   * when a row was deleted.
   */
  deleteUnreferencedProfile(
    name: string,
    window: TaskHoldWindow,
    defaultConfigKey: string,
  ): Promise<boolean>;

  // ─── Groups ────────────────────────────────────────────────────────────────
  /** Ordered by name (unique). */
  listGroups(): Promise<ModelGroupRow[]>;
  findGroupByName(name: string): Promise<ModelGroupRow | null>;
  /** Members of one group, or of every group; ordered by group id, then position. */
  listGroupMembers(groupId?: string): Promise<ModelGroupMemberRow[]>;
  /** Inserts the group; null when the name is taken. */
  insertGroup(group: NewModelGroup): Promise<ModelGroupRow | null>;
  /** Replaces the group's member list; positions follow the array order. */
  replaceGroupMembers(groupId: string, members: readonly string[]): Promise<void>;
  /** Sets the description (when given) plus the audit columns. */
  updateGroup(
    id: string,
    update: { description?: string | null },
    audit: { actor: string | null; now: string },
  ): Promise<ModelGroupRow | null>;
  /** Tasks that still hold group `name`. */
  countTasksHoldingGroup(name: string, window: TaskHoldWindow): Promise<number>;
  /**
   * Deletes the group (members cascade) unless a task holds it or a schedule
   * names it. The check is part of the statement. True when a row was deleted.
   */
  deleteUnreferencedGroup(name: string, window: TaskHoldWindow): Promise<boolean>;
  /**
   * The group's members joined to their profiles, ordered by position. A group
   * with no members gives one row of nulls; no rows means no group.
   */
  listGroupMemberHarnesses(
    groupName: string,
  ): Promise<{ profile: string | null; harness: string | null }[]>;

  // ─── Catalog ───────────────────────────────────────────────────────────────
  /** Every catalog key, ordered by provider, then model id. */
  listCatalogKeys(): Promise<{ provider: string; modelId: string }[]>;
  deleteAllCatalog(): Promise<void>;
  insertCatalogRow(row: NewModelCatalogRow): Promise<void>;
  touchCatalogCheckedAt(now: number): Promise<void>;
  /** Ordered by provider, then model id. */
  listCatalog(): Promise<ModelCatalogRow[]>;
  countCatalog(): Promise<number>;
  getCatalogMeta(): Promise<ModelCatalogMetaRow | null>;
  /** Writes the single meta row. */
  upsertCatalogMeta(meta: ModelCatalogMetaRow): Promise<void>;
  /** Ordered by provider, then model id. */
  listOverlay(): Promise<ModelCatalogOverlayRow[]>;
  findOverlay(provider: string, modelId: string): Promise<ModelCatalogOverlayRow | null>;
  /** Insert, or update every column but `createdAt` and `created_by`. */
  upsertOverlay(row: ModelCatalogOverlayUpsert): Promise<void>;
  /** Number of rows deleted. */
  deleteOverlay(provider: string, modelId: string): Promise<number>;

  // ─── Alias resolutions ─────────────────────────────────────────────────────
  /** `newModel` of the newest resolution of `alias`, or null. */
  lastAliasResolution(alias: string): Promise<string | null>;
  insertAliasResolution(row: {
    alias: string;
    previousModel: string | null;
    newModel: string;
    changedAt: number;
  }): Promise<void>;

  // ─── Harness model support ─────────────────────────────────────────────────
  findHarnessModelSupport(
    harness: string,
    cliVersion: string,
    modelId: string,
  ): Promise<HarnessModelSupportRecord | null>;
  /** Newest `checkedAt` first. Ties come back in engine order (unspecified). */
  listHarnessModelSupport(filter?: {
    harness?: string;
    cliVersion?: string;
  }): Promise<HarnessModelSupportRecord[]>;
  /** Upsert one outcome. An `unknown` outcome keeps the stored status. */
  upsertHarnessModelSupport(row: HarnessModelSupportRecord): Promise<void>;
}

const MODEL_PROFILE_COLUMNS = sql`
  id, name, harness, model, effort, "allowCustomModel", description, "seededFrom",
  "credentialAllowlist", fallbacks, "createdAt", "lastUpdatedAt", created_by, updated_by`;

const HARNESS_SUPPORT_COLUMNS = sql`harness, "cliVersion", "modelId", status, "checkedAt", error`;

export abstract class BaseModelsRepository implements ModelsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  /**
   * Tasks (alias `t`) that still hold their profile or group: unfinished ones,
   * and superseded ones still owed a resume (inside the repair window). A
   * superseded workflow-step cut gets no resume, so it never holds one.
   */
  protected taskHolds(window: TaskHoldWindow): SqlQuery {
    return sql`(
      t.status NOT IN ('completed', 'failed', 'cancelled', 'superseded', 'skipped')
      OR (t.status = 'superseded'
          AND t."workflowRunStepId" IS NULL
          AND t."failureReason" IS DISTINCT FROM ${window.supersededWorkflowReason}
          AND (t."finishedAt" IS NULL OR t."finishedAt" > ${window.repairWindowStart})
          AND NOT EXISTS (
            SELECT 1 FROM agent_tasks c WHERE c."parentTaskId" = t.id AND c."taskType" = 'resume')))`;
  }

  // ─── Profiles ──────────────────────────────────────────────────────────────

  listProfiles(filter: { harness?: string } = {}): Promise<ModelProfileRow[]> {
    const where = filter.harness ? sql` WHERE harness = ${filter.harness}` : EMPTY;
    return this.db.query<ModelProfileRow>(
      sql`SELECT * FROM model_profiles${where} ORDER BY harness, name`,
    );
  }

  findProfileByName(name: string): Promise<ModelProfileRow | null> {
    return this.db.get<ModelProfileRow>(sql`SELECT * FROM model_profiles WHERE name = ${name}`);
  }

  insertProfile(p: NewModelProfile): Promise<ModelProfileRow | null> {
    return this.db.get<ModelProfileRow>(sql`
      INSERT INTO model_profiles (${MODEL_PROFILE_COLUMNS})
      VALUES (
        ${p.id}, ${p.name}, ${p.harness}, ${p.model}, ${p.effort}, ${p.allowCustomModel},
        ${p.description}, ${p.seededFrom}, ${jsonText(p.credentialAllowlist)}, ${jsonText(p.fallbacks)},
        ${p.now}, ${p.now}, ${p.actor}, ${p.actor}
      )
      ON CONFLICT (name) DO NOTHING
      RETURNING *`);
  }

  updateProfile(
    name: string,
    u: ModelProfileColumnUpdate,
    audit: { actor: string | null; now: string },
  ): Promise<ModelProfileRow | null> {
    const sets: SqlQuery[] = [];
    if (u.model !== undefined) sets.push(sql`model = ${u.model}`);
    if (u.effort !== undefined) sets.push(sql`effort = ${u.effort}`);
    if (u.allowCustomModel !== undefined)
      sets.push(sql`"allowCustomModel" = ${u.allowCustomModel}`);
    if (u.description !== undefined) sets.push(sql`description = ${u.description}`);
    if (u.credentialAllowlist !== undefined)
      sets.push(sql`"credentialAllowlist" = ${jsonText(u.credentialAllowlist)}`);
    if (u.fallbacks !== undefined) sets.push(sql`fallbacks = ${jsonText(u.fallbacks)}`);
    sets.push(sql`"lastUpdatedAt" = ${audit.now}`, sql`updated_by = ${audit.actor}`);
    return this.db.get<ModelProfileRow>(
      sql`UPDATE model_profiles SET ${sqlJoin(sets, sql`, `)} WHERE name = ${name} RETURNING *`,
    );
  }

  async listExistingProfileNames(names: readonly string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const rows = await this.db.query<{ name: string }>(
      sql`SELECT name FROM model_profiles WHERE name IN (${sqlList(names)}) ORDER BY name`,
    );
    return rows.map((row) => row.name);
  }

  listProfileFallbackGraph(): Promise<{ name: string; harness: string; fallbacks: string }[]> {
    return this.db.query<{ name: string; harness: string; fallbacks: string }>(
      sql`SELECT name, harness, fallbacks FROM model_profiles ORDER BY name`,
    );
  }

  async countTasksHoldingProfile(name: string, window: TaskHoldWindow): Promise<number> {
    const row = await this.db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM agent_tasks t
       WHERE (t.profile = ${name} OR t."resolvedProfile" = ${name}) AND ${this.taskHolds(window)}`);
    return Number(row?.n ?? 0);
  }

  /** Reads JSON arrays stored as text: engine-specific. */
  abstract listProfilesWithFallback(name: string): Promise<string[]>;

  async listGroupsWithMember(profileName: string): Promise<string[]> {
    const rows = await this.db.query<{ name: string }>(sql`
      SELECT g.name FROM model_group_members m JOIN model_groups g ON g.id = m."groupId"
       WHERE m."profileName" = ${profileName} ORDER BY g.name`);
    return rows.map((row) => row.name);
  }

  /** Reads JSON arrays stored as text: engine-specific. */
  abstract deleteUnreferencedProfile(
    name: string,
    window: TaskHoldWindow,
    defaultConfigKey: string,
  ): Promise<boolean>;

  // ─── Groups ────────────────────────────────────────────────────────────────

  listGroups(): Promise<ModelGroupRow[]> {
    return this.db.query<ModelGroupRow>(sql`SELECT * FROM model_groups ORDER BY name`);
  }

  findGroupByName(name: string): Promise<ModelGroupRow | null> {
    return this.db.get<ModelGroupRow>(sql`SELECT * FROM model_groups WHERE name = ${name}`);
  }

  listGroupMembers(groupId?: string): Promise<ModelGroupMemberRow[]> {
    const where = groupId === undefined ? EMPTY : sql` WHERE "groupId" = ${groupId}`;
    return this.db.query<ModelGroupMemberRow>(sql`
      SELECT "groupId", "profileName" FROM model_group_members${where}
       ORDER BY "groupId", position`);
  }

  insertGroup(g: NewModelGroup): Promise<ModelGroupRow | null> {
    return this.db.get<ModelGroupRow>(sql`
      INSERT INTO model_groups
        (id, name, description, "seededFrom", "createdAt", "lastUpdatedAt", created_by, updated_by)
      VALUES (${g.id}, ${g.name}, ${g.description}, ${g.seededFrom}, ${g.now}, ${g.now}, ${g.actor}, ${g.actor})
      ON CONFLICT (name) DO NOTHING
      RETURNING *`);
  }

  async replaceGroupMembers(groupId: string, members: readonly string[]): Promise<void> {
    await this.db.run(sql`DELETE FROM model_group_members WHERE "groupId" = ${groupId}`);
    for (const [position, profileName] of members.entries()) {
      await this.db.run(sql`
        INSERT INTO model_group_members ("groupId", position, "profileName")
        VALUES (${groupId}, ${position}, ${profileName})`);
    }
  }

  updateGroup(
    id: string,
    update: { description?: string | null },
    audit: { actor: string | null; now: string },
  ): Promise<ModelGroupRow | null> {
    const sets: SqlQuery[] = [
      sql`"lastUpdatedAt" = ${audit.now}`,
      sql`updated_by = ${audit.actor}`,
    ];
    if (update.description !== undefined) sets.push(sql`description = ${update.description}`);
    return this.db.get<ModelGroupRow>(
      sql`UPDATE model_groups SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  async countTasksHoldingGroup(name: string, window: TaskHoldWindow): Promise<number> {
    const row = await this.db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM agent_tasks t
       WHERE t."modelGroup" = ${name} AND ${this.taskHolds(window)}`);
    return Number(row?.n ?? 0);
  }

  async deleteUnreferencedGroup(name: string, window: TaskHoldWindow): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(sql`
      DELETE FROM model_groups
       WHERE name = ${name}
         AND NOT EXISTS (
           SELECT 1 FROM agent_tasks t
            WHERE t."modelGroup" = model_groups.name AND ${this.taskHolds(window)})
         AND NOT EXISTS (
           SELECT 1 FROM scheduled_tasks s WHERE s."modelGroup" = model_groups.name)
       RETURNING id`);
    return row !== null;
  }

  listGroupMemberHarnesses(
    groupName: string,
  ): Promise<{ profile: string | null; harness: string | null }[]> {
    return this.db.query<{ profile: string | null; harness: string | null }>(sql`
      SELECT m."profileName" AS profile, p.harness AS harness
        FROM model_groups g
        LEFT JOIN model_group_members m ON m."groupId" = g.id
        LEFT JOIN model_profiles p ON p.name = m."profileName"
       WHERE g.name = ${groupName}
       ORDER BY m.position`);
  }

  // ─── Catalog ───────────────────────────────────────────────────────────────

  listCatalogKeys(): Promise<{ provider: string; modelId: string }[]> {
    return this.db.query<{ provider: string; modelId: string }>(
      sql`SELECT provider, "modelId" FROM model_catalog ORDER BY provider, "modelId"`,
    );
  }

  async deleteAllCatalog(): Promise<void> {
    await this.db.run(sql`DELETE FROM model_catalog`);
  }

  async insertCatalogRow(r: NewModelCatalogRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO model_catalog
        (provider, "modelId", name, family, "releaseDate", "contextWindow", "maxOutput", reasoning,
         "reasoningOptions", pricing, status, "providerName", "checkedAt")
      VALUES (
        ${r.provider}, ${r.modelId}, ${r.name}, ${r.family}, ${r.releaseDate}, ${r.contextWindow},
        ${r.maxOutput}, ${r.reasoning}, ${jsonText(r.reasoningOptions)}, ${r.pricing}, ${r.status},
        ${r.providerName}, ${r.checkedAt}
      )`);
  }

  async touchCatalogCheckedAt(now: number): Promise<void> {
    await this.db.run(sql`UPDATE model_catalog SET "checkedAt" = ${now}`);
  }

  listCatalog(): Promise<ModelCatalogRow[]> {
    return this.db.query<ModelCatalogRow>(
      sql`SELECT * FROM model_catalog ORDER BY provider, "modelId"`,
    );
  }

  async countCatalog(): Promise<number> {
    const row = await this.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM model_catalog`);
    return Number(row?.n ?? 0);
  }

  getCatalogMeta(): Promise<ModelCatalogMetaRow | null> {
    return this.db.get<ModelCatalogMetaRow>(sql`
      SELECT etag, "lastModified", "lastFetchAt", "lastCheckedAt"
        FROM model_catalog_meta WHERE id = 1`);
  }

  async upsertCatalogMeta(m: ModelCatalogMetaRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO model_catalog_meta (id, etag, "lastModified", "lastFetchAt", "lastCheckedAt")
      VALUES (1, ${m.etag}, ${m.lastModified}, ${m.lastFetchAt}, ${m.lastCheckedAt})
      ON CONFLICT (id) DO UPDATE SET
        etag = excluded.etag,
        "lastModified" = excluded."lastModified",
        "lastFetchAt" = excluded."lastFetchAt",
        "lastCheckedAt" = excluded."lastCheckedAt"`);
  }

  listOverlay(): Promise<ModelCatalogOverlayRow[]> {
    return this.db.query<ModelCatalogOverlayRow>(
      sql`SELECT * FROM model_catalog_overlay ORDER BY provider, "modelId"`,
    );
  }

  findOverlay(provider: string, modelId: string): Promise<ModelCatalogOverlayRow | null> {
    return this.db.get<ModelCatalogOverlayRow>(sql`
      SELECT * FROM model_catalog_overlay WHERE provider = ${provider} AND "modelId" = ${modelId}`);
  }

  async upsertOverlay(r: ModelCatalogOverlayUpsert): Promise<void> {
    await this.db.run(sql`
      INSERT INTO model_catalog_overlay
        (provider, "modelId", name, family, "releaseDate", "contextWindow", "maxOutput", reasoning,
         "reasoningOptions", pricing, status, reason, "verifiedBy", "expiresWhenUpstreamMatches",
         "createdAt", "updatedAt", created_by, updated_by)
      VALUES (
        ${r.provider}, ${r.modelId}, ${r.name}, ${r.family}, ${r.releaseDate}, ${r.contextWindow},
        ${r.maxOutput}, ${r.reasoning}, ${r.reasoningOptions}, ${r.pricing}, ${r.status},
        ${r.reason}, ${r.verifiedBy}, ${r.expiresWhenUpstreamMatches},
        ${r.now}, ${r.now}, ${r.actor}, ${r.actor}
      )
      ON CONFLICT (provider, "modelId") DO UPDATE SET
        name = excluded.name,
        family = excluded.family,
        "releaseDate" = excluded."releaseDate",
        "contextWindow" = excluded."contextWindow",
        "maxOutput" = excluded."maxOutput",
        reasoning = excluded.reasoning,
        "reasoningOptions" = excluded."reasoningOptions",
        pricing = excluded.pricing,
        status = excluded.status,
        reason = excluded.reason,
        "verifiedBy" = excluded."verifiedBy",
        "expiresWhenUpstreamMatches" = excluded."expiresWhenUpstreamMatches",
        "updatedAt" = excluded."updatedAt",
        updated_by = excluded.updated_by`);
  }

  async deleteOverlay(provider: string, modelId: string): Promise<number> {
    const result = await this.db.run(sql`
      DELETE FROM model_catalog_overlay WHERE provider = ${provider} AND "modelId" = ${modelId}`);
    return result.changes;
  }

  // ─── Alias resolutions ─────────────────────────────────────────────────────

  async lastAliasResolution(alias: string): Promise<string | null> {
    const row = await this.db.get<{ newModel: string }>(sql`
      SELECT "newModel" FROM model_alias_resolutions WHERE alias = ${alias}
       ORDER BY id DESC LIMIT 1`);
    return row?.newModel ?? null;
  }

  async insertAliasResolution(r: {
    alias: string;
    previousModel: string | null;
    newModel: string;
    changedAt: number;
  }): Promise<void> {
    await this.db.run(sql`
      INSERT INTO model_alias_resolutions (alias, "previousModel", "newModel", "changedAt")
      VALUES (${r.alias}, ${r.previousModel}, ${r.newModel}, ${r.changedAt})`);
  }

  // ─── Harness model support ─────────────────────────────────────────────────

  findHarnessModelSupport(
    harness: string,
    cliVersion: string,
    modelId: string,
  ): Promise<HarnessModelSupportRecord | null> {
    return this.db.get<HarnessModelSupportRecord>(sql`
      SELECT ${HARNESS_SUPPORT_COLUMNS} FROM harness_model_support
       WHERE harness = ${harness} AND "cliVersion" = ${cliVersion} AND "modelId" = ${modelId}`);
  }

  listHarnessModelSupport(
    filter: { harness?: string; cliVersion?: string } = {},
  ): Promise<HarnessModelSupportRecord[]> {
    const conditions: SqlQuery[] = [];
    if (filter.harness) conditions.push(sql`harness = ${filter.harness}`);
    if (filter.cliVersion) conditions.push(sql`"cliVersion" = ${filter.cliVersion}`);
    return this.db.query<HarnessModelSupportRecord>(sql`
      SELECT ${HARNESS_SUPPORT_COLUMNS} FROM harness_model_support${sqlWhere(conditions)}
       ORDER BY "checkedAt" DESC`);
  }

  async upsertHarnessModelSupport(r: HarnessModelSupportRecord): Promise<void> {
    await this.db.run(sql`
      INSERT INTO harness_model_support (${HARNESS_SUPPORT_COLUMNS})
      VALUES (${r.harness}, ${r.cliVersion}, ${r.modelId}, ${r.status}, ${r.checkedAt}, ${r.error})
      ON CONFLICT (harness, "cliVersion", "modelId") DO UPDATE SET
        status = CASE WHEN excluded.status = 'unknown' THEN harness_model_support.status ELSE excluded.status END,
        "checkedAt" = excluded."checkedAt",
        error = excluded.error`);
  }
}
