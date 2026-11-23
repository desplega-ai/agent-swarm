import type { DbParam } from "../client";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlIdent, sqlJoin, sqlList } from "../sql";

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

/**
 * A read-only statement runner other than the repository's own executor: the
 * savings scans run through the bounded db-query child process. It receives
 * the SQL rendered for this engine.
 */
export type SavingsReader = <T>(text: string, params: DbParam[]) => Promise<T[]>;

/** How scanned runs are grouped: by UTC day (`YYYY-MM-DD`) or UTC minute (`YYYY-MM-DDTHH:MM`). */
export type SavingsBucketSize = "day" | "minute";

/** A scan window: `start` inclusive, `end` exclusive (ISO text). */
export type SavingsSpan = { start: string; end: string };

/** Day markers of a window: closed days computed (`n`) and the newest computation (`at`). */
export type SavingsMarkerSummary = { n: number; at: string | null };

/** The bucket filter of a window read. `jobKey` (workflows) or `jobId` (scripts) narrows to one job. */
export type SavingsBucketFilter =
  | { kind: "workflow"; modelVersion: number; jobKey?: string }
  | { kind: "script"; modelVersion: number; jobId?: string };

export type SavingsLinkSumRow = {
  parentJobId: string;
  childKind: "workflow" | "script" | "task";
  childJobId: string;
  linkKind: string;
  n: number;
  usd: number;
};

export type SavingsScheduleTargetRow = {
  id: string;
  name: string;
  enabled: number;
  targetType: string;
  workflowId: string | null;
  scriptName: string | null;
};

export type SavingsTriggerRow = { d: string; tt: string; st: string; n: number };
export type SavingsDayCountRow = { d: string; n: number };
export type SavingsStepFactRow = {
  d: string;
  nid: string;
  n: number;
  secs: number | null;
  itok: number | null;
  rchars: number | null;
  jev: number | null;
  clairic: number | null;
};
export type SavingsAgentSpendRow = {
  d: string;
  tasks: number;
  usd: number | null;
  ms: number | null;
};
export type SavingsEffectStepRow = { d: string; nid: string | null; n: number };
export type SavingsScriptRunRow = {
  d: string;
  nm: string;
  n: number;
  api: number;
  secs: number | null;
};
export type SavingsScriptEffectRow = { d: string; nm: string; api: number; n: number };
export type SavingsWorkflowLinkRow = { pid: string; cid: string; n: number };
export type SavingsScriptLinkRow = { pid: string; nm: string; n: number };
export type SavingsOwnedTaskRow = { pid: string; id: string };
export type SavingsTaskTreeRow = {
  root: string;
  below: number;
  n: number;
  usd: number | null;
  ms: number | null;
};
export type SavingsDispatchStepRow = { id: string; sa: string; fa: string; output: string | null };
export type SavingsCalibrationSessionRow = {
  id: string;
  turns: number;
  durationMs: number;
  inputTokens: unknown;
  outputTokens: unknown;
  cacheReadTokens: unknown;
  cacheWriteTokens: unknown;
  costUsd: unknown;
  totalCostUsd: unknown;
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

  // ---- rollup reads (the API's own executor) ----

  /** Every workflow, by name (names are unique). Definition as stored text. */
  listWorkflows(): Promise<{ id: string; name: string; definition: unknown }[]>;
  /** Closed days (`day < lastDay`) of `[firstDay, lastDay]` computed under `modelVersion`, and the newest computation. */
  summarizeDayMarkers(
    kind: SavingsJobKind,
    modelVersion: number,
    firstDay: string,
    lastDay: string,
  ): Promise<SavingsMarkerSummary | null>;
  /** The job key of a workflow's first bucket in `[firstDay, lastDay]` (any one row). */
  findWorkflowJobKey(
    workflowId: string,
    firstDay: string,
    lastDay: string,
  ): Promise<{ jobKey: string } | null>;
  /** Bucket rows per day of `[firstDay, lastDay]` matching `filter`, oldest day first. */
  countBucketsByDay(
    filter: SavingsBucketFilter,
    firstDay: string,
    lastDay: string,
  ): Promise<{ day: string; n: number }[]>;
  /**
   * Bucket rows of `[fromDay, toDay]` matching `filter`, with `columns` (code
   * chosen names), oldest day first; order within a day is the engine's.
   * A one-job filter reads through that job's index.
   */
  listBuckets<T>(
    filter: SavingsBucketFilter,
    columns: readonly string[],
    fromDay: string,
    toDay: string,
  ): Promise<T[]>;
  /** Id and definition of the given workflows. Unordered: the caller indexes them by id. */
  listWorkflowDefinitions(ids: string[]): Promise<{ id: string; definition: unknown }[]>;
  /** Whether a script of that name exists in any scope. */
  scriptNameExists(name: string): Promise<boolean>;
  workflowExists(id: string): Promise<boolean>;
  /** Distinct script names that schedules target, by name. */
  listScheduledScriptNames(): Promise<string[]>;
  /**
   * Links of `[firstDay, lastDay]` under `modelVersion`, summed per
   * (parent, child kind, child, link kind) in that order; the first day counts
   * by `firstDayShare`.
   */
  sumLinks(
    firstDay: string,
    lastDay: string,
    firstDayShare: number,
    modelVersion: number,
  ): Promise<SavingsLinkSumRow[]>;
  /** Session spend of the swarm with `createdAt` in `[start, end]`. */
  sumSessionCostUsd(start: string, end: string): Promise<number>;
  /** Every schedule, or one. Engine order. */
  listScheduleTargets(scheduleId?: string): Promise<SavingsScheduleTargetRow[]>;
  /**
   * Tasks created by schedules (all, or one) in `[start, end]` with their
   * recorded cost, per schedule. Unordered: the caller indexes them.
   */
  sumScheduleSpend(
    start: string,
    end: string,
    scheduleId?: string,
  ): Promise<{ scheduleId: string; runs: number; usd: number | null; ms: number | null }[]>;

  // ---- live scans (through `reader` when given, else the executor) ----
  // Unordered unless stated: the callers fold the rows into maps.

  /** Await count of each named non-scratch script; global rows come last (they win when folded in order). */
  listScriptAwaitCounts(
    names: string[],
    reader?: SavingsReader,
  ): Promise<{ name: string; aw: number }[]>;
  /** Names among `names` of non-scratch scripts whose source can dispatch a task or workflow. */
  listDispatchingScripts(names: string[], reader?: SavingsReader): Promise<string[]>;
  countWorkflowRunsInSpan(
    workflowId: string,
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<number>;
  workflowRunsByTrigger(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsTriggerRow[]>;
  /** Counted scheduled runs that created a task or a child run, per bucket. */
  workflowScheduledEffectRuns(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsDayCountRow[]>;
  workflowStepFacts(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsStepFactRow[]>;
  workflowAgentSpend(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsAgentSpendRow[]>;
  workflowFollowupSpend(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<{ d: string; fup: number | null }[]>;
  /** Effect runs of any trigger per bucket (`nid` null) and their steps per node. */
  workflowEffectSteps(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsEffectStepRow[]>;
  /** Script runs in the span; `scriptName` narrows to one (runs without one count as `inlineName`). */
  countScriptRuns(
    span: SavingsSpan,
    filter: { scriptName?: string; inlineName: string },
    reader?: SavingsReader,
  ): Promise<number>;
  scriptRunsByName(
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    filter: { scriptName?: string; inlineName: string },
    reader?: SavingsReader,
  ): Promise<SavingsScriptRunRow[]>;
  /** Script runs that created an agent task (stamped, or named in the output of a `dispatchers` run). */
  scriptEffectRuns(
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    filter: { scriptName?: string; inlineName: string },
    dispatchers: string[],
    reader?: SavingsReader,
  ): Promise<SavingsScriptEffectRow[]>;
  subWorkflowLinks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsWorkflowLinkRow[]>;
  stampedWorkflowLinks(
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<SavingsWorkflowLinkRow[]>;
  stampedScriptLinks(
    span: SavingsSpan,
    inlineName: string,
    reader?: SavingsReader,
  ): Promise<SavingsScriptLinkRow[]>;
  /** Tasks created in the span by a workflow step (stamped `sourceStepId`). */
  listStepTasks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsOwnedTaskRow[]>;
  /** Tasks created in the span by an agent-task node (`workflowRunId`). */
  listNodeTasks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsOwnedTaskRow[]>;
  /** Task trees below `roots` (at most `maxDepth` deep), per root and own/below, with their spend. */
  listTaskTrees(
    roots: string[],
    maxDepth: number,
    reader?: SavingsReader,
  ): Promise<SavingsTaskTreeRow[]>;
  /** Swarm-script steps of the given nodes (or their foreach iterations) of a workflow's runs in the span, with output. */
  listDispatchSteps(
    workflowId: string,
    span: SavingsSpan,
    nodeIds: string[],
    reader?: SavingsReader,
  ): Promise<SavingsDispatchStepRow[]>;
  /** Unstamped top-level api/manual runs among `ids`. */
  listUnstampedRuns(
    ids: string[],
    reader?: SavingsReader,
  ): Promise<{ id: string; wid: string; at: string }[]>;
  /** Tasks among `ids` with neither a workflow run nor a source step. */
  listUnstampedTasks(ids: string[], reader?: SavingsReader): Promise<{ id: string; at: string }[]>;

  // ---- calibration (keyset pages by id) ----

  /** Sessions of `model` with a per-model breakdown entry of `model`, `numTurns` in 1..`maxTurns`, id after `after`, by id. */
  listCalibrationSessions(
    model: string,
    span: SavingsSpan,
    maxTurns: number,
    after: string,
    limit: number,
    reader: SavingsReader,
  ): Promise<SavingsCalibrationSessionRow[]>;
  /** Sessions of `model` with `numTurns` in 3..`maxTurns`, id after `after`, by id. */
  listTierSessions(
    model: string,
    span: SavingsSpan,
    maxTurns: number,
    after: string,
    limit: number,
    reader: SavingsReader,
  ): Promise<{ id: string; turns: number; durationMs: number }[]>;
  /** Claude prices of `models` effective at or before `atMs`, oldest first. */
  listClaudePrices(
    models: string[],
    atMs: number,
    reader: SavingsReader,
  ): Promise<{ model: string; token_class: string; price: number }[]>;
  /** Deletes every bucket, marker and link of a day before `oldestDay`. */
  pruneBefore(oldestDay: string): Promise<void>;
}

type Reader = { query<T>(query: SqlQuery): Promise<T[]> };

export abstract class BaseSavingsRepository implements SavingsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  /** Run reads through `reader` (rendered for this engine), or the executor. */
  protected via(reader: SavingsReader | undefined): Reader {
    if (!reader) return this.db;
    const dialect = this.db.dialect;
    return {
      query: <T>(query: SqlQuery) => {
        const { text, params } = query.render(dialect);
        return reader<T>(text, params);
      },
    };
  }

  /** The bucket table of a window read; the SQLite engine pins a one-job read to that job's index. */
  protected bucketSource(_filter: SavingsBucketFilter): SqlQuery {
    return sql`automation_savings_daily`;
  }

  protected bucketWhere(filter: SavingsBucketFilter): SqlQuery {
    if (filter.kind === "workflow") {
      return sql`"jobKind"='workflow' AND "subKind"='' AND "modelVersion"=${filter.modelVersion}${
        filter.jobKey !== undefined ? sql` AND "jobKey"=${filter.jobKey}` : EMPTY
      }`;
    }
    return sql`"jobKind"='script' AND "modelVersion"=${filter.modelVersion}${
      filter.jobId !== undefined ? sql` AND "jobId"=${filter.jobId}` : EMPTY
    }`;
  }

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

  // ---- rollup reads ----

  listWorkflows(): Promise<{ id: string; name: string; definition: unknown }[]> {
    return this.db.query(sql`SELECT id, name, definition FROM workflows ORDER BY name`);
  }

  summarizeDayMarkers(
    kind: SavingsJobKind,
    modelVersion: number,
    firstDay: string,
    lastDay: string,
  ): Promise<SavingsMarkerSummary | null> {
    return this.db.get<SavingsMarkerSummary>(sql`
      SELECT count(CASE WHEN day<${lastDay} THEN 1 END) n, max("computedAt") AS at FROM automation_savings_days
      WHERE "jobKind"=${kind} AND "modelVersion"=${modelVersion} AND day>=${firstDay} AND day<=${lastDay}`);
  }

  findWorkflowJobKey(
    workflowId: string,
    firstDay: string,
    lastDay: string,
  ): Promise<{ jobKey: string } | null> {
    return this.db.get<{ jobKey: string }>(sql`
      SELECT "jobKey" FROM automation_savings_daily
      WHERE "jobKind"='workflow' AND "jobId"=${workflowId} AND day>=${firstDay} AND day<=${lastDay} LIMIT 1`);
  }

  countBucketsByDay(
    filter: SavingsBucketFilter,
    firstDay: string,
    lastDay: string,
  ): Promise<{ day: string; n: number }[]> {
    return this.db.query(sql`
      SELECT day, count(*) n FROM automation_savings_daily
      WHERE ${this.bucketWhere(filter)} AND day>=${firstDay} AND day<=${lastDay} GROUP BY day ORDER BY day`);
  }

  listBuckets<T>(
    filter: SavingsBucketFilter,
    columns: readonly string[],
    fromDay: string,
    toDay: string,
  ): Promise<T[]> {
    const names = sqlJoin(
      columns.map((c) => sql`${sqlIdent(c)}`),
      sql`, `,
    );
    return this.db.query<T>(sql`
      SELECT ${names} FROM ${this.bucketSource(filter)}
      WHERE ${this.bucketWhere(filter)} AND day>=${fromDay} AND day<=${toDay} ORDER BY day`);
  }

  listWorkflowDefinitions(ids: string[]): Promise<{ id: string; definition: unknown }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.query(sql`SELECT id, definition FROM workflows WHERE id IN (${sqlList(ids)})`);
  }

  async scriptNameExists(name: string): Promise<boolean> {
    return !!(await this.db.get(sql`SELECT 1 n FROM scripts WHERE name=${name} LIMIT 1`));
  }

  async workflowExists(id: string): Promise<boolean> {
    return !!(await this.db.get(sql`SELECT 1 n FROM workflows WHERE id=${id}`));
  }

  async listScheduledScriptNames(): Promise<string[]> {
    const rows = await this.db.query<{ scriptName: string }>(sql`
      SELECT DISTINCT "scriptName" FROM scheduled_tasks
      WHERE "targetType"='script' AND "scriptName" IS NOT NULL ORDER BY "scriptName"`);
    return rows.map((r) => r.scriptName);
  }

  sumLinks(
    firstDay: string,
    lastDay: string,
    firstDayShare: number,
    modelVersion: number,
  ): Promise<SavingsLinkSumRow[]> {
    return this.db.query<SavingsLinkSumRow>(sql`
      SELECT "parentJobId", "childKind", "childJobId", "linkKind",
        sum(CASE WHEN day=${firstDay} THEN n*${firstDayShare} ELSE n END) n,
        sum(CASE WHEN day=${firstDay} THEN "actualUsd"*${firstDayShare} ELSE "actualUsd" END) usd
      FROM automation_savings_links WHERE "modelVersion"=${modelVersion} AND day>=${firstDay} AND day<=${lastDay}
      GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`);
  }

  async sumSessionCostUsd(start: string, end: string): Promise<number> {
    const row = await this.db.get<{ usd: number | null }>(sql`
      SELECT sum("totalCostUsd") usd FROM session_costs WHERE "createdAt">=${start} AND "createdAt"<=${end}`);
    return Number(row?.usd) || 0;
  }

  listScheduleTargets(scheduleId?: string): Promise<SavingsScheduleTargetRow[]> {
    return this.db.query<SavingsScheduleTargetRow>(sql`
      SELECT id, name, enabled, "targetType", "workflowId", "scriptName" FROM scheduled_tasks${
        scheduleId ? sql` WHERE id=${scheduleId}` : EMPTY
      }`);
  }

  sumScheduleSpend(
    start: string,
    end: string,
    scheduleId?: string,
  ): Promise<{ scheduleId: string; runs: number; usd: number | null; ms: number | null }[]> {
    return this.db.query(sql`
      SELECT t."scheduleId", count(DISTINCT t.id) runs, sum(c."totalCostUsd") usd, sum(c."durationMs") ms
      FROM agent_tasks t LEFT JOIN session_costs c ON c."taskId"=t.id
      WHERE ${scheduleId ? sql`t."scheduleId"=${scheduleId}` : sql`t."scheduleId" IS NOT NULL`}
        AND t."createdAt">=${start} AND t."createdAt"<=${end}
      GROUP BY t."scheduleId"`);
  }

  // ---- live scans ----

  abstract listScriptAwaitCounts(
    names: string[],
    reader?: SavingsReader,
  ): Promise<{ name: string; aw: number }[]>;
  abstract listDispatchingScripts(names: string[], reader?: SavingsReader): Promise<string[]>;
  abstract countWorkflowRunsInSpan(
    workflowId: string,
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<number>;
  abstract workflowRunsByTrigger(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsTriggerRow[]>;
  abstract workflowScheduledEffectRuns(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsDayCountRow[]>;
  abstract workflowStepFacts(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsStepFactRow[]>;
  abstract workflowAgentSpend(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsAgentSpendRow[]>;
  abstract workflowFollowupSpend(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<{ d: string; fup: number | null }[]>;
  abstract workflowEffectSteps(
    workflowId: string,
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    reader?: SavingsReader,
  ): Promise<SavingsEffectStepRow[]>;

  async countScriptRuns(
    span: SavingsSpan,
    filter: { scriptName?: string; inlineName: string },
    reader?: SavingsReader,
  ): Promise<number> {
    // Starts the text with the statement: a reader may recognise the scan's opening count.
    const rows = await this.via(reader).query<{ n: number }>(
      sql`SELECT count(*) n FROM script_runs WHERE "startedAt">=${span.start} AND "startedAt"<${span.end}${
        filter.scriptName === undefined
          ? EMPTY
          : sql` AND coalesce("scriptName", ${filter.inlineName})=${filter.scriptName}`
      }`,
    );
    return Number(rows[0]?.n) || 0;
  }

  abstract scriptRunsByName(
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    filter: { scriptName?: string; inlineName: string },
    reader?: SavingsReader,
  ): Promise<SavingsScriptRunRow[]>;
  abstract scriptEffectRuns(
    span: SavingsSpan,
    bucket: SavingsBucketSize,
    filter: { scriptName?: string; inlineName: string },
    dispatchers: string[],
    reader?: SavingsReader,
  ): Promise<SavingsScriptEffectRow[]>;
  abstract subWorkflowLinks(
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<SavingsWorkflowLinkRow[]>;
  abstract stampedWorkflowLinks(
    span: SavingsSpan,
    reader?: SavingsReader,
  ): Promise<SavingsWorkflowLinkRow[]>;
  abstract stampedScriptLinks(
    span: SavingsSpan,
    inlineName: string,
    reader?: SavingsReader,
  ): Promise<SavingsScriptLinkRow[]>;
  abstract listStepTasks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsOwnedTaskRow[]>;
  abstract listNodeTasks(span: SavingsSpan, reader?: SavingsReader): Promise<SavingsOwnedTaskRow[]>;
  abstract listTaskTrees(
    roots: string[],
    maxDepth: number,
    reader?: SavingsReader,
  ): Promise<SavingsTaskTreeRow[]>;
  abstract listDispatchSteps(
    workflowId: string,
    span: SavingsSpan,
    nodeIds: string[],
    reader?: SavingsReader,
  ): Promise<SavingsDispatchStepRow[]>;

  listUnstampedRuns(
    ids: string[],
    reader?: SavingsReader,
  ): Promise<{ id: string; wid: string; at: string }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.via(reader).query(sql`
      SELECT id, "workflowId" wid, "startedAt" AS at FROM workflow_runs WHERE id IN (${sqlList(ids)})
        AND "parentStepId" IS NULL AND "sourceStepId" IS NULL AND "triggerType" IN ('api','manual')`);
  }

  listUnstampedTasks(ids: string[], reader?: SavingsReader): Promise<{ id: string; at: string }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.via(reader).query(sql`
      SELECT id, "createdAt" AS at FROM agent_tasks WHERE id IN (${sqlList(ids)})
        AND "workflowRunId" IS NULL AND "sourceStepId" IS NULL`);
  }

  // ---- calibration ----

  abstract listCalibrationSessions(
    model: string,
    span: SavingsSpan,
    maxTurns: number,
    after: string,
    limit: number,
    reader: SavingsReader,
  ): Promise<SavingsCalibrationSessionRow[]>;

  listTierSessions(
    model: string,
    span: SavingsSpan,
    maxTurns: number,
    after: string,
    limit: number,
    reader: SavingsReader,
  ): Promise<{ id: string; turns: number; durationMs: number }[]> {
    return this.via(reader).query(sql`
      SELECT id, "numTurns" AS turns, "durationMs" FROM session_costs
      WHERE model = ${model} AND "createdAt" >= ${span.start} AND "createdAt" < ${span.end}
        AND "numTurns" BETWEEN 3 AND ${maxTurns} AND id > ${after} ORDER BY id LIMIT ${limit}`);
  }

  listClaudePrices(
    models: string[],
    atMs: number,
    reader: SavingsReader,
  ): Promise<{ model: string; token_class: string; price: number }[]> {
    return this.via(reader).query(sql`
      SELECT model, token_class, price_per_million_usd AS price FROM pricing
      WHERE provider = 'claude' AND model IN (${sqlList(models)}) AND effective_from <= ${atMs}
      ORDER BY effective_from`);
  }
}
