import {
  BaseUsersRepository,
  type IdentityEventRow,
  sql,
  type UserFavoriteRow,
  type UserMergeJobRow,
  type UserRow,
  type UserTokenSummaryRow,
} from "@desplega/storage";

export class SqliteUsersRepository extends BaseUsersRepository {
  // ---- users ----

  listUsers(): Promise<UserRow[]> {
    return this.db.query<UserRow>(sql`SELECT * FROM users ORDER BY name, rowid`);
  }

  // SQLite LOWER folds ASCII letters only.
  findUserByPrimaryEmail(email: string): Promise<UserRow | null> {
    return this.db.get<UserRow>(sql`
      SELECT * FROM users WHERE LOWER(email) = LOWER(${email}) AND "mergedIntoUserId" IS NULL`);
  }

  listUsersWithEmailAliases(): Promise<UserRow[]> {
    return this.db.query<UserRow>(sql`
      SELECT * FROM users
      WHERE "emailAliases" IS NOT NULL AND "emailAliases" != '[]' AND "mergedIntoUserId" IS NULL
      ORDER BY rowid`);
  }

  listUsersByName(name: string): Promise<UserRow[]> {
    return this.db.query<UserRow>(sql`
      SELECT * FROM users WHERE LOWER(name) = LOWER(${name}) AND "mergedIntoUserId" IS NULL
      ORDER BY rowid`);
  }

  listUsersByNamePrefix(prefix: string): Promise<UserRow[]> {
    return this.db.query<UserRow>(sql`
      SELECT * FROM users WHERE LOWER(name) LIKE LOWER(${prefix}) || '%' AND "mergedIntoUserId" IS NULL
      ORDER BY rowid`);
  }

  async getUserJobFunction(id: string): Promise<string | null | undefined> {
    const row = await this.db.get<{ jobFunction: string | null }>(sql`
      SELECT json_extract(metadata, '$.jobFunction') AS "jobFunction"
      FROM users WHERE id = ${id} AND json_valid(metadata)`);
    return row ? row.jobFunction : undefined;
  }

  // ---- user_identity_events ----

  listIdentityEvents(
    userId: string,
    opts: { before: string | null; limit: number },
  ): Promise<IdentityEventRow[]> {
    const before = opts.before === null ? sql`` : sql` AND "createdAt" < ${opts.before}`;
    return this.db.query<IdentityEventRow>(sql`
      SELECT id, "userId", "eventType", actor, "beforeJson", "afterJson", "createdAt"
      FROM user_identity_events
      WHERE "userId" = ${userId}${before}
      ORDER BY "createdAt" DESC, rowid DESC
      LIMIT ${opts.limit}`);
  }

  // ---- user_tokens ----

  listUserTokens(userId: string): Promise<UserTokenSummaryRow[]> {
    return this.db.query<UserTokenSummaryRow>(sql`
      SELECT id, "userId", label, "tokenPreview", "createdAt", "lastUsedAt", "revokedAt"
      FROM user_tokens
      WHERE "userId" = ${userId} AND "expiresAt" IS NULL
      ORDER BY "createdAt" DESC, rowid`);
  }

  listUnrevokedUserTokens(
    userId: string,
  ): Promise<{ id: string; label: string | null; tokenPreview: string }[]> {
    return this.db.query(sql`
      SELECT id, label, "tokenPreview" FROM user_tokens
      WHERE "userId" = ${userId} AND "revokedAt" IS NULL
      ORDER BY rowid`);
  }

  // ---- user_merge_jobs ----

  listMergeJobs(opts: {
    status: UserMergeJobRow["status"] | null;
    limit: number;
  }): Promise<UserMergeJobRow[]> {
    const where = opts.status === null ? sql`` : sql` WHERE status = ${opts.status}`;
    return this.db.query<UserMergeJobRow>(
      sql`SELECT * FROM user_merge_jobs${where} ORDER BY "createdAt" DESC, rowid LIMIT ${opts.limit}`,
    );
  }

  findActiveMergeJob(userId: string): Promise<UserMergeJobRow | null> {
    return this.db.get<UserMergeJobRow>(sql`
      SELECT * FROM user_merge_jobs
      WHERE status IN ('pending', 'running') AND ("sourceUserId" = ${userId} OR "targetUserId" = ${userId})
      ORDER BY "createdAt", rowid LIMIT 1`);
  }

  findFailedMergeJob(sourceUserId: string, targetUserId: string): Promise<UserMergeJobRow | null> {
    return this.db.get<UserMergeJobRow>(sql`
      SELECT * FROM user_merge_jobs
      WHERE status = 'failed' AND "sourceUserId" = ${sourceUserId} AND "targetUserId" = ${targetUserId}
      ORDER BY "createdAt" DESC, rowid LIMIT 1`);
  }

  claimNextMergeJob(now: string): Promise<UserMergeJobRow | null> {
    return this.db.get<UserMergeJobRow>(sql`
      UPDATE user_merge_jobs
      SET status = 'running', "startedAt" = COALESCE("startedAt", ${now}), attempts = attempts + 1,
          "nextAttemptAt" = NULL, "finishedAt" = NULL
      WHERE id = (
        SELECT id FROM user_merge_jobs
        WHERE status = 'pending' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
        ORDER BY "createdAt", rowid LIMIT 1
      )
      RETURNING *`);
  }

  // ---- user_favorites ----

  listFavorites(opts: {
    favoriteScope: string;
    itemType?: string;
    itemIds?: string[];
  }): Promise<UserFavoriteRow[]> {
    // Ties keep the order SQLite returned before the move: the (favoriteScope,
    // itemType) index without a type, the unique (scope, type, itemId) index
    // for a type and an id list, else rowid.
    const tiebreak = !opts.itemType
      ? sql`"itemType", rowid`
      : opts.itemIds && opts.itemIds.length > 0
        ? sql`"itemId"`
        : sql`rowid`;
    return this.db.query<UserFavoriteRow>(
      sql`SELECT * FROM user_favorites${this.favoriteFilters(opts)} ORDER BY "lastUpdatedAt" DESC, ${tiebreak}`,
    );
  }
}
