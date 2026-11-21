import type { UserReferenceColumn } from "@desplega/storage";
import {
  BaseUsersRepository,
  type IdentityEventRow,
  likeAsciiCi,
  sql,
  type UserFavoriteRow,
  type UserMergeJobRow,
  type UserRow,
  type UserTokenSummaryRow,
} from "@desplega/storage";
import { notOnPostgresYet } from "./not-yet";

// "_rowid" is the SQLite rowid: insertion order.
export class PostgresUsersRepository extends BaseUsersRepository {
  // ---- users ----

  listUsers(): Promise<UserRow[]> {
    return this.db.query<UserRow>(sql`SELECT * FROM users ORDER BY name, "_rowid"`);
  }

  // lower() folds ASCII letters only under the C ctype, as SQLite's LOWER.
  findUserByPrimaryEmail(email: string): Promise<UserRow | null> {
    return this.db.get<UserRow>(sql`
      SELECT * FROM users WHERE lower(email) = lower(${email}) AND "mergedIntoUserId" IS NULL
      ORDER BY "_rowid" LIMIT 1`);
  }

  listUsersWithEmailAliases(): Promise<UserRow[]> {
    return this.db.query<UserRow>(sql`
      SELECT * FROM users
      WHERE "emailAliases" IS NOT NULL AND "emailAliases" != '[]'::jsonb AND "mergedIntoUserId" IS NULL
      ORDER BY "_rowid"`);
  }

  listUsersByName(name: string): Promise<UserRow[]> {
    return this.db.query<UserRow>(sql`
      SELECT * FROM users WHERE lower(name) = lower(${name}) AND "mergedIntoUserId" IS NULL
      ORDER BY "_rowid"`);
  }

  listUsersByNamePrefix(prefix: string): Promise<UserRow[]> {
    // SQLite's LIKE has no escape character: `%` and `_` in the prefix stay wildcards.
    return this.db.query<UserRow>(sql`
      SELECT * FROM users
      WHERE ${likeAsciiCi(sql`name`, sql`(CAST(${prefix} AS text) || '%')`)} AND "mergedIntoUserId" IS NULL
      ORDER BY "_rowid"`);
  }

  async getUserJobFunction(id: string): Promise<string | null | undefined> {
    // jsonb is always valid JSON; SQLite's json_valid(NULL) drops a NULL metadata.
    const row = await this.db.get<{ jobFunction: string | null }>(sql`
      SELECT metadata->>'jobFunction' AS "jobFunction"
      FROM users WHERE id = ${id} AND metadata IS NOT NULL`);
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
      ORDER BY "createdAt" DESC, "_rowid" DESC
      LIMIT ${opts.limit}`);
  }

  // ---- user_tokens ----

  listUserTokens(userId: string): Promise<UserTokenSummaryRow[]> {
    return this.db.query<UserTokenSummaryRow>(sql`
      SELECT id, "userId", label, "tokenPreview", "createdAt", "lastUsedAt", "revokedAt"
      FROM user_tokens
      WHERE "userId" = ${userId} AND "expiresAt" IS NULL
      ORDER BY "createdAt" DESC, "_rowid"`);
  }

  listUnrevokedUserTokens(
    userId: string,
  ): Promise<{ id: string; label: string | null; tokenPreview: string }[]> {
    return this.db.query(sql`
      SELECT id, label, "tokenPreview" FROM user_tokens
      WHERE "userId" = ${userId} AND "revokedAt" IS NULL
      ORDER BY "_rowid"`);
  }

  // ---- user_merge_jobs ----

  listMergeJobs(opts: {
    status: UserMergeJobRow["status"] | null;
    limit: number;
  }): Promise<UserMergeJobRow[]> {
    const where = opts.status === null ? sql`` : sql` WHERE status = ${opts.status}`;
    return this.db.query<UserMergeJobRow>(
      sql`SELECT * FROM user_merge_jobs${where} ORDER BY "createdAt" DESC, "_rowid" LIMIT ${opts.limit}`,
    );
  }

  findActiveMergeJob(userId: string): Promise<UserMergeJobRow | null> {
    return this.db.get<UserMergeJobRow>(sql`
      SELECT * FROM user_merge_jobs
      WHERE status IN ('pending', 'running') AND ("sourceUserId" = ${userId} OR "targetUserId" = ${userId})
      ORDER BY "createdAt", "_rowid" LIMIT 1`);
  }

  findFailedMergeJob(sourceUserId: string, targetUserId: string): Promise<UserMergeJobRow | null> {
    return this.db.get<UserMergeJobRow>(sql`
      SELECT * FROM user_merge_jobs
      WHERE status = 'failed' AND "sourceUserId" = ${sourceUserId} AND "targetUserId" = ${targetUserId}
      ORDER BY "createdAt" DESC, "_rowid" LIMIT 1`);
  }

  claimNextMergeJob(now: string): Promise<UserMergeJobRow | null> {
    // FOR UPDATE SKIP LOCKED: two claimers never take the same job (SQLite
    // serializes writers, so the subquery there is already exclusive).
    return this.db.get<UserMergeJobRow>(sql`
      UPDATE user_merge_jobs
      SET status = 'running', "startedAt" = COALESCE("startedAt", ${now}), attempts = attempts + 1,
          "nextAttemptAt" = NULL, "finishedAt" = NULL
      WHERE id = (
        SELECT id FROM user_merge_jobs
        WHERE status = 'pending' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
        ORDER BY "createdAt", "_rowid" LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`);
  }

  // ---- user_favorites ----

  listFavorites(opts: {
    favoriteScope: string;
    itemType?: string;
    itemIds?: string[];
  }): Promise<UserFavoriteRow[]> {
    // The SQLite override's tiebreaks, with "_rowid" for rowid.
    const tiebreak = !opts.itemType
      ? sql`"itemType", "_rowid"`
      : opts.itemIds && opts.itemIds.length > 0
        ? sql`"itemId"`
        : sql`"_rowid"`;
    return this.db.query<UserFavoriteRow>(
      sql`SELECT * FROM user_favorites${this.favoriteFilters(opts)} ORDER BY "lastUpdatedAt" DESC, ${tiebreak}`,
    );
  }

  listUserReferenceColumns(): Promise<UserReferenceColumn[]> {
    return notOnPostgresYet("PostgresUsersRepository.listUserReferenceColumns");
  }

  rewriteUserReferenceColumn(
    reference: UserReferenceColumn,
    userId: string,
    replacementUserId: string | null,
    limit?: number,
  ): Promise<number> {
    return notOnPostgresYet("PostgresUsersRepository.rewriteUserReferenceColumn");
  }

  listWorkflowRunIdsRequestedBy(userId: string, limit?: number): Promise<string[]> {
    return notOnPostgresYet("PostgresUsersRepository.listWorkflowRunIdsRequestedBy");
  }

  listSealedWorkflowContextsRequestedBy(
    runIds: string[],
    userId: string,
  ): Promise<{ id: string; context_replay: string }[]> {
    return notOnPostgresYet("PostgresUsersRepository.listSealedWorkflowContextsRequestedBy");
  }

  rewriteWorkflowRunContextRequester(
    runIds: string[],
    userId: string,
    replacementUserId: string | null,
  ): Promise<number> {
    return notOnPostgresYet("PostgresUsersRepository.rewriteWorkflowRunContextRequester");
  }
}
