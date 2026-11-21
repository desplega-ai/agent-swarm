import type { SqlExecutor } from "../executor";
import { sql } from "../sql";

/**
 * Domain: schedules (`scheduled_tasks`). Rows come back in the SQLite value
 * shape on every engine (flags 0/1, JSON as text, timestamps as stored text).
 */
export interface SchedulesRepository {
  /** Ids of the schedules that name model profile `profile`. Ordered by id (unique). */
  listIdsByProfile(profile: string): Promise<string[]>;
  /** Ids of the schedules that name model group `modelGroup`. Ordered by id (unique). */
  listIdsByModelGroup(modelGroup: string): Promise<string[]>;
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
}
