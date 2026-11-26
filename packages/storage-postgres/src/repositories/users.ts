import {
  BaseUsersRepository,
  type IdentityEventRow,
  likeAsciiCi,
  sql,
  sqlIdent,
  sqlJoin,
  sqlList,
  type UserFavoriteRow,
  type UserMergeJobRow,
  type UserReferenceColumn,
  type UserReferenceRow,
  type UserRow,
  type UserTokenSummaryRow,
} from "@desplega/storage";

/**
 * The requester a workflow run stores inside its JSON context, written exactly
 * as the expression of idx_workflow_runs_context_requester in the baseline so
 * the planner can use that index. jsonb is always valid JSON, so SQLite's
 * json_valid guard reduces to the NULL check.
 */
const CONTEXT_REQUESTER = sql`(CASE WHEN ("context" IS NOT NULL OR NULL::boolean) THEN ("context" #>> '{swarm,requestedByUserId}') END)`;

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

  async listRecentIdentityEventsForUsers(
    userIds: readonly string[],
    limitPerUser: number,
  ): Promise<IdentityEventRow[]> {
    if (userIds.length === 0 || limitPerUser <= 0) return [];
    return this.db.query<IdentityEventRow>(sql`
      SELECT id, "userId", "eventType", actor, "beforeJson", "afterJson", "createdAt"
      FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY "userId" ORDER BY "createdAt" DESC, "_rowid" DESC
        ) AS rn
        FROM user_identity_events
        WHERE "userId" IN (${sqlList(userIds)})
      ) ranked
      WHERE rn <= ${limitPerUser}
      ORDER BY "userId", rn`);
  }

  // ---- user_tokens ----

  listUserTokens(userId: string): Promise<UserTokenSummaryRow[]> {
    return this.db.query<UserTokenSummaryRow>(sql`
      SELECT id, "userId", label, "tokenPreview", "createdAt", "lastUsedAt", "revokedAt"
      FROM user_tokens
      WHERE "userId" = ${userId} AND "expiresAt" IS NULL
      ORDER BY "createdAt" DESC, "_rowid"`);
  }

  async listUserTokensForUsers(userIds: readonly string[]): Promise<UserTokenSummaryRow[]> {
    if (userIds.length === 0) return [];
    return this.db.query<UserTokenSummaryRow>(sql`
      SELECT id, "userId", label, "tokenPreview", "createdAt", "lastUsedAt", "revokedAt"
      FROM user_tokens
      WHERE "userId" IN (${sqlList(userIds)}) AND "expiresAt" IS NULL
      ORDER BY "userId", "createdAt" DESC, "_rowid"`);
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

  // ---- retained user references ----
  //
  // SQLite discovers them through PRAGMA foreign_key_list / table_info; here
  // the same facts come from pg_catalog. A table "without row ids" is one with
  // no identity column: `_rowid` (schema notes section 3) or the INTEGER
  // PRIMARY KEY that is the rowid on SQLite. `keyColumns` keeps the SQLite
  // value `["rowid"]`; the rewrite maps it to that identity column.

  async listUserReferenceColumns(): Promise<UserReferenceColumn[]> {
    // confdeltype 'a' = NO ACTION, 'r' = RESTRICT. Ordered by table, then column position.
    const rows = await this.db.query<UserReferenceRow>(sql`
      SELECT "tableName", "columnName" FROM (
        SELECT rel.relname AS "tableName", att.attname AS "columnName", 0 AS part, att.attnum AS pos
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace AND ns.nspname = current_schema()
        JOIN pg_class ref ON ref.oid = con.confrelid AND ref.relname = 'users'
        CROSS JOIN LATERAL unnest(con.conkey) AS k(attnum)
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
        WHERE con.contype = 'f'
          AND con.confdeltype IN ('a', 'r')
          AND NOT att.attnotnull
        UNION ALL
        SELECT 'scheduled_tasks', att.attname, 1, att.attnum
        FROM pg_attribute att
        WHERE att.attrelid = to_regclass('scheduled_tasks')
          AND att.attname IN ('created_by', 'updated_by')
          AND NOT att.attisdropped
          AND NOT att.attnotnull
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint con
            JOIN pg_class ref ON ref.oid = con.confrelid AND ref.relname = 'users'
            WHERE con.conrelid = att.attrelid AND con.contype = 'f' AND att.attnum = ANY (con.conkey)
          )
      ) refs
      ORDER BY part, "tableName", pos`);
    const keysByTable = new Map<string, { withoutRowid: boolean; keyColumns: string[] }>();
    const references: UserReferenceColumn[] = [];
    for (const row of rows) {
      let key = keysByTable.get(row.tableName);
      if (key === undefined) {
        const withoutRowid = (await this.identityColumn(row.tableName)) === null;
        let keyColumns = ["rowid"];
        if (withoutRowid) {
          const pk = await this.db.query<{ name: string }>(sql`
            SELECT att.attname AS name
            FROM pg_index idx
            CROSS JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute att ON att.attrelid = idx.indrelid AND att.attnum = k.attnum
            WHERE idx.indrelid = to_regclass(${row.tableName}) AND idx.indisprimary
            ORDER BY k.ord`);
          keyColumns = pk.map((column) => column.name);
        }
        key = { withoutRowid, keyColumns };
        keysByTable.set(row.tableName, key);
      }
      references.push({ ...row, withoutRowid: key.withoutRowid, keyColumns: key.keyColumns });
    }
    return references;
  }

  /** The column that stands for SQLite's rowid in `table`, or null for a table without one. */
  private async identityColumn(table: string): Promise<string | null> {
    const row = await this.db.get<{ name: string }>(sql`
      SELECT attname AS name FROM pg_attribute
      WHERE attrelid = to_regclass(${table}) AND attidentity <> '' AND NOT attisdropped
      ORDER BY (attname = '_rowid') DESC, attnum
      LIMIT 1`);
    return row?.name ?? null;
  }

  async rewriteUserReferenceColumn(
    reference: UserReferenceColumn,
    userId: string,
    replacementUserId: string | null,
    limit?: number,
  ): Promise<number> {
    const table = sqlIdent(reference.tableName);
    const column = sqlIdent(reference.columnName);
    if (limit === undefined) {
      const result = await this.db.run(
        sql`UPDATE ${table} SET ${column} = ${replacementUserId} WHERE ${column} = ${userId}`,
      );
      return result.changes;
    }
    let keyNames = reference.keyColumns;
    if (keyNames.length === 1 && keyNames[0] === "rowid") {
      const identity = await this.identityColumn(reference.tableName);
      if (identity === null) throw new Error(`${reference.tableName} has no row id column`);
      keyNames = [identity];
    }
    const keys = sqlJoin(
      keyNames.map((name) => sql`${sqlIdent(name)}`),
      sql`, `,
    );
    const keyTuple = keyNames.length === 1 ? keys : sql`(${keys})`;
    const result = await this.db.run(sql`UPDATE ${table} SET ${column} = ${replacementUserId}
     WHERE ${keyTuple} IN (SELECT ${keys} FROM ${table} WHERE ${column} = ${userId} LIMIT ${limit})`);
    return result.changes;
  }

  async listWorkflowRunIdsRequestedBy(userId: string, limit?: number): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`SELECT id FROM workflow_runs
     WHERE ${CONTEXT_REQUESTER} = ${userId}
     ORDER BY id
     LIMIT ${limit ?? null}`);
    return rows.map((row) => row.id);
  }

  listSealedWorkflowContextsRequestedBy(
    runIds: string[],
    userId: string,
  ): Promise<{ id: string; context_replay: string }[]> {
    return this.db.query(sql`SELECT id, context_replay FROM workflow_runs
     WHERE id IN (${sqlList(runIds)})
       AND context_replay IS NOT NULL
       AND ${CONTEXT_REQUESTER} = ${userId}`);
  }

  async rewriteWorkflowRunContextRequester(
    runIds: string[],
    userId: string,
    replacementUserId: string | null,
  ): Promise<number> {
    const context = replacementUserId
      ? sql`jsonb_set(context, '{swarm,requestedByUserId}', to_jsonb(CAST(${replacementUserId} AS text)))`
      : sql`context #- '{swarm,requestedByUserId}'`;
    const result = await this.db.run(sql`UPDATE workflow_runs
         SET context = ${context}
         WHERE id IN (${sqlList(runIds)})
           AND ${CONTEXT_REQUESTER} = ${userId}`);
    return result.changes;
  }
}
