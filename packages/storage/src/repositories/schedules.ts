import { jsonText, likeAsciiCi } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlIdent, sqlJoin } from "../sql";

/**
 * Domain: schedules (`scheduled_tasks`). Rows come back in the SQLite value
 * shape on every engine (flags 0/1, JSON as text, timestamps as stored text).
 */

/** One `scheduled_tasks` row. */
export type ScheduledTaskRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  cronExpression: string | null;
  intervalMs: number | null;
  taskTemplate: string | null;
  taskType: string | null;
  tags: string | null;
  priority: number;
  targetAgentId: string | null;
  enabled: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdByAgentId: string | null;
  updatedByAgentId: string | null;
  parentTaskId: string | null;
  requestedDelayMs: number | null;
  requestedRunAt: string | null;
  timezone: string;
  consecutiveErrors: number | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  model: string | null;
  modelTier: string | null;
  profile: string | null;
  modelGroup?: string | null;
  scheduleType: string;
  targetType: string;
  workflowId: string | null;
  scriptName: string | null;
  scriptArgs: string | null;
  params: string;
  requiredParams: string;
  requires: string;
  createdAt: string;
  lastUpdatedAt: string;
  created_by: string | null;
  updated_by: string | null;
};

/** The columns of a new `scheduled_tasks` row (`enabled` as a JS boolean). */
export type NewScheduledTaskRow = Omit<
  ScheduledTaskRow,
  | "enabled"
  | "lastRunAt"
  | "consecutiveErrors"
  | "lastErrorAt"
  | "lastErrorMessage"
  | "modelGroup"
  | "tags"
> & { enabled: boolean; tags: string; modelGroup: string | null };

/** Columns an update may set. `enabled` is a JS boolean. */
export type ScheduledTaskColumnUpdate = Partial<
  Omit<ScheduledTaskRow, "id" | "createdAt" | "enabled" | "lastUpdatedAt" | "created_by">
> & { enabled?: boolean };

/** Order and columns of the `ScheduledTaskColumnUpdate` SET list. */
/** The columns that hold JSON text (bound through `jsonText`: jsonb on Postgres). */
const SCHEDULE_JSON_COLUMNS: ReadonlySet<string> = new Set([
  "tags",
  "scriptArgs",
  "params",
  "requiredParams",
  "requires",
]);

const UPDATE_COLUMNS = [
  "key",
  "name",
  "description",
  "cronExpression",
  "intervalMs",
  "taskTemplate",
  "taskType",
  "tags",
  "priority",
  "targetAgentId",
  "enabled",
  "lastRunAt",
  "nextRunAt",
  "timezone",
  "consecutiveErrors",
  "lastErrorAt",
  "lastErrorMessage",
  "model",
  "modelTier",
  "profile",
  "modelGroup",
  "scheduleType",
  "targetType",
  "workflowId",
  "scriptName",
  "scriptArgs",
  "params",
  "requiredParams",
  "requires",
  "updated_by",
  "updatedByAgentId",
  "createdByAgentId",
  "parentTaskId",
  "requestedDelayMs",
  "requestedRunAt",
] as const satisfies readonly (keyof ScheduledTaskColumnUpdate)[];

export type ScheduledTaskFilter = {
  enabled?: boolean;
  /** Substring of the name (case-insensitive for ASCII). */
  name?: string;
  scheduleType?: string;
  targetType?: string;
  workflowId?: string;
  scriptName?: string;
  key?: string;
  /** A LIKE pattern on `key` with `\` as the escape character. */
  keyPattern?: string;
  consecutiveErrorsMin?: number;
  lastRunStatus?: "failed" | "succeeded";
  /** Leave out disabled one-time schedules. */
  hideCompleted: boolean;
  limit?: number;
};

/**
 * The setup metadata a schedule or workflow carries for the automation
 * preflight. The JSON columns stay text.
 */
export type AutomationPreflightRowText = {
  id: string;
  name: string;
  kind: "schedule" | "workflow";
  params: string;
  requiredParams: string;
  requires: string;
};

export interface SchedulesRepository {
  /** Ids of the schedules that name model profile `profile`. Ordered by id (unique). */
  listIdsByProfile(profile: string): Promise<string[]>;
  /** Ids of the schedules that name model group `modelGroup`. Ordered by id (unique). */
  listIdsByModelGroup(modelGroup: string): Promise<string[]>;
  /**
   * Setup metadata (`params`, `requiredParams`, `requires` as JSON text) of
   * the enabled schedules. Insertion order.
   */
  listEnabledPreflightRows(): Promise<AutomationPreflightRowText[]>;
  getLastError(
    id: string,
  ): Promise<{ lastErrorAt: string | null; lastErrorMessage: string | null } | null>;
  /** Sets lastErrorAt, lastErrorMessage and lastUpdatedAt. */
  setLastError(id: string, error: { at: string; message: string; now: string }): Promise<void>;
  /**
   * Schedules matching `f`: ever-run first, newest `lastRunAt` first, newest
   * `lastUpdatedAt` first, then insertion order.
   */
  listScheduledTasks(f: ScheduledTaskFilter): Promise<ScheduledTaskRow[]>;
  findScheduledTaskById(id: string): Promise<ScheduledTaskRow | null>;
  findScheduledTaskByName(name: string): Promise<ScheduledTaskRow | null>;
  insertScheduledTask(row: NewScheduledTaskRow): Promise<ScheduledTaskRow | null>;
  /** Sets the given columns and `lastUpdatedAt`. */
  updateScheduledTask(
    id: string,
    update: ScheduledTaskColumnUpdate,
    lastUpdatedAt: string,
  ): Promise<ScheduledTaskRow | null>;
  /** The parent task of an unfired deferral schedule (no task carries its id yet). */
  findUnfiredDeferralParent(id: string): Promise<string | null>;
  deleteScheduledTask(id: string): Promise<number>;
  /** Enabled schedules due at `now`, earliest `nextRunAt` first, then insertion order. */
  listDueScheduledTasks(now: string): Promise<ScheduledTaskRow[]>;
  /**
   * Deletes disabled one-time deferral schedules that last ran before `cutoff`
   * and have no pending task or event wait.
   */
  deleteSpentDeferredSchedules(cutoff: string): Promise<number>;
}

export abstract class BaseSchedulesRepository implements SchedulesRepository {
  constructor(protected readonly db: SqlExecutor) {}

  async listIdsByProfile(profile: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM scheduled_tasks WHERE profile = ${profile} ORDER BY id`,
    );
    return rows.map((row) => row.id);
  }

  async listIdsByModelGroup(modelGroup: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM scheduled_tasks WHERE "modelGroup" = ${modelGroup} ORDER BY id`,
    );
    return rows.map((row) => row.id);
  }

  /** Insertion order differs per engine (SQLite `rowid`). */
  abstract listEnabledPreflightRows(): Promise<AutomationPreflightRowText[]>;

  getLastError(
    id: string,
  ): Promise<{ lastErrorAt: string | null; lastErrorMessage: string | null } | null> {
    return this.db.get<{ lastErrorAt: string | null; lastErrorMessage: string | null }>(
      sql`SELECT "lastErrorAt", "lastErrorMessage" FROM scheduled_tasks WHERE id = ${id}`,
    );
  }

  async setLastError(id: string, e: { at: string; message: string; now: string }): Promise<void> {
    await this.db.run(sql`
      UPDATE scheduled_tasks
         SET "lastErrorAt" = ${e.at}, "lastErrorMessage" = ${e.message}, "lastUpdatedAt" = ${e.now}
       WHERE id = ${id}`);
  }

  /** The insertion-order column (SQLite `rowid`), for ORDER BY tiebreaks only. */
  protected abstract insertionOrder(): SqlQuery;

  listScheduledTasks(f: ScheduledTaskFilter): Promise<ScheduledTaskRow[]> {
    const c: SqlQuery[] = [sql`1=1`];
    if (f.enabled !== undefined) c.push(sql`enabled = ${f.enabled}`);
    if (f.name) c.push(sql`${likeAsciiCi(sql`name`, sql`${`%${f.name}%`}`)}`);
    if (f.scheduleType) c.push(sql`"scheduleType" = ${f.scheduleType}`);
    if (f.targetType) c.push(sql`"targetType" = ${f.targetType}`);
    if (f.workflowId) c.push(sql`"workflowId" = ${f.workflowId}`);
    if (f.scriptName) c.push(sql`"scriptName" = ${f.scriptName}`);
    if (f.key) c.push(sql`"key" = ${f.key}`);
    else if (f.keyPattern) c.push(sql`${likeAsciiCi(sql`"key"`, sql`${f.keyPattern}`, "\\")}`);
    if (f.consecutiveErrorsMin !== undefined) {
      c.push(sql`"consecutiveErrors" >= ${f.consecutiveErrorsMin}`);
    }
    if (f.lastRunStatus === "failed") c.push(sql`"consecutiveErrors" > 0`);
    else if (f.lastRunStatus === "succeeded") {
      c.push(sql`"lastRunAt" IS NOT NULL AND "consecutiveErrors" = 0`);
    }
    if (f.hideCompleted) c.push(sql`NOT ("scheduleType" = 'one_time' AND enabled = ${false})`);
    const limit = f.limit !== undefined ? sql` LIMIT ${f.limit}` : EMPTY;
    return this.db.query<ScheduledTaskRow>(sql`
      SELECT * FROM scheduled_tasks WHERE ${sqlJoin(c, sql` AND `)}
      ORDER BY "lastRunAt" IS NULL ASC, "lastRunAt" DESC, "lastUpdatedAt" DESC,
        ${this.insertionOrder()} ASC${limit}`);
  }

  findScheduledTaskById(id: string): Promise<ScheduledTaskRow | null> {
    return this.db.get<ScheduledTaskRow>(sql`SELECT * FROM scheduled_tasks WHERE id = ${id}`);
  }

  findScheduledTaskByName(name: string): Promise<ScheduledTaskRow | null> {
    return this.db.get<ScheduledTaskRow>(sql`SELECT * FROM scheduled_tasks WHERE name = ${name}`);
  }

  insertScheduledTask(r: NewScheduledTaskRow): Promise<ScheduledTaskRow | null> {
    return this.db.get<ScheduledTaskRow>(sql`
      INSERT INTO scheduled_tasks (
        id, "key", name, description, "cronExpression", "intervalMs", "taskTemplate",
        "taskType", tags, priority, "targetAgentId", enabled, "nextRunAt",
        "createdByAgentId", "parentTaskId", "requestedDelayMs", "requestedRunAt",
        timezone, model, "modelTier", profile, "modelGroup", "scheduleType",
        "targetType", "workflowId", "scriptName", "scriptArgs", params, "requiredParams", requires,
        "createdAt", "lastUpdatedAt",
        created_by, updated_by, "updatedByAgentId"
      ) VALUES (
        ${r.id}, ${r.key}, ${r.name}, ${r.description}, ${r.cronExpression}, ${r.intervalMs},
        ${r.taskTemplate}, ${r.taskType}, ${jsonText(r.tags)}, ${r.priority}, ${r.targetAgentId}, ${r.enabled},
        ${r.nextRunAt}, ${r.createdByAgentId}, ${r.parentTaskId}, ${r.requestedDelayMs},
        ${r.requestedRunAt}, ${r.timezone}, ${r.model}, ${r.modelTier}, ${r.profile}, ${r.modelGroup},
        ${r.scheduleType}, ${r.targetType}, ${r.workflowId}, ${r.scriptName}, ${jsonText(r.scriptArgs)},
        ${jsonText(r.params)}, ${jsonText(r.requiredParams)}, ${jsonText(r.requires)}, ${r.createdAt}, ${r.lastUpdatedAt},
        ${r.created_by}, ${r.updated_by}, ${r.updatedByAgentId}
      ) RETURNING *`);
  }

  updateScheduledTask(
    id: string,
    u: ScheduledTaskColumnUpdate,
    lastUpdatedAt: string,
  ): Promise<ScheduledTaskRow | null> {
    const sets: SqlQuery[] = [];
    for (const column of UPDATE_COLUMNS) {
      const value = u[column];
      if (value === undefined) continue;
      const bound =
        SCHEDULE_JSON_COLUMNS.has(column) && (typeof value === "string" || value === null)
          ? sql`${jsonText(value)}`
          : sql`${value}`;
      sets.push(sql`${sqlIdent(column)} = ${bound}`);
    }
    sets.push(sql`"lastUpdatedAt" = ${lastUpdatedAt}`);
    return this.db.get<ScheduledTaskRow>(
      sql`UPDATE scheduled_tasks SET ${sqlJoin(sets, sql`, `)} WHERE id = ${id} RETURNING *`,
    );
  }

  async findUnfiredDeferralParent(id: string): Promise<string | null> {
    const row = await this.db.get<{ parentTaskId: string }>(sql`
      SELECT "parentTaskId" FROM scheduled_tasks
      WHERE id = ${id} AND "taskType" = 'deferred' AND "parentTaskId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_tasks WHERE "scheduleId" = scheduled_tasks.id)`);
    return row?.parentTaskId ?? null;
  }

  async deleteScheduledTask(id: string): Promise<number> {
    return (await this.db.run(sql`DELETE FROM scheduled_tasks WHERE id = ${id}`)).changes;
  }

  listDueScheduledTasks(now: string): Promise<ScheduledTaskRow[]> {
    return this.db.query<ScheduledTaskRow>(sql`
      SELECT * FROM scheduled_tasks
      WHERE enabled = ${true} AND "nextRunAt" IS NOT NULL AND "nextRunAt" <= ${now}
      ORDER BY "nextRunAt" ASC, ${this.insertionOrder()} ASC`);
  }

  async deleteSpentDeferredSchedules(cutoff: string): Promise<number> {
    const result = await this.db.run(sql`
      DELETE FROM scheduled_tasks
      WHERE "taskType" = 'deferred' AND "scheduleType" = 'one_time' AND enabled = ${false}
        AND "lastRunAt" IS NOT NULL AND "lastRunAt" < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM deferred_task_waits w
          WHERE w."scheduleId" = scheduled_tasks.id AND w.status = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM deferred_event_waits e
          WHERE e."scheduleId" = scheduled_tasks.id AND e.status = 'pending'
        )`);
    return result.changes;
  }
}
