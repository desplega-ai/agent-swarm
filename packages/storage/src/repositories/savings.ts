import type { SqlExecutor } from "../executor";
import { sql, sqlIdent, sqlJoin } from "../sql";

/**
 * Domain: automation savings rollup (`automation_savings_daily`,
 * `automation_savings_days`, `automation_savings_links`), part of sessions
 * and cost. Rows come back in the SQLite value shape on every engine.
 */

export type SavingsJobKind = "workflow" | "script";

export type SavingsDayMarkerRow = { day: string; modelVersion: number; computedAt: string };

/** One workflow bucket: fact columns by name (the caller owns the column list). */
export type SavingsWorkflowBucket = {
  day: string;
  jobId: string;
  jobKey: string;
  jobName: string;
  facts: Record<string, number>;
  modelVersion: number;
  computedAt: string;
};

export type SavingsScriptBucket = {
  day: string;
  jobId: string;
  jobKey: string;
  jobName: string;
  subKind: string;
  runs: number;
  countedRuns: number;
  effectRuns: number;
  opsSum: number;
  computeSecs: number;
  modelVersion: number;
  computedAt: string;
};

export type SavingsLinkRow = {
  day: string;
  parentJobId: string;
  childKind: string;
  childJobId: string;
  linkKind: string;
  n: number;
  actualUsd: number;
  keptUsd: number;
  modelVersion: number;
  computedAt: string;
};

export interface SavingsRepository {
  /** Day markers of one job kind on or after `oldestDay`. Unordered: the caller indexes them by day. */
  listDayMarkers(kind: SavingsJobKind, oldestDay: string): Promise<SavingsDayMarkerRow[]>;
  /** The marker of a day computed under `modelVersion`. */
  findDayMarker(
    day: string,
    kind: SavingsJobKind,
    modelVersion: number,
  ): Promise<{ computedAt: string } | null>;
  /**
   * Marks a day computed, unless a newer scan under the same model version
   * already did.
   */
  markDay(
    day: string,
    kind: SavingsJobKind,
    modelVersion: number,
    computedAt: string,
  ): Promise<void>;
  /** Deletes a day's workflow buckets scanned at or before `scannedAt` or under another model version. */
  deleteStaleWorkflowBuckets(day: string, scannedAt: string, modelVersion: number): Promise<void>;
  /**
   * Upserts a workflow bucket unless the stored one comes from a newer scan
   * under the same model version.
   */
  upsertWorkflowBucket(bucket: SavingsWorkflowBucket): Promise<void>;
  findWorkflowBucket(
    day: string,
    workflowId: string,
  ): Promise<{ computedAt: string; childTaskUsd: number; childTaskMs: number } | null>;
  deleteScriptBuckets(day: string): Promise<void>;
  /** Writes a script bucket, replacing a row with the same key. */
  replaceScriptBucket(bucket: SavingsScriptBucket): Promise<void>;
  deleteLinks(day: string): Promise<void>;
  /** Writes a link, replacing a row with the same key. */
  replaceLink(link: SavingsLinkRow): Promise<void>;
  /** Runs of a workflow that started at or after `since` (`workflow_runs`). */
  countWorkflowRunsSince(workflowId: string, since: string): Promise<number>;
  /** Deletes every bucket, marker and link of a day before `oldestDay`. */
  pruneBefore(oldestDay: string): Promise<void>;
}

export abstract class BaseSavingsRepository implements SavingsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  listDayMarkers(kind: SavingsJobKind, oldestDay: string): Promise<SavingsDayMarkerRow[]> {
    return this.db.query<SavingsDayMarkerRow>(sql`
      SELECT day, "modelVersion", "computedAt" FROM automation_savings_days
      WHERE "jobKind" = ${kind} AND day >= ${oldestDay}`);
  }

  findDayMarker(
    day: string,
    kind: SavingsJobKind,
    modelVersion: number,
  ): Promise<{ computedAt: string } | null> {
    return this.db.get<{ computedAt: string }>(sql`
      SELECT "computedAt" FROM automation_savings_days
      WHERE day = ${day} AND "jobKind" = ${kind} AND "modelVersion" = ${modelVersion}`);
  }

  async markDay(
    day: string,
    kind: SavingsJobKind,
    modelVersion: number,
    computedAt: string,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO automation_savings_days (day, "jobKind", "modelVersion", "computedAt")
      VALUES (${day}, ${kind}, ${modelVersion}, ${computedAt})
      ON CONFLICT (day, "jobKind") DO UPDATE SET
        "modelVersion" = excluded."modelVersion", "computedAt" = excluded."computedAt"
      WHERE excluded."computedAt" >= automation_savings_days."computedAt"
        OR automation_savings_days."modelVersion" <> excluded."modelVersion"`);
  }

  async deleteStaleWorkflowBuckets(
    day: string,
    scannedAt: string,
    modelVersion: number,
  ): Promise<void> {
    await this.db.run(sql`
      DELETE FROM automation_savings_daily
      WHERE day = ${day} AND "jobKind" = 'workflow'
        AND ("computedAt" <= ${scannedAt} OR "modelVersion" <> ${modelVersion})`);
  }

  async upsertWorkflowBucket(bucket: SavingsWorkflowBucket): Promise<void> {
    const columns = Object.keys(bucket.facts);
    const names = sqlJoin(
      columns.map((c) => sql`${sqlIdent(c)}`),
      sql`, `,
    );
    const values = sqlJoin(
      columns.map((c) => sql`${bucket.facts[c] as number}`),
      sql`, `,
    );
    const updates = sqlJoin(
      columns.map((c) => sql`${sqlIdent(c)} = excluded.${sqlIdent(c)}`),
      sql`, `,
    );
    await this.db.run(sql`
      INSERT INTO automation_savings_daily
        (day, "jobKind", "jobId", "jobKey", "jobName", "subKind", ${names}, "modelVersion", "computedAt")
      VALUES (${bucket.day}, 'workflow', ${bucket.jobId}, ${bucket.jobKey}, ${bucket.jobName}, '', ${values},
        ${bucket.modelVersion}, ${bucket.computedAt})
      ON CONFLICT (day, "jobKind", "jobId", "subKind") DO UPDATE SET
        "jobKey" = excluded."jobKey", "jobName" = excluded."jobName",
        ${updates},
        "modelVersion" = excluded."modelVersion", "computedAt" = excluded."computedAt"
      WHERE excluded."computedAt" >= automation_savings_daily."computedAt"
        OR automation_savings_daily."modelVersion" <> excluded."modelVersion"`);
  }

  findWorkflowBucket(
    day: string,
    workflowId: string,
  ): Promise<{ computedAt: string; childTaskUsd: number; childTaskMs: number } | null> {
    return this.db.get(sql`
      SELECT "computedAt", "childTaskUsd", "childTaskMs" FROM automation_savings_daily
      WHERE day = ${day} AND "jobKind" = 'workflow' AND "jobId" = ${workflowId} AND "subKind" = ''`);
  }

  async deleteScriptBuckets(day: string): Promise<void> {
    await this.db.run(
      sql`DELETE FROM automation_savings_daily WHERE day = ${day} AND "jobKind" = 'script'`,
    );
  }

  /** `INSERT OR REPLACE` semantics: kept per engine. */
  abstract replaceScriptBucket(bucket: SavingsScriptBucket): Promise<void>;

  async deleteLinks(day: string): Promise<void> {
    await this.db.run(sql`DELETE FROM automation_savings_links WHERE day = ${day}`);
  }

  /** `INSERT OR REPLACE` semantics: kept per engine. */
  abstract replaceLink(link: SavingsLinkRow): Promise<void>;

  async countWorkflowRunsSince(workflowId: string, since: string): Promise<number> {
    const row = await this.db.get<{ n: number | string }>(sql`
      SELECT count(*) AS n FROM workflow_runs WHERE "workflowId" = ${workflowId} AND "startedAt" >= ${since}`);
    return Number(row?.n ?? 0);
  }

  async pruneBefore(oldestDay: string): Promise<void> {
    await this.db.run(sql`DELETE FROM automation_savings_daily WHERE day < ${oldestDay}`);
    await this.db.run(sql`DELETE FROM automation_savings_days WHERE day < ${oldestDay}`);
    await this.db.run(sql`DELETE FROM automation_savings_links WHERE day < ${oldestDay}`);
  }
}
