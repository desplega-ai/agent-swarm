import {
  BaseMaintenanceRepository,
  type DbParam,
  type KeyedTextTable,
  SqlQuery,
  sql,
} from "@desplega/storage";
import { UPSERT_TASK_SEARCH } from "./tasks";

/** The statement time as `YYYY-MM-DD HH:MM:SS` UTC text (SQLite `datetime('now')`). */
const NOW_TEXT = sql`to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

/** Key prefix of a skipped boot-scrub version; the version number follows it. */
const SKIPPED_PREFIX = "boot-scrub-skipped-v";

export class PostgresMaintenanceRepository extends BaseMaintenanceRepository {
  async setState(key: string, value: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO seed_state (kind, key, "seededHash", "seededAt")
      VALUES ('maintenance', ${key}, ${value}, ${NOW_TEXT})
      ON CONFLICT (kind, key) DO UPDATE SET "seededHash" = excluded."seededHash", "seededAt" = ${NOW_TEXT}`);
  }

  /**
   * A rewrite of a task text or title (the boot scrub sweep redacts secrets in
   * them) also rewrites the stored search document, in the same statement.
   * Without it the old text stays searchable.
   */
  override async compareAndSetRow(
    target: KeyedTextTable,
    id: string,
    set: Readonly<Record<string, DbParam>>,
    expect: Readonly<Record<string, DbParam>>,
    expectNull: readonly string[],
  ): Promise<boolean> {
    if (target.table !== "agent_tasks" || !("task" in set || "title" in set)) {
      return super.compareAndSetRow(target, id, set, expect, expectNull);
    }
    const update = this.compareAndSetStatement(target, id, set, expect, expectNull);
    const row = await this.db.get<{ n: number }>(sql`
      WITH written AS (${update} RETURNING id, task, title),
           documents AS (${new SqlQuery([UPSERT_TASK_SEARCH], [])})
      SELECT COUNT(*)::int AS n FROM written`);
    return (row?.n ?? 0) > 0;
  }

  async deleteSkippedBootScrubVersions(version: number): Promise<void> {
    // SQLite's CAST(text AS INTEGER) reads the leading digits and 0 without any.
    await this.db.run(sql`
      DELETE FROM seed_state WHERE kind = 'maintenance'
        AND starts_with(key, ${SKIPPED_PREFIX})
        AND COALESCE(CAST(substring(substr(key, ${SKIPPED_PREFIX.length + 1}) FROM '^[0-9]+') AS numeric), 0)
            <= ${version}`);
  }
}
