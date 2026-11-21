import { jsonText } from "../dialect";
import type { SqlExecutor } from "../executor";
import { type SqlQuery, sql, sqlJoin, sqlList, sqlWhere } from "../sql";

/**
 * Domain: users (`users`, `user_external_ids`, `user_identity_events`,
 * `user_tokens`, `user_merge_jobs`, `connector_codes`, `app_user_config`,
 * `user_favorites`). Rows come back in the SQLite value shape on every
 * engine (JSON as text, timestamps as the text the column stores).
 */

export type UserRow = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  notes: string | null;
  emailAliases: string | null;
  preferredChannel: string | null;
  timezone: string | null;
  metadata: string | null;
  dailyBudgetUsd: number | null;
  status: string;
  mergedIntoUserId: string | null;
  avatar: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  created_by?: string | null;
  updated_by?: string | null;
};

export type NewUser = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  notes: string | null;
  /** JSON array text. */
  emailAliases: string;
  preferredChannel: string;
  timezone: string | null;
  /** JSON object text. */
  metadata: string | null;
  dailyBudgetUsd: number | null;
  status: string;
  /** JSON text of the avatar. */
  avatar: string | null;
  now: string;
};

/** Columns a user update may set, as stored values. `undefined` leaves a column unchanged. */
export type UserColumnUpdate = {
  name?: string;
  email?: string | null;
  role?: string;
  notes?: string;
  emailAliases?: string;
  preferredChannel?: string;
  timezone?: string;
  metadata?: string | null;
  dailyBudgetUsd?: number | null;
  status?: string;
  avatar?: string | null;
};

export type IdentityEventRow = {
  id: string;
  userId: string;
  eventType: string;
  actor: string;
  beforeJson: string | null;
  afterJson: string | null;
  createdAt: string;
};

export type UserTokenSummaryRow = {
  id: string;
  userId: string;
  label: string | null;
  tokenPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type NewUserToken = {
  id: string;
  userId: string;
  label: string | null;
  tokenHash: string;
  tokenPreview: string;
  createdAt: string;
  /** Null for a token that does not expire (an MCP token). */
  expiresAt: string | null;
};

export type UserMergeJobRow = {
  id: string;
  sourceUserId: string;
  targetUserId: string;
  status: "pending" | "running" | "done" | "failed";
  phase: string | null;
  progress: string;
  error: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  created_by?: string | null;
  updated_by?: string | null;
};

export type NewConnectorCode = {
  codeHash: string;
  userId: string;
  label: string;
  actorKind: string;
  actorId: string;
  createdAt: string;
  expiresAt: string;
  kind: string;
};

export type RedeemedConnectorCode = {
  user_id: string;
  label: string;
  actor_kind: string;
  actor_id: string;
};

export type UserFavoriteRow = {
  id: string;
  favoriteScope: string;
  userId: string | null;
  itemType: string;
  itemId: string;
  createdAt: string;
  lastUpdatedAt: string;
  created_by: string | null;
  updated_by: string | null;
};

/** A retained user reference: a column that keeps its value when the user is deleted. */
export type UserReferenceRow = {
  tableName: string;
  columnName: string;
};

/**
 * A retained reference with its batch key: the row id, or the primary key
 * columns of a table without one (`withoutRowid`).
 */
export type UserReferenceColumn = UserReferenceRow & {
  withoutRowid: boolean;
  keyColumns: string[];
};

export interface UsersRepository {
  // ---- users ----
  findUserById(id: string): Promise<UserRow | null>;
  /** True when a `users` row has this id. */
  userExists(id: string): Promise<boolean>;
  /** Every user, by name, ties in insertion order. */
  listUsers(): Promise<UserRow[]>;
  /**
   * The user whose primary email equals `email` ignoring ASCII case, skipping
   * a merge source (`mergedIntoUserId` set). The unique index is case-sensitive,
   * so two rows may match: the first inserted wins.
   */
  findUserByPrimaryEmail(email: string): Promise<UserRow | null>;
  /** Users with a non-empty alias array that are not a merge source. Insertion order. */
  listUsersWithEmailAliases(): Promise<UserRow[]>;
  /** Users named `name` ignoring ASCII case, not a merge source. Insertion order. */
  listUsersByName(name: string): Promise<UserRow[]>;
  /** Users whose name starts with `prefix` ignoring ASCII case, not a merge source. Insertion order. */
  listUsersByNamePrefix(prefix: string): Promise<UserRow[]>;
  insertUser(user: NewUser): Promise<UserRow | null>;
  /** Sets the given columns plus `lastUpdatedAt`. Null when no row has the id. */
  updateUser(id: string, update: UserColumnUpdate, now: string): Promise<UserRow | null>;
  /** Sets the timezone only while it is NULL or empty. */
  fillMissingTimezone(id: string, timezone: string, now: string): Promise<void>;
  /** Moves an `invited` user to `active`. Returns the changed row count. */
  activateInvitedUser(id: string, now: string): Promise<number>;
  /** Marks `sourceId` as merged into `targetId`. */
  markUserMergedInto(sourceId: string, targetId: string, now: string): Promise<void>;
  /** Deletes the user row. Returns the changed row count. */
  deleteUser(id: string): Promise<number>;
  /**
   * `metadata.jobFunction` of the user: undefined when the user is missing or
   * its metadata is not valid JSON, null when the key is absent.
   */
  getUserJobFunction(id: string): Promise<string | null | undefined>;
  /**
   * Emails of active users with a non-blank email, for the org domain: users
   * holding a grant-all role first, then by `createdAt`, then id. At most `limit`.
   */
  listOrgDomainCandidateEmails(limit: number): Promise<string[]>;

  // ---- telemetry snapshot counts ----
  countUsersByStatus(status: string): Promise<number>;
  /** Active users holding a grant-all role. */
  countActiveGrantAllUsers(): Promise<number>;
  /** Active users with a non-blank email or an unrevoked user token. */
  countActiveUsersWithLogin(): Promise<number>;
  /** Active users with an external id of `kind`. */
  countActiveUsersLinked(kind: string): Promise<number>;
  /** Active users with an external id whose kind is not in `kinds`. */
  countActiveUsersLinkedOutside(kinds: readonly string[]): Promise<number>;

  // ---- user_external_ids ----
  findUserByExternalId(kind: string, externalId: string): Promise<UserRow | null>;
  /** The user's `(kind, externalId)` pairs, by kind then externalId (the primary key). */
  listExternalIds(userId: string): Promise<{ kind: string; externalId: string }[]>;
  /** Throws on a `(kind, externalId)` primary-key conflict. */
  insertExternalId(userId: string, kind: string, externalId: string): Promise<void>;
  deleteExternalId(userId: string, kind: string, externalId: string): Promise<void>;

  // ---- user_identity_events ----
  insertIdentityEvent(row: IdentityEventRow): Promise<void>;
  /**
   * The user's events, newest `createdAt` first, ties newest insert first.
   * With `before`, only events created strictly before it.
   */
  listIdentityEvents(
    userId: string,
    opts: { before: string | null; limit: number },
  ): Promise<IdentityEventRow[]>;

  // ---- user_tokens ----
  insertUserToken(token: NewUserToken): Promise<void>;
  /** Tokens without an expiry (MCP tokens), newest first, ties in insertion order. */
  listUserTokens(userId: string): Promise<UserTokenSummaryRow[]>;
  findUserTokenSummary(
    tokenId: string,
  ): Promise<{ userId: string; label: string | null; tokenPreview: string } | null>;
  /** Unrevoked tokens of the user, insertion order. */
  listUnrevokedUserTokens(
    userId: string,
  ): Promise<{ id: string; label: string | null; tokenPreview: string }[]>;
  setUserTokenRevoked(tokenId: string, now: string): Promise<void>;
  /** Revokes an unrevoked token that has an expiry (a script-run token). */
  revokeExpiringUserToken(tokenId: string, now: string): Promise<void>;
  findUserTokenByHash(tokenHash: string): Promise<{
    id: string;
    userId: string;
    revokedAt: string | null;
    expiresAt: string | null;
  } | null>;
  touchUserToken(tokenId: string, now: string): Promise<void>;
  /** True when the token belongs to the user, is unrevoked and not past `now`. */
  isLiveUserToken(tokenId: string, userId: string, now: string): Promise<boolean>;

  // ---- connector_codes ----
  insertConnectorCode(code: NewConnectorCode): Promise<void>;
  /**
   * Marks an unused, unexpired code of `kind` used at `now` and returns it,
   * or null when no such code exists.
   */
  redeemConnectorCode(
    codeHash: string,
    kind: string,
    now: string,
  ): Promise<RedeemedConnectorCode | null>;
  /** Marks every unused code of the user used. */
  spendUnusedConnectorCodes(userId: string, now: string): Promise<void>;
  deleteUnusedInviteCodes(userId: string): Promise<number>;
  deleteConnectorCodesExpiredBefore(cutoff: string): Promise<number>;

  // ---- user_merge_jobs ----
  insertMergeJob(job: {
    id: string;
    sourceUserId: string;
    targetUserId: string;
    createdAt: string;
    createdBy: string | null;
  }): Promise<UserMergeJobRow | null>;
  findMergeJob(id: string): Promise<UserMergeJobRow | null>;
  /** Newest `createdAt` first, ties in insertion order. */
  listMergeJobs(opts: {
    status: UserMergeJobRow["status"] | null;
    limit: number;
  }): Promise<UserMergeJobRow[]>;
  /** The oldest pending or running job naming the user (ties: first inserted). */
  findActiveMergeJob(userId: string): Promise<UserMergeJobRow | null>;
  /** The newest failed job of the pair (ties: first inserted). */
  findFailedMergeJob(sourceUserId: string, targetUserId: string): Promise<UserMergeJobRow | null>;
  /** Puts a failed job back to pending with a fresh attempt budget. */
  requeueFailedMergeJob(id: string): Promise<UserMergeJobRow | null>;
  /**
   * Claims the oldest due pending job (ties: first inserted): running, one
   * more attempt, `startedAt` kept once set.
   */
  claimNextMergeJob(now: string): Promise<UserMergeJobRow | null>;
  saveMergeJobProgress(id: string, phase: string, progress: string): Promise<void>;
  markMergeJobFailed(id: string, error: string, now: string): Promise<void>;
  scheduleMergeJobRetry(id: string, error: string, nextAttemptAt: string): Promise<void>;
  markMergeJobDone(id: string, phase: string, progress: string, now: string): Promise<void>;
  /** Running jobs and pending jobs in backoff go back to due pending. Returns the count. */
  resetInterruptedMergeJobs(): Promise<number>;
  countPendingMergeJobs(): Promise<number>;

  // ---- app_user_config ----
  getAppUserConfigValues(appId: string, scope: string): Promise<string | null>;
  /** Insert, or replace the values of the `(appId, scope)` row. */
  upsertAppUserConfigValues(row: {
    id: string;
    appId: string;
    scope: string;
    values: string;
    now: string;
  }): Promise<void>;

  // ---- user_favorites ----
  /**
   * Favorites of the scope, newest `lastUpdatedAt` first. Ties: by item id
   * when `itemIds` is given, else in insertion order.
   */
  listFavorites(opts: {
    favoriteScope: string;
    itemType?: string;
    itemIds?: string[];
  }): Promise<UserFavoriteRow[]>;
  deleteFavorite(favoriteScope: string, itemType: string, itemId: string): Promise<void>;
  /** Deletes every user's favorite of one item (favorites carry no FK to the item). */
  deleteFavoritesOfItem(itemType: string, itemId: string): Promise<void>;
  /** Insert, or refresh `lastUpdatedAt`/`updated_by` of the existing star. */
  upsertFavorite(row: {
    favoriteScope: string;
    userId: string | null;
    itemType: string;
    itemId: string;
    actor: string;
    now: string;
  }): Promise<UserFavoriteRow | null>;
  /** Every non-null user email. Ordered by email. */
  listUserEmails(): Promise<string[]>;

  // ---- retained user references (deleteUser and the merge job) ----
  /**
   * Every nullable column with a FOREIGN KEY to users(id) and no ON DELETE
   * action (plus the scheduled_tasks audit columns), each with its batch key.
   * Order: the engine's schema order (tables, then foreign keys).
   */
  listUserReferenceColumns(): Promise<UserReferenceColumn[]>;
  /**
   * Set `reference` from `userId` to `replacementUserId` (or NULL). Without
   * `limit` every matching row; with it at most `limit` rows. Returns the
   * changed row count.
   */
  rewriteUserReferenceColumn(
    reference: UserReferenceColumn,
    userId: string,
    replacementUserId: string | null,
    limit?: number,
  ): Promise<number>;
  /** Ids of the workflow runs whose context names `userId` as the requester, ordered by id. */
  listWorkflowRunIdsRequestedBy(userId: string, limit?: number): Promise<string[]>;
  /** Sealed replay copies of the given runs whose context names `userId` (no order). */
  listSealedWorkflowContextsRequestedBy(
    runIds: string[],
    userId: string,
  ): Promise<{ id: string; context_replay: string }[]>;
  setWorkflowRunContextReplay(runId: string, contextReplay: string): Promise<void>;
  /**
   * In the given runs whose context names `userId`, set the context requester
   * to `replacementUserId`, or remove it when null. Returns the changed row count.
   */
  rewriteWorkflowRunContextRequester(
    runIds: string[],
    userId: string,
    replacementUserId: string | null,
  ): Promise<number>;
}

export abstract class BaseUsersRepository implements UsersRepository {
  constructor(protected readonly db: SqlExecutor) {}

  // ---- users ----

  findUserById(id: string): Promise<UserRow | null> {
    return this.db.get<UserRow>(sql`SELECT * FROM users WHERE id = ${id}`);
  }

  async userExists(id: string): Promise<boolean> {
    return (await this.db.get(sql`SELECT 1 AS present FROM users WHERE id = ${id}`)) != null;
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listUsers(): Promise<UserRow[]>;
  /** SQLite `LOWER` folds ASCII only; a Postgres engine writes its own fold. */
  abstract findUserByPrimaryEmail(email: string): Promise<UserRow | null>;
  /** Insertion order differs per engine (SQLite `rowid`). */
  abstract listUsersWithEmailAliases(): Promise<UserRow[]>;
  /** ASCII case fold and insertion order differ per engine. */
  abstract listUsersByName(name: string): Promise<UserRow[]>;
  /** ASCII case fold and insertion order differ per engine. */
  abstract listUsersByNamePrefix(prefix: string): Promise<UserRow[]>;

  insertUser(u: NewUser): Promise<UserRow | null> {
    return this.db.get<UserRow>(sql`
      INSERT INTO users (
        id, name, email, role, notes, "emailAliases", "preferredChannel", timezone,
        metadata, "dailyBudgetUsd", status, avatar, "createdAt", "lastUpdatedAt"
      ) VALUES (
        ${u.id}, ${u.name}, ${u.email}, ${u.role}, ${u.notes}, ${jsonText(u.emailAliases)}, ${u.preferredChannel}, ${u.timezone},
        ${jsonText(u.metadata)}, ${u.dailyBudgetUsd}, ${u.status}, ${u.avatar}, ${u.now}, ${u.now}
      ) RETURNING *`);
  }

  updateUser(id: string, u: UserColumnUpdate, now: string): Promise<UserRow | null> {
    const sets: SqlQuery[] = [];
    if (u.name !== undefined) sets.push(sql`name = ${u.name}`);
    if (u.email !== undefined) sets.push(sql`email = ${u.email}`);
    if (u.role !== undefined) sets.push(sql`role = ${u.role}`);
    if (u.notes !== undefined) sets.push(sql`notes = ${u.notes}`);
    if (u.emailAliases !== undefined) sets.push(sql`"emailAliases" = ${jsonText(u.emailAliases)}`);
    if (u.preferredChannel !== undefined)
      sets.push(sql`"preferredChannel" = ${u.preferredChannel}`);
    if (u.timezone !== undefined) sets.push(sql`timezone = ${u.timezone}`);
    if (u.metadata !== undefined) sets.push(sql`metadata = ${jsonText(u.metadata)}`);
    if (u.dailyBudgetUsd !== undefined) sets.push(sql`"dailyBudgetUsd" = ${u.dailyBudgetUsd}`);
    if (u.status !== undefined) sets.push(sql`status = ${u.status}`);
    if (u.avatar !== undefined) sets.push(sql`avatar = ${u.avatar}`);
    sets.push(sql`"lastUpdatedAt" = ${now}`);
    return this.db.get<UserRow>(
      sql`UPDATE users SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  async fillMissingTimezone(id: string, timezone: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE users SET timezone = ${timezone}, "lastUpdatedAt" = ${now}
      WHERE id = ${id} AND (timezone IS NULL OR timezone = '')`);
  }

  async activateInvitedUser(id: string, now: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE users SET status = 'active', "lastUpdatedAt" = ${now}
      WHERE id = ${id} AND status = 'invited'`);
    return result.changes;
  }

  async markUserMergedInto(sourceId: string, targetId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE users SET "mergedIntoUserId" = ${targetId}, "lastUpdatedAt" = ${now}
      WHERE id = ${sourceId}`);
  }

  async deleteUser(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM users WHERE id = ${id}`)).changes;
  }

  /** JSON path access differs per engine. */
  abstract getUserJobFunction(id: string): Promise<string | null | undefined>;

  async listOrgDomainCandidateEmails(limit: number): Promise<string[]> {
    const rows = await this.db.query<{ email: string }>(sql`
      SELECT u.email AS email
      FROM users u
      WHERE u.status = 'active' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      ORDER BY EXISTS (
                 SELECT 1 FROM principal_roles pr JOIN roles r ON r.id = pr."roleId"
                 WHERE pr."principalType" = 'user' AND pr."principalId" = u.id AND r."grantsAll" = ${true}
               ) DESC,
               u."createdAt" ASC, u.id ASC
      LIMIT ${limit}`);
    return rows.map((row) => row.email);
  }

  // ---- telemetry snapshot counts ----

  protected async count(query: SqlQuery): Promise<number> {
    const row = await this.db.get<{ n: number | string }>(query);
    return Number(row?.n ?? 0);
  }

  countUsersByStatus(status: string): Promise<number> {
    return this.count(sql`SELECT COUNT(*) AS n FROM users WHERE status = ${status}`);
  }

  countActiveGrantAllUsers(): Promise<number> {
    return this.count(sql`
      SELECT COUNT(DISTINCT u.id) AS n
      FROM users u
      JOIN principal_roles pr ON pr."principalType" = 'user' AND pr."principalId" = u.id
      JOIN roles r ON r.id = pr."roleId"
      WHERE u.status = 'active' AND r."grantsAll" = ${true}`);
  }

  countActiveUsersWithLogin(): Promise<number> {
    return this.count(sql`
      SELECT COUNT(*) AS n
      FROM users u
      WHERE u.status = 'active'
        AND ((u.email IS NOT NULL AND TRIM(u.email) <> '')
             OR EXISTS (SELECT 1 FROM user_tokens t WHERE t."userId" = u.id AND t."revokedAt" IS NULL))`);
  }

  countActiveUsersLinked(kind: string): Promise<number> {
    return this.count(sql`
      SELECT COUNT(DISTINCT x."userId") AS n
      FROM user_external_ids x JOIN users u ON u.id = x."userId"
      WHERE u.status = 'active' AND x.kind = ${kind}`);
  }

  countActiveUsersLinkedOutside(kinds: readonly string[]): Promise<number> {
    const outside = kinds.length === 0 ? sql`` : sql` AND x.kind NOT IN (${sqlList(kinds)})`;
    return this.count(sql`
      SELECT COUNT(DISTINCT x."userId") AS n
      FROM user_external_ids x JOIN users u ON u.id = x."userId"
      WHERE u.status = 'active'${outside}`);
  }

  // ---- user_external_ids ----

  findUserByExternalId(kind: string, externalId: string): Promise<UserRow | null> {
    return this.db.get<UserRow>(sql`
      SELECT u.* FROM users u
      INNER JOIN user_external_ids x ON x."userId" = u.id
      WHERE x.kind = ${kind} AND x."externalId" = ${externalId}`);
  }

  listExternalIds(userId: string): Promise<{ kind: string; externalId: string }[]> {
    return this.db.query(sql`
      SELECT kind, "externalId" FROM user_external_ids
      WHERE "userId" = ${userId} ORDER BY kind, "externalId"`);
  }

  async insertExternalId(userId: string, kind: string, externalId: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO user_external_ids ("userId", kind, "externalId")
      VALUES (${userId}, ${kind}, ${externalId})`);
  }

  async deleteExternalId(userId: string, kind: string, externalId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM user_external_ids
      WHERE "userId" = ${userId} AND kind = ${kind} AND "externalId" = ${externalId}`);
  }

  // ---- user_identity_events ----

  async insertIdentityEvent(e: IdentityEventRow): Promise<void> {
    await this.db.run(sql`
      INSERT INTO user_identity_events (id, "userId", "eventType", actor, "beforeJson", "afterJson", "createdAt")
      VALUES (${e.id}, ${e.userId}, ${e.eventType}, ${e.actor}, ${jsonText(e.beforeJson)}, ${jsonText(e.afterJson)}, ${e.createdAt})`);
  }

  /** The newest-insert tiebreak differs per engine (SQLite `rowid`). */
  abstract listIdentityEvents(
    userId: string,
    opts: { before: string | null; limit: number },
  ): Promise<IdentityEventRow[]>;

  // ---- user_tokens ----

  async insertUserToken(t: NewUserToken): Promise<void> {
    await this.db.run(sql`
      INSERT INTO user_tokens (id, "userId", label, "tokenHash", "tokenPreview", "createdAt", "expiresAt")
      VALUES (${t.id}, ${t.userId}, ${t.label}, ${t.tokenHash}, ${t.tokenPreview}, ${t.createdAt}, ${t.expiresAt})`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listUserTokens(userId: string): Promise<UserTokenSummaryRow[]>;

  findUserTokenSummary(
    tokenId: string,
  ): Promise<{ userId: string; label: string | null; tokenPreview: string } | null> {
    return this.db.get(
      sql`SELECT "userId", label, "tokenPreview" FROM user_tokens WHERE id = ${tokenId}`,
    );
  }

  /** Insertion order differs per engine (SQLite `rowid`). */
  abstract listUnrevokedUserTokens(
    userId: string,
  ): Promise<{ id: string; label: string | null; tokenPreview: string }[]>;

  async setUserTokenRevoked(tokenId: string, now: string): Promise<void> {
    await this.db.run(sql`UPDATE user_tokens SET "revokedAt" = ${now} WHERE id = ${tokenId}`);
  }

  async revokeExpiringUserToken(tokenId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE user_tokens SET "revokedAt" = ${now}
      WHERE id = ${tokenId} AND "expiresAt" IS NOT NULL AND "revokedAt" IS NULL`);
  }

  findUserTokenByHash(tokenHash: string): Promise<{
    id: string;
    userId: string;
    revokedAt: string | null;
    expiresAt: string | null;
  } | null> {
    return this.db.get(sql`
      SELECT id, "userId", "revokedAt", "expiresAt" FROM user_tokens WHERE "tokenHash" = ${tokenHash}`);
  }

  async touchUserToken(tokenId: string, now: string): Promise<void> {
    await this.db.run(sql`UPDATE user_tokens SET "lastUsedAt" = ${now} WHERE id = ${tokenId}`);
  }

  async isLiveUserToken(tokenId: string, userId: string, now: string): Promise<boolean> {
    const row = await this.db.get(sql`
      SELECT 1 AS found FROM user_tokens
      WHERE id = ${tokenId} AND "userId" = ${userId} AND "revokedAt" IS NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > ${now})`);
    return row != null;
  }

  // ---- connector_codes ----

  async insertConnectorCode(c: NewConnectorCode): Promise<void> {
    await this.db.run(sql`
      INSERT INTO connector_codes
        (code_hash, user_id, label, actor_kind, actor_id, created_at, expires_at, kind)
      VALUES (${c.codeHash}, ${c.userId}, ${c.label}, ${c.actorKind}, ${c.actorId}, ${c.createdAt}, ${c.expiresAt}, ${c.kind})`);
  }

  redeemConnectorCode(
    codeHash: string,
    kind: string,
    now: string,
  ): Promise<RedeemedConnectorCode | null> {
    return this.db.get<RedeemedConnectorCode>(sql`
      UPDATE connector_codes SET used_at = ${now}
      WHERE code_hash = ${codeHash} AND used_at IS NULL AND expires_at > ${now} AND kind = ${kind}
      RETURNING user_id, label, actor_kind, actor_id`);
  }

  async spendUnusedConnectorCodes(userId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE connector_codes SET used_at = ${now} WHERE user_id = ${userId} AND used_at IS NULL`);
  }

  async deleteUnusedInviteCodes(userId: string): Promise<number> {
    const result = await this.db.run(sql`
      DELETE FROM connector_codes WHERE user_id = ${userId} AND kind = 'invite' AND used_at IS NULL`);
    return result.changes;
  }

  async deleteConnectorCodesExpiredBefore(cutoff: string): Promise<number> {
    const result = await this.db.run(sql`DELETE FROM connector_codes WHERE expires_at < ${cutoff}`);
    return result.changes;
  }

  // ---- user_merge_jobs ----

  insertMergeJob(j: {
    id: string;
    sourceUserId: string;
    targetUserId: string;
    createdAt: string;
    createdBy: string | null;
  }): Promise<UserMergeJobRow | null> {
    return this.db.get<UserMergeJobRow>(sql`
      INSERT INTO user_merge_jobs
        (id, "sourceUserId", "targetUserId", status, progress, "createdAt", created_by, updated_by)
      VALUES (${j.id}, ${j.sourceUserId}, ${j.targetUserId}, 'pending', '{}', ${j.createdAt}, ${j.createdBy}, ${j.createdBy})
      RETURNING *`);
  }

  findMergeJob(id: string): Promise<UserMergeJobRow | null> {
    return this.db.get<UserMergeJobRow>(sql`SELECT * FROM user_merge_jobs WHERE id = ${id}`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listMergeJobs(opts: {
    status: UserMergeJobRow["status"] | null;
    limit: number;
  }): Promise<UserMergeJobRow[]>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract findActiveMergeJob(userId: string): Promise<UserMergeJobRow | null>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract findFailedMergeJob(
    sourceUserId: string,
    targetUserId: string,
  ): Promise<UserMergeJobRow | null>;

  requeueFailedMergeJob(id: string): Promise<UserMergeJobRow | null> {
    return this.db.get<UserMergeJobRow>(sql`
      UPDATE user_merge_jobs
      SET status = 'pending', error = NULL, attempts = 0, "nextAttemptAt" = NULL, "finishedAt" = NULL
      WHERE id = ${id} AND status = 'failed'
      RETURNING *`);
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract claimNextMergeJob(now: string): Promise<UserMergeJobRow | null>;

  async saveMergeJobProgress(id: string, phase: string, progress: string): Promise<void> {
    await this.db.run(
      sql`UPDATE user_merge_jobs SET phase = ${phase}, progress = ${jsonText(progress)} WHERE id = ${id}`,
    );
  }

  async markMergeJobFailed(id: string, error: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE user_merge_jobs SET status = 'failed', error = ${error}, "finishedAt" = ${now}
      WHERE id = ${id}`);
  }

  async scheduleMergeJobRetry(id: string, error: string, nextAttemptAt: string): Promise<void> {
    await this.db.run(sql`
      UPDATE user_merge_jobs SET status = 'pending', error = ${error}, "nextAttemptAt" = ${nextAttemptAt}
      WHERE id = ${id}`);
  }

  async markMergeJobDone(id: string, phase: string, progress: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE user_merge_jobs
      SET status = 'done', phase = ${phase}, progress = ${jsonText(progress)}, error = NULL, "finishedAt" = ${now}
      WHERE id = ${id}`);
  }

  async resetInterruptedMergeJobs(): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE user_merge_jobs SET status = 'pending', "nextAttemptAt" = NULL, "finishedAt" = NULL
      WHERE status = 'running' OR (status = 'pending' AND "nextAttemptAt" IS NOT NULL)`);
    return result.changes;
  }

  async countPendingMergeJobs(): Promise<number> {
    const row = await this.db.get<{ n: number | string }>(
      sql`SELECT COUNT(*) AS n FROM user_merge_jobs WHERE status = 'pending'`,
    );
    return Number(row?.n ?? 0);
  }

  // ---- app_user_config ----

  async getAppUserConfigValues(appId: string, scope: string): Promise<string | null> {
    const row = await this.db.get<{ storedValues: string }>(sql`
      SELECT "values" AS "storedValues" FROM app_user_config
      WHERE "appId" = ${appId} AND scope = ${scope}`);
    return row ? row.storedValues : null;
  }

  async upsertAppUserConfigValues(r: {
    id: string;
    appId: string;
    scope: string;
    values: string;
    now: string;
  }): Promise<void> {
    await this.db.run(sql`
      INSERT INTO app_user_config (id, "appId", scope, "values", "createdAt", "updatedAt")
      VALUES (${r.id}, ${r.appId}, ${r.scope}, ${r.values}, ${r.now}, ${r.now})
      ON CONFLICT ("appId", scope) DO UPDATE SET
        "values" = excluded."values", "updatedAt" = excluded."updatedAt"`);
  }

  // ---- user_favorites ----

  /** The tiebreak differs per engine (SQLite index and `rowid` order). */
  abstract listFavorites(opts: {
    favoriteScope: string;
    itemType?: string;
    itemIds?: string[];
  }): Promise<UserFavoriteRow[]>;

  protected favoriteFilters(opts: {
    favoriteScope: string;
    itemType?: string;
    itemIds?: string[];
  }): SqlQuery {
    const conditions: SqlQuery[] = [sql`"favoriteScope" = ${opts.favoriteScope}`];
    if (opts.itemType) conditions.push(sql`"itemType" = ${opts.itemType}`);
    if (opts.itemIds && opts.itemIds.length > 0)
      conditions.push(sql`"itemId" IN (${sqlList(opts.itemIds)})`);
    return sqlWhere(conditions);
  }

  async deleteFavoritesOfItem(itemType: string, itemId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM user_favorites WHERE "itemType" = ${itemType} AND "itemId" = ${itemId}`);
  }

  async deleteFavorite(favoriteScope: string, itemType: string, itemId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM user_favorites
      WHERE "favoriteScope" = ${favoriteScope} AND "itemType" = ${itemType} AND "itemId" = ${itemId}`);
  }

  upsertFavorite(r: {
    favoriteScope: string;
    userId: string | null;
    itemType: string;
    itemId: string;
    actor: string;
    now: string;
  }): Promise<UserFavoriteRow | null> {
    return this.db.get<UserFavoriteRow>(sql`
      INSERT INTO user_favorites (
        "favoriteScope", "userId", "itemType", "itemId", "createdAt", "lastUpdatedAt", created_by, updated_by
      )
      VALUES (${r.favoriteScope}, ${r.userId}, ${r.itemType}, ${r.itemId}, ${r.now}, ${r.now}, ${r.actor}, ${r.actor})
      ON CONFLICT ("favoriteScope", "itemType", "itemId") DO UPDATE SET
        "lastUpdatedAt" = excluded."lastUpdatedAt",
        updated_by = excluded.updated_by
      RETURNING *`);
  }

  async listUserEmails(): Promise<string[]> {
    const rows = await this.db.query<{ email: string }>(
      sql`SELECT email FROM users WHERE email IS NOT NULL ORDER BY email`,
    );
    return rows.map((row) => row.email);
  }

  // ---- retained user references: schema discovery and JSON paths are engine-specific ----

  abstract listUserReferenceColumns(): Promise<UserReferenceColumn[]>;
  abstract rewriteUserReferenceColumn(
    reference: UserReferenceColumn,
    userId: string,
    replacementUserId: string | null,
    limit?: number,
  ): Promise<number>;
  abstract listWorkflowRunIdsRequestedBy(userId: string, limit?: number): Promise<string[]>;
  abstract listSealedWorkflowContextsRequestedBy(
    runIds: string[],
    userId: string,
  ): Promise<{ id: string; context_replay: string }[]>;

  async setWorkflowRunContextReplay(runId: string, contextReplay: string): Promise<void> {
    await this.db.run(
      sql`UPDATE workflow_runs SET context_replay = ${contextReplay} WHERE id = ${runId}`,
    );
  }

  abstract rewriteWorkflowRunContextRequester(
    runIds: string[],
    userId: string,
    replacementUserId: string | null,
  ): Promise<number>;
}
