import { jsonText } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlJoin, sqlList, sqlWhere } from "../sql";

/**
 * Domain: config (`swarm_config`, `swarm_repos`, `api_key_status`,
 * `seed_state`). Rows come back in the SQLite value shape on every engine
 * (flags 0/1, JSON as text, timestamps as the text the column stores).
 */

export type SwarmConfigRow = {
  id: string;
  scope: string;
  scopeId: string | null;
  key: string;
  value: string;
  isSecret: number;
  envPath: string | null;
  description: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  encrypted: number;
  exportToEnv?: number;
  created_by?: string | null;
  updated_by?: string | null;
};

export type NewSwarmConfig = {
  id: string;
  scope: string;
  scopeId: string | null;
  key: string;
  value: string;
  isSecret: boolean;
  envPath: string | null;
  description: string | null;
  encrypted: boolean;
  exportToEnv: boolean;
  now: string;
};

export type SwarmConfigValueUpdate = {
  value: string;
  isSecret: boolean;
  envPath: string | null;
  description: string | null;
  encrypted: boolean;
  now: string;
  /** True forces `exportToEnv` off (an env-export restricted key). */
  forceNoExport: boolean;
  /** Null keeps the stored `exportToEnv`. */
  exportToEnv: boolean | null;
};

export type SwarmRepoRow = {
  id: string;
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: number;
  hooks: string | null;
  guidelines: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  created_by?: string | null;
  updated_by?: string | null;
};

export type NewSwarmRepo = {
  id: string;
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
  autoClone: boolean;
  hooks: string;
  guidelines: string | null;
  now: string;
};

/** Columns a repo update may set. `undefined` leaves a column unchanged. */
export type SwarmRepoColumnUpdate = {
  url?: string;
  name?: string;
  clonePath?: string;
  defaultBranch?: string;
  autoClone?: boolean;
  hooks?: string | null;
  guidelines?: string | null;
};

export type ApiKeyStatusRow = {
  id: string;
  keyType: string;
  keySuffix: string;
  keyIndex: number;
  scope: string;
  scopeId: string;
  status: "available" | "rate_limited";
  rateLimitedUntil: string | null;
  lastUsedAt: string | null;
  lastRateLimitAt: string | null;
  totalUsageCount: number;
  rateLimitCount: number;
  createdAt: string;
  updatedAt: string;
  name: string | null;
  provider: string;
  rateLimitWindows: string | null;
  plan: string | null;
  planSource: string | null;
  lastSeatMismatchAt: string | null;
  lastSeatMismatchModel: string | null;
  lastValidationError: string | null;
  lastValidationFailedAt: string | null;
  detectedPlanRaw: string | null;
  consecutiveAuthFailures: number;
  lastAuthFailureAt: string | null;
  authFailureSeq: number;
  providerAccount: string | null;
  spendCap: string | null;
};

/** The natural key of one `api_key_status` row. `scopeId` is `''` for global. */
export type ApiKeyRef = {
  keyType: string;
  keySuffix: string;
  scope: string;
  scopeId: string;
};

/** The admission columns `getAvailableKeyIndices` reads. */
export type ApiKeyAdmissionRow = Pick<
  ApiKeyStatusRow,
  | "keyIndex"
  | "keySuffix"
  | "scope"
  | "scopeId"
  | "status"
  | "rateLimitWindows"
  | "plan"
  | "authFailureSeq"
  | "lastValidationFailedAt"
  | "spendCap"
>;

/** Rows of one key type: by suffix across every scope, or by scope. */
export type ApiKeyRowFilter =
  | { keyType: string; suffixes: string[] }
  | { keyType: string; scope: string; scopeId: string };

export type SeedStateRow = {
  kind: string;
  key: string;
  seededHash: string;
  seededAt: string;
};

export interface ConfigRepository {
  // ---- swarm_config ----
  /**
   * Config rows matching every given filter. Ordered by key, then insertion
   * order (a key may exist once per scope).
   */
  listConfigs(filters: {
    scope?: string;
    scopeId?: string;
    key?: string;
  }): Promise<SwarmConfigRow[]>;
  /**
   * Global rows whose upper-cased key is not in `excludedUpperKeys`. Ordered by
   * key, then insertion order.
   */
  listGlobalConfigsExcept(excludedUpperKeys: readonly string[]): Promise<SwarmConfigRow[]>;
  findConfigById(id: string): Promise<SwarmConfigRow | null>;
  /** The exact `(scope, scopeId, key)` row; a null `scopeId` matches NULL. */
  findConfigByScopeKey(
    scope: string,
    scopeId: string | null,
    key: string,
  ): Promise<SwarmConfigRow | null>;
  insertConfig(row: NewSwarmConfig): Promise<SwarmConfigRow | null>;
  updateConfigValue(id: string, update: SwarmConfigValueUpdate): Promise<SwarmConfigRow | null>;
  /** Deletes the row and returns it, or null when none existed. */
  deleteConfig(id: string): Promise<SwarmConfigRow | null>;
  /** Rows flagged secret or stored encrypted (all scopes). Insertion order. */
  listSecretConfigs(): Promise<{ key: string; value: string; encrypted: number }[]>;
  /**
   * Global `codex_oauth` and `codex_oauth_<digit>...` rows. Insertion order; the
   * caller sorts by slot.
   */
  listCodexOauthConfigs(): Promise<{ key: string; value: string; encrypted: number }[]>;

  // ---- swarm_repos ----
  /** Ordered by name (unique). */
  listRepos(filters: { autoClone?: boolean; name?: string }): Promise<SwarmRepoRow[]>;
  findRepoById(id: string): Promise<SwarmRepoRow | null>;
  findRepoByName(name: string): Promise<SwarmRepoRow | null>;
  findRepoByUrl(url: string): Promise<SwarmRepoRow | null>;
  insertRepo(repo: NewSwarmRepo): Promise<SwarmRepoRow | null>;
  /** Sets the given columns plus `lastUpdatedAt`. */
  updateRepo(id: string, update: SwarmRepoColumnUpdate, now: string): Promise<SwarmRepoRow | null>;
  deleteRepo(id: string): Promise<number>;

  // ---- seed_state ----
  getSeedState(kind: string, key: string): Promise<SeedStateRow | null>;
  /** Insert, or refresh the hash and time of the `(kind, key)` row. */
  upsertSeedState(row: SeedStateRow): Promise<void>;
  deleteSeedState(kind: string, key: string): Promise<void>;

  // ---- api_key_status ----
  /**
   * Name and plan columns of every row: manual plans first, then detected,
   * estimated, other; newest update first; then insertion order.
   */
  listKeyLabels(): Promise<
    Pick<ApiKeyStatusRow, "keyType" | "keySuffix" | "name" | "plan" | "planSource">[]
  >;
  /**
   * All rows matching the filters, by key index. Ties: with `keyType`, by
   * scope, scopeId, status, then insertion order; without, insertion order.
   */
  listKeyStatuses(filters: {
    keyType?: string;
    scope?: string;
    scopeId?: string;
  }): Promise<ApiKeyStatusRow[]>;
  /** Lifts expired rate limits (never an auth bench at `benchThreshold`). */
  clearExpiredRateLimits(
    filter: ApiKeyRowFilter,
    now: string,
    benchThreshold: number,
  ): Promise<void>;
  /**
   * Admission columns of the matching rows. A suffix filter orders by suffix,
   * scope, scopeId (unique); a scope filter by status, then insertion order.
   */
  listAdmissionRows(filter: ApiKeyRowFilter): Promise<ApiKeyAdmissionRow[]>;
  /** True when a row of `keyType` has one of `suffixes`, at the agent's scope or global. */
  hasKeySuffix(keyType: string, suffixes: string[], agentId: string): Promise<boolean>;
  /** Upsert: counts one use, refreshes `lastUsedAt` and the index. */
  upsertKeyUsage(ref: ApiKeyRef, keyIndex: number, provider: string, now: string): Promise<void>;
  /** Upsert that only refreshes the index and provider. */
  touchKey(ref: ApiKeyRef, keyIndex: number, provider: string, now: string): Promise<void>;
  /** Sets `detectedPlanRaw` on every scope row of the key. */
  setDetectedPlanRaw(keyType: string, keySuffix: string, raw: string | null): Promise<void>;
  /**
   * Sets `plan`/`planSource='detected'` on every scope row of the key whose
   * plan is not manual and differs. Returns the changed row count.
   */
  setDetectedPlan(keyType: string, keySuffix: string, plan: string | null): Promise<number>;
  /**
   * Sets `plan`/`planSource='detected'` on every scope row of the key whose
   * plan is not manual, also when it already holds that plan. Returns the
   * changed row count.
   */
  setDetectedPlanUnlessManual(keyType: string, keySuffix: string, plan: string): Promise<number>;
  /** Sets a manual plan on every scope row, or (plan null) drops a manual one. */
  setManualPlan(
    keyType: string,
    keySuffix: string,
    plan: string | null,
    now: string,
  ): Promise<number>;
  /** Sets the seat-mismatch columns on every scope row of the key. */
  setSeatMismatch(keyType: string, keySuffix: string, model: string, now: string): Promise<void>;
  getKeyPlan(ref: ApiKeyRef): Promise<string | null | undefined>;
  /** Upsert: marks the key rate limited; never shortens an auth bench at `benchThreshold`. */
  markRateLimited(
    ref: ApiKeyRef,
    v: {
      keyIndex: number;
      rateLimitedUntil: string;
      spendCap: string | null;
      provider: string;
      now: string;
      benchThreshold: number;
    },
  ): Promise<void>;
  /** Upsert: counts one auth failure with the next global `authFailureSeq`. */
  recordAuthFailure(
    ref: ApiKeyRef,
    keyIndex: number,
    provider: string,
    now: string,
  ): Promise<{ consecutiveAuthFailures: number; rateLimitedUntil: string | null } | null>;
  benchKey(ref: ApiKeyRef, rateLimitedUntil: string, now: string): Promise<void>;
  getRateLimitWindows(
    ref: ApiKeyRef,
  ): Promise<{ rateLimitWindows: string | null; providerAccount: string | null } | null>;
  /** Upsert of the window and account snapshots. */
  upsertRateLimitWindows(
    ref: ApiKeyRef,
    v: {
      keyIndex: number;
      rateLimitWindows: string;
      providerAccount: string | null;
      provider: string;
      now: string;
    },
  ): Promise<void>;
  setKeyName(ref: ApiKeyRef, name: string | null, now: string): Promise<number>;
  /**
   * Clears a rate limit on every scope row of the key. With `liftAuthBench`
   * a bench whose `authFailureSeq <= authFence` is lifted too.
   */
  clearRateLimit(
    keyType: string,
    keySuffix: string,
    v: { now: string; liftAuthBench: boolean; authFence: number | null; benchThreshold: number },
  ): Promise<number>;
  /**
   * Resets the auth failure count of the key (rows at or under `authFence`) and
   * retires other logins at the same slot of the scope. Returns the suffixes
   * of the rows it changed, in no stated order (callers treat it as a set).
   */
  liftAuthBench(
    ref: ApiKeyRef,
    v: { keyIndex: number; authFence: number | null; now: string },
  ): Promise<string[]>;
  /** Upsert: stores a live-test result (null error clears it). */
  upsertValidation(
    ref: ApiKeyRef,
    v: {
      keyIndex: number;
      error: string | null;
      failedAt: string | null;
      provider: string;
      now: string;
    },
  ): Promise<void>;
  /** Clears the validation rejection of the key in every scope. */
  clearValidation(keyType: string, keySuffix: string, now: string): Promise<void>;
  /** Clears validation rejections of the scope whose suffix is not in `keepSuffixes`. */
  clearValidationExcept(
    keyType: string,
    scope: string,
    scopeId: string,
    keepSuffixes: string[],
    now: string,
  ): Promise<void>;
  /** Deletes the global row of the key. */
  deleteGlobalKey(keyType: string, keySuffix: string): Promise<void>;
  setGlobalKeyIndex(keyType: string, keySuffix: string, keyIndex: number): Promise<void>;
  /**
   * Deletes the global rows of `keyType` at `keyIndex` or with `keySuffix`.
   * Returns the deleted suffixes in no stated order (callers treat it as a set).
   */
  deleteGlobalKeysAtSlot(
    keyType: string,
    keyIndex: number,
    keySuffix: string | null,
  ): Promise<string[]>;
  /**
   * `scopeId`s of the agent-scoped rows of `key` whose value is exactly
   * `value`. Insertion order.
   */
  listAgentScopeIdsWithValue(key: string, value: string): Promise<string[]>;
  /**
   * Keys among `keys` set at `(scope, scopeId)`; `includeSecrets: false`
   * skips secret rows. Ordered by key (unique per scope and scopeId).
   */
  listScopedKeys(
    scope: string,
    scopeId: string,
    keys: readonly string[],
    opts: { includeSecrets: boolean },
  ): Promise<string[]>;
  /** Deletes the exact `(scope, scopeId, key)` rows; a null `scopeId` matches NULL. Returns the count. */
  deleteConfigByScopeKey(scope: string, scopeId: string | null, key: string): Promise<number>;
  /** Name and url of every repo. Insertion order. */
  listRepoNamesAndUrls(): Promise<{ name: string | null; url: string | null }[]>;
}

const scopeIdIs = (scopeId: string | null): SqlQuery =>
  scopeId === null ? sql`"scopeId" IS NULL` : sql`"scopeId" = ${scopeId}`;

const refWhere = (ref: ApiKeyRef): SqlQuery =>
  sql`"keyType" = ${ref.keyType} AND "keySuffix" = ${ref.keySuffix} AND scope = ${ref.scope} AND "scopeId" = ${ref.scopeId}`;

export const apiKeyRowFilter = (filter: ApiKeyRowFilter): SqlQuery =>
  "suffixes" in filter
    ? sql`"keyType" = ${filter.keyType} AND "keySuffix" IN (${sqlList(filter.suffixes)})`
    : sql`"keyType" = ${filter.keyType} AND scope = ${filter.scope} AND "scopeId" = ${filter.scopeId}`;

export abstract class BaseConfigRepository implements ConfigRepository {
  constructor(protected readonly db: SqlExecutor) {}

  // ---- swarm_config ----

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listConfigs(filters: {
    scope?: string;
    scopeId?: string;
    key?: string;
  }): Promise<SwarmConfigRow[]>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listGlobalConfigsExcept(excludedUpperKeys: readonly string[]): Promise<SwarmConfigRow[]>;

  protected configFilters(filters: { scope?: string; scopeId?: string; key?: string }): SqlQuery {
    const conditions: SqlQuery[] = [];
    if (filters.scope) conditions.push(sql`scope = ${filters.scope}`);
    if (filters.scopeId) conditions.push(sql`"scopeId" = ${filters.scopeId}`);
    if (filters.key) conditions.push(sql`key = ${filters.key}`);
    return sqlWhere(conditions);
  }

  findConfigById(id: string): Promise<SwarmConfigRow | null> {
    return this.db.get<SwarmConfigRow>(sql`SELECT * FROM swarm_config WHERE id = ${id}`);
  }

  findConfigByScopeKey(
    scope: string,
    scopeId: string | null,
    key: string,
  ): Promise<SwarmConfigRow | null> {
    return this.db.get<SwarmConfigRow>(
      sql`SELECT * FROM swarm_config WHERE scope = ${scope} AND ${scopeIdIs(scopeId)} AND key = ${key}`,
    );
  }

  insertConfig(r: NewSwarmConfig): Promise<SwarmConfigRow | null> {
    return this.db.get<SwarmConfigRow>(sql`
      INSERT INTO swarm_config (
        id, scope, "scopeId", key, value, "isSecret", "envPath", description,
        "createdAt", "lastUpdatedAt", encrypted, "exportToEnv"
      ) VALUES (
        ${r.id}, ${r.scope}, ${r.scopeId}, ${r.key}, ${r.value}, ${r.isSecret}, ${r.envPath}, ${r.description},
        ${r.now}, ${r.now}, ${r.encrypted}, ${r.exportToEnv}
      ) RETURNING *`);
  }

  updateConfigValue(id: string, u: SwarmConfigValueUpdate): Promise<SwarmConfigRow | null> {
    return this.db.get<SwarmConfigRow>(sql`
      UPDATE swarm_config SET
        value = ${u.value}, "isSecret" = ${u.isSecret}, "envPath" = ${u.envPath},
        description = ${u.description}, encrypted = ${u.encrypted}, "lastUpdatedAt" = ${u.now},
        "exportToEnv" = CASE WHEN ${u.forceNoExport} THEN ${false} ELSE COALESCE(${u.exportToEnv}, "exportToEnv") END
      WHERE id = ${id} RETURNING *`);
  }

  deleteConfig(id: string): Promise<SwarmConfigRow | null> {
    return this.db.get<SwarmConfigRow>(sql`DELETE FROM swarm_config WHERE id = ${id} RETURNING *`);
  }

  /** Insertion-order differs per engine (SQLite `rowid`). */
  abstract listSecretConfigs(): Promise<{ key: string; value: string; encrypted: number }[]>;
  /** SQLite GLOB pattern; insertion order. */
  abstract listCodexOauthConfigs(): Promise<{ key: string; value: string; encrypted: number }[]>;

  // ---- swarm_repos ----

  listRepos(filters: { autoClone?: boolean; name?: string }): Promise<SwarmRepoRow[]> {
    const conditions: SqlQuery[] = [];
    if (filters.autoClone !== undefined) conditions.push(sql`"autoClone" = ${filters.autoClone}`);
    if (filters.name) conditions.push(sql`name = ${filters.name}`);
    return this.db.query<SwarmRepoRow>(
      sql`SELECT * FROM swarm_repos${sqlWhere(conditions)} ORDER BY name ASC`,
    );
  }

  findRepoById(id: string): Promise<SwarmRepoRow | null> {
    return this.db.get<SwarmRepoRow>(sql`SELECT * FROM swarm_repos WHERE id = ${id}`);
  }

  findRepoByName(name: string): Promise<SwarmRepoRow | null> {
    return this.db.get<SwarmRepoRow>(sql`SELECT * FROM swarm_repos WHERE name = ${name}`);
  }

  findRepoByUrl(url: string): Promise<SwarmRepoRow | null> {
    return this.db.get<SwarmRepoRow>(sql`SELECT * FROM swarm_repos WHERE url = ${url}`);
  }

  insertRepo(r: NewSwarmRepo): Promise<SwarmRepoRow | null> {
    return this.db.get<SwarmRepoRow>(sql`
      INSERT INTO swarm_repos (
        id, url, name, "clonePath", "defaultBranch", "autoClone", hooks, guidelines,
        "createdAt", "lastUpdatedAt"
      ) VALUES (
        ${r.id}, ${r.url}, ${r.name}, ${r.clonePath}, ${r.defaultBranch}, ${r.autoClone},
        ${r.hooks}, ${r.guidelines}, ${r.now}, ${r.now}
      ) RETURNING *`);
  }

  updateRepo(id: string, u: SwarmRepoColumnUpdate, now: string): Promise<SwarmRepoRow | null> {
    const sets: SqlQuery[] = [];
    if (u.url !== undefined) sets.push(sql`url = ${u.url}`);
    if (u.name !== undefined) sets.push(sql`name = ${u.name}`);
    if (u.clonePath !== undefined) sets.push(sql`"clonePath" = ${u.clonePath}`);
    if (u.defaultBranch !== undefined) sets.push(sql`"defaultBranch" = ${u.defaultBranch}`);
    if (u.autoClone !== undefined) sets.push(sql`"autoClone" = ${u.autoClone}`);
    if (u.hooks !== undefined) sets.push(sql`hooks = ${u.hooks}`);
    if (u.guidelines !== undefined) sets.push(sql`guidelines = ${u.guidelines}`);
    sets.push(sql`"lastUpdatedAt" = ${now}`);
    return this.db.get<SwarmRepoRow>(
      sql`UPDATE swarm_repos SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  async deleteRepo(id: string): Promise<number> {
    const result = await this.db.run(sql`DELETE FROM swarm_repos WHERE id = ${id}`);
    return result.changes;
  }

  // ---- seed_state ----

  getSeedState(kind: string, key: string): Promise<SeedStateRow | null> {
    return this.db.get<SeedStateRow>(
      sql`SELECT kind, key, "seededHash", "seededAt" FROM seed_state WHERE kind = ${kind} AND key = ${key}`,
    );
  }

  async upsertSeedState(r: SeedStateRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO seed_state (kind, key, "seededHash", "seededAt")
      VALUES (${r.kind}, ${r.key}, ${r.seededHash}, ${r.seededAt})
      ON CONFLICT (kind, key) DO UPDATE SET
        "seededHash" = excluded."seededHash",
        "seededAt" = excluded."seededAt"`);
  }

  async deleteSeedState(kind: string, key: string): Promise<void> {
    await this.db.run(sql`DELETE FROM seed_state WHERE kind = ${kind} AND key = ${key}`);
  }

  // ---- api_key_status ----

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listKeyLabels(): Promise<
    Pick<ApiKeyStatusRow, "keyType" | "keySuffix" | "name" | "plan" | "planSource">[]
  >;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listKeyStatuses(filters: {
    keyType?: string;
    scope?: string;
    scopeId?: string;
  }): Promise<ApiKeyStatusRow[]>;
  /** Insertion order differs per engine (SQLite `rowid`). */
  abstract listAdmissionRows(filter: ApiKeyRowFilter): Promise<ApiKeyAdmissionRow[]>;

  protected keyStatusFilters(filters: {
    keyType?: string;
    scope?: string;
    scopeId?: string;
  }): SqlQuery {
    const conditions: SqlQuery[] = [];
    if (filters.keyType) conditions.push(sql`"keyType" = ${filters.keyType}`);
    if (filters.scope) {
      conditions.push(sql`scope = ${filters.scope}`);
      if (filters.scopeId !== undefined) conditions.push(sql`"scopeId" = ${filters.scopeId}`);
    }
    return sqlWhere(conditions);
  }

  async clearExpiredRateLimits(
    filter: ApiKeyRowFilter,
    now: string,
    benchThreshold: number,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE api_key_status
      SET status = 'available', "rateLimitedUntil" = NULL, "spendCap" = NULL, "updatedAt" = ${now}
      WHERE ${apiKeyRowFilter(filter)}
        AND status = 'rate_limited' AND "rateLimitedUntil" <= ${now}
        AND "consecutiveAuthFailures" < ${benchThreshold}`);
  }

  async hasKeySuffix(keyType: string, suffixes: string[], agentId: string): Promise<boolean> {
    if (suffixes.length === 0) return false;
    const row = await this.db.get<{ n: number | string }>(sql`
      SELECT COUNT(*) AS n FROM api_key_status
      WHERE "keyType" = ${keyType}
        AND "keySuffix" IN (${sqlList(suffixes)})
        AND ((scope = 'agent' AND "scopeId" = ${agentId}) OR scope = 'global')`);
    return Number(row?.n ?? 0) > 0;
  }

  async upsertKeyUsage(
    ref: ApiKeyRef,
    keyIndex: number,
    provider: string,
    now: string,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO api_key_status (
        "keyType", "keySuffix", "keyIndex", scope, "scopeId", "lastUsedAt", "totalUsageCount", provider, "updatedAt"
      ) VALUES (
        ${ref.keyType}, ${ref.keySuffix}, ${keyIndex}, ${ref.scope}, ${ref.scopeId}, ${now}, 1, ${provider}, ${now}
      )
      ON CONFLICT ("keyType", "keySuffix", scope, "scopeId")
      DO UPDATE SET
        "lastUsedAt" = excluded."lastUsedAt",
        "totalUsageCount" = api_key_status."totalUsageCount" + 1,
        "keyIndex" = excluded."keyIndex",
        "updatedAt" = excluded."updatedAt"`);
  }

  async touchKey(ref: ApiKeyRef, keyIndex: number, provider: string, now: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO api_key_status ("keyType", "keySuffix", "keyIndex", scope, "scopeId", provider, "updatedAt")
      VALUES (${ref.keyType}, ${ref.keySuffix}, ${keyIndex}, ${ref.scope}, ${ref.scopeId}, ${provider}, ${now})
      ON CONFLICT ("keyType", "keySuffix", scope, "scopeId")
      DO UPDATE SET
        "keyIndex" = excluded."keyIndex",
        provider = excluded.provider,
        "updatedAt" = excluded."updatedAt"`);
  }

  async setDetectedPlanRaw(keyType: string, keySuffix: string, raw: string | null): Promise<void> {
    await this.db.run(sql`
      UPDATE api_key_status SET "detectedPlanRaw" = ${raw}
      WHERE "keyType" = ${keyType} AND "keySuffix" = ${keySuffix}`);
  }

  async setDetectedPlan(keyType: string, keySuffix: string, plan: string | null): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE api_key_status SET plan = ${plan}, "planSource" = 'detected'
      WHERE "keyType" = ${keyType} AND "keySuffix" = ${keySuffix}
        AND COALESCE("planSource", '') != 'manual'
        AND (plan IS DISTINCT FROM ${plan} OR "planSource" IS DISTINCT FROM 'detected')`);
    return result.changes;
  }

  async setDetectedPlanUnlessManual(
    keyType: string,
    keySuffix: string,
    plan: string,
  ): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE api_key_status SET plan = ${plan}, "planSource" = 'detected'
      WHERE "keyType" = ${keyType} AND "keySuffix" = ${keySuffix}
        AND COALESCE("planSource", '') != 'manual'`);
    return result.changes;
  }

  async setManualPlan(
    keyType: string,
    keySuffix: string,
    plan: string | null,
    now: string,
  ): Promise<number> {
    const result = plan
      ? await this.db.run(sql`
          UPDATE api_key_status SET plan = ${plan}, "planSource" = 'manual', "updatedAt" = ${now}
          WHERE "keyType" = ${keyType} AND "keySuffix" = ${keySuffix}`)
      : await this.db.run(sql`
          UPDATE api_key_status
          SET plan = CASE WHEN "planSource" = 'manual' THEN NULL ELSE plan END,
              "planSource" = CASE WHEN "planSource" = 'manual' THEN NULL ELSE "planSource" END,
              "updatedAt" = ${now}
          WHERE "keyType" = ${keyType} AND "keySuffix" = ${keySuffix}`);
    return result.changes;
  }

  async setSeatMismatch(
    keyType: string,
    keySuffix: string,
    model: string,
    now: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE api_key_status SET "lastSeatMismatchAt" = ${now}, "lastSeatMismatchModel" = ${model}
      WHERE "keyType" = ${keyType} AND "keySuffix" = ${keySuffix}`);
  }

  async getKeyPlan(ref: ApiKeyRef): Promise<string | null | undefined> {
    const row = await this.db.get<{ plan: string | null }>(
      sql`SELECT plan FROM api_key_status WHERE ${refWhere(ref)}`,
    );
    return row?.plan;
  }

  async markRateLimited(
    ref: ApiKeyRef,
    v: {
      keyIndex: number;
      rateLimitedUntil: string;
      spendCap: string | null;
      provider: string;
      now: string;
      benchThreshold: number;
    },
  ): Promise<void> {
    // SQLite's max(COALESCE(current, ''), incoming), written without the ''
    // sentinel (not a timestamp on Postgres): NULL when the incoming value is
    // NULL, else the later of the two, the incoming one when none is stored.
    const extended = sql`CASE
      WHEN excluded."rateLimitedUntil" IS NULL THEN NULL
      WHEN api_key_status."rateLimitedUntil" IS NULL
        OR excluded."rateLimitedUntil" > api_key_status."rateLimitedUntil"
      THEN excluded."rateLimitedUntil"
      ELSE api_key_status."rateLimitedUntil"
    END`;
    await this.db.run(sql`
      INSERT INTO api_key_status (
        "keyType", "keySuffix", "keyIndex", scope, "scopeId", status, "rateLimitedUntil",
        "lastRateLimitAt", "rateLimitCount", provider, "updatedAt", "spendCap"
      ) VALUES (
        ${ref.keyType}, ${ref.keySuffix}, ${v.keyIndex}, ${ref.scope}, ${ref.scopeId}, 'rate_limited', ${v.rateLimitedUntil},
        ${v.now}, 1, ${v.provider}, ${v.now}, ${v.spendCap}
      )
      ON CONFLICT ("keyType", "keySuffix", scope, "scopeId")
      DO UPDATE SET
        status = 'rate_limited',
        "rateLimitedUntil" = CASE
          WHEN api_key_status.status = 'rate_limited' AND api_key_status."consecutiveAuthFailures" >= ${v.benchThreshold}
          THEN ${extended}
          ELSE excluded."rateLimitedUntil"
        END,
        "spendCap" = excluded."spendCap",
        "lastRateLimitAt" = excluded."lastRateLimitAt",
        "rateLimitCount" = api_key_status."rateLimitCount" + 1,
        "keyIndex" = excluded."keyIndex",
        "updatedAt" = excluded."updatedAt"`);
  }

  recordAuthFailure(
    ref: ApiKeyRef,
    keyIndex: number,
    provider: string,
    now: string,
  ): Promise<{ consecutiveAuthFailures: number; rateLimitedUntil: string | null } | null> {
    return this.db.get(sql`
      INSERT INTO api_key_status (
        "keyType", "keySuffix", "keyIndex", scope, "scopeId", status, "consecutiveAuthFailures",
        "lastAuthFailureAt", "authFailureSeq", provider, "updatedAt"
      ) VALUES (
        ${ref.keyType}, ${ref.keySuffix}, ${keyIndex}, ${ref.scope}, ${ref.scopeId}, 'available', 1,
        ${now}, (SELECT COALESCE(MAX("authFailureSeq"), 0) + 1 FROM api_key_status), ${provider}, ${now}
      )
      ON CONFLICT ("keyType", "keySuffix", scope, "scopeId")
      DO UPDATE SET
        "consecutiveAuthFailures" = api_key_status."consecutiveAuthFailures" + 1,
        "lastAuthFailureAt" = excluded."lastAuthFailureAt", "authFailureSeq" = excluded."authFailureSeq",
        "keyIndex" = excluded."keyIndex", "updatedAt" = excluded."updatedAt"
      RETURNING "consecutiveAuthFailures", "rateLimitedUntil"`);
  }

  async benchKey(ref: ApiKeyRef, rateLimitedUntil: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE api_key_status
      SET status = 'rate_limited', "rateLimitedUntil" = ${rateLimitedUntil}, "lastRateLimitAt" = ${now},
          "rateLimitCount" = "rateLimitCount" + 1, "updatedAt" = ${now}
      WHERE ${refWhere(ref)}`);
  }

  getRateLimitWindows(
    ref: ApiKeyRef,
  ): Promise<{ rateLimitWindows: string | null; providerAccount: string | null } | null> {
    return this.db.get(
      sql`SELECT "rateLimitWindows", "providerAccount" FROM api_key_status WHERE ${refWhere(ref)}`,
    );
  }

  async upsertRateLimitWindows(
    ref: ApiKeyRef,
    v: {
      keyIndex: number;
      rateLimitWindows: string;
      providerAccount: string | null;
      provider: string;
      now: string;
    },
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO api_key_status (
        "keyType", "keySuffix", "keyIndex", scope, "scopeId", "rateLimitWindows", "providerAccount", provider, "updatedAt"
      ) VALUES (
        ${ref.keyType}, ${ref.keySuffix}, ${v.keyIndex}, ${ref.scope}, ${ref.scopeId}, ${jsonText(v.rateLimitWindows)},
        ${v.providerAccount}, ${v.provider}, ${v.now}
      )
      ON CONFLICT ("keyType", "keySuffix", scope, "scopeId")
      DO UPDATE SET
        "rateLimitWindows" = excluded."rateLimitWindows",
        "providerAccount" = excluded."providerAccount",
        "keyIndex" = excluded."keyIndex",
        provider = excluded.provider,
        "updatedAt" = excluded."updatedAt"`);
  }

  async setKeyName(ref: ApiKeyRef, name: string | null, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE api_key_status SET name = ${name}, "updatedAt" = ${now}
      WHERE ${refWhere(ref)}`);
    return result.changes;
  }

  async clearRateLimit(
    keyType: string,
    keySuffix: string,
    v: { now: string; liftAuthBench: boolean; authFence: number | null; benchThreshold: number },
  ): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE api_key_status
      SET status = 'available', "rateLimitedUntil" = NULL, "spendCap" = NULL, "updatedAt" = ${v.now}
      WHERE "keyType" = ${keyType} AND "keySuffix" = ${keySuffix}
        AND status = 'rate_limited'
        AND ((${v.liftAuthBench} AND "authFailureSeq" <= ${v.authFence})
          OR "consecutiveAuthFailures" < ${v.benchThreshold})`);
    return result.changes;
  }

  async liftAuthBench(
    ref: ApiKeyRef,
    v: { keyIndex: number; authFence: number | null; now: string },
  ): Promise<string[]> {
    const s = ref.keySuffix;
    const rows = await this.db.query<{ keySuffix: string }>(sql`
      UPDATE api_key_status SET "consecutiveAuthFailures" = 0, "updatedAt" = ${v.now},
        status = CASE WHEN "keySuffix" = ${s} THEN status ELSE 'available' END,
        "rateLimitedUntil" = CASE WHEN "keySuffix" = ${s} THEN "rateLimitedUntil" END,
        "spendCap" = CASE WHEN "keySuffix" = ${s} THEN "spendCap" END
      WHERE "keyType" = ${ref.keyType} AND ("consecutiveAuthFailures" > 0 OR status = 'rate_limited')
        AND (("keySuffix" = ${s} AND "authFailureSeq" <= ${v.authFence})
          OR ("keySuffix" != ${s} AND "keyIndex" = ${v.keyIndex} AND scope = ${ref.scope} AND "scopeId" = ${ref.scopeId}))
      RETURNING "keySuffix"`);
    return rows.map((row) => row.keySuffix);
  }

  async upsertValidation(
    ref: ApiKeyRef,
    v: {
      keyIndex: number;
      error: string | null;
      failedAt: string | null;
      provider: string;
      now: string;
    },
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO api_key_status (
        "keyType", "keySuffix", "keyIndex", scope, "scopeId", "lastValidationError",
        "lastValidationFailedAt", provider, "updatedAt"
      ) VALUES (
        ${ref.keyType}, ${ref.keySuffix}, ${v.keyIndex}, ${ref.scope}, ${ref.scopeId}, ${v.error},
        ${v.failedAt}, ${v.provider}, ${v.now}
      )
      ON CONFLICT ("keyType", "keySuffix", scope, "scopeId")
      DO UPDATE SET "lastValidationError" = excluded."lastValidationError",
        "lastValidationFailedAt" = excluded."lastValidationFailedAt",
        "keyIndex" = excluded."keyIndex", "updatedAt" = excluded."updatedAt"`);
  }

  async clearValidation(keyType: string, keySuffix: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE api_key_status SET "lastValidationError" = NULL, "lastValidationFailedAt" = NULL, "updatedAt" = ${now}
      WHERE "keyType" = ${keyType} AND "keySuffix" = ${keySuffix} AND "lastValidationFailedAt" IS NOT NULL`);
  }

  async clearValidationExcept(
    keyType: string,
    scope: string,
    scopeId: string,
    keepSuffixes: string[],
    now: string,
  ): Promise<void> {
    const keep = keepSuffixes.length
      ? sql` AND "keySuffix" NOT IN (${sqlList(keepSuffixes)})`
      : sql``;
    await this.db.run(sql`
      UPDATE api_key_status SET "lastValidationError" = NULL, "lastValidationFailedAt" = NULL, "updatedAt" = ${now}
      WHERE "keyType" = ${keyType} AND scope = ${scope} AND "scopeId" = ${scopeId}${keep}
        AND "lastValidationFailedAt" IS NOT NULL`);
  }

  async deleteGlobalKey(keyType: string, keySuffix: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM api_key_status
      WHERE "keyType" = ${keyType} AND "keySuffix" = ${keySuffix} AND scope = 'global' AND "scopeId" = ''`);
  }

  async setGlobalKeyIndex(keyType: string, keySuffix: string, keyIndex: number): Promise<void> {
    await this.db.run(sql`
      UPDATE api_key_status SET "keyIndex" = ${keyIndex}
      WHERE "keyType" = ${keyType} AND "keySuffix" = ${keySuffix} AND scope = 'global' AND "scopeId" = ''`);
  }

  async deleteGlobalKeysAtSlot(
    keyType: string,
    keyIndex: number,
    keySuffix: string | null,
  ): Promise<string[]> {
    const rows = await this.db.query<{ keySuffix: string }>(sql`
      DELETE FROM api_key_status
      WHERE "keyType" = ${keyType} AND scope = 'global' AND "scopeId" = ''
        AND ("keyIndex" = ${keyIndex} OR "keySuffix" = ${keySuffix})
      RETURNING "keySuffix"`);
    return rows.map((row) => row.keySuffix);
  }

  /** Insertion order differs per engine (SQLite `rowid`). */
  abstract listAgentScopeIdsWithValue(key: string, value: string): Promise<string[]>;

  async listScopedKeys(
    scope: string,
    scopeId: string,
    keys: readonly string[],
    opts: { includeSecrets: boolean },
  ): Promise<string[]> {
    if (keys.length === 0) return [];
    const rows = await this.db.query<{ key: string }>(sql`
      SELECT key FROM swarm_config
       WHERE scope = ${scope} AND "scopeId" = ${scopeId} AND key IN (${sqlList(keys)})
         ${opts.includeSecrets ? EMPTY : sql`AND "isSecret" = ${false}`}
       ORDER BY key`);
    return rows.map((row) => row.key);
  }

  async deleteConfigByScopeKey(
    scope: string,
    scopeId: string | null,
    key: string,
  ): Promise<number> {
    return (
      await this.db.run(
        sql`DELETE FROM swarm_config WHERE scope = ${scope} AND ${scopeIdIs(scopeId)} AND key = ${key}`,
      )
    ).changes;
  }

  /** Insertion order differs per engine (SQLite `rowid`). */
  abstract listRepoNamesAndUrls(): Promise<{ name: string | null; url: string | null }[]>;
}
