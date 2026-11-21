import type { SqlExecutor } from "../executor";
import { sql } from "../sql";

/**
 * Domain: schedules (`scheduled_tasks`). Rows come back in the SQLite value
 * shape on every engine (flags 0/1, JSON as text, timestamps as stored text).
 */
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
}
