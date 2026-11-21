import type { Database } from "bun:sqlite";
import { normalizeDateRequired, parseScheduleInstant } from "../date-utils";

/** Runs inside the migration transaction before the scheduler can query due rows. */
export function normalizeScheduleNextRunTimes(db: Database): void {
  const rows = db.query<{ id: string; nextRunAt: string }, []>(`
    SELECT id, nextRunAt FROM scheduled_tasks
    WHERE nextRunAt IS NOT NULL
      AND nextRunAt NOT GLOB '????-??-??T??:??:??.???Z'
  `);
  const update = db.prepare("UPDATE scheduled_tasks SET nextRunAt = ? WHERE id = ?");
  for (const row of rows.all()) {
    const instant = parseScheduleInstant(normalizeDateRequired(row.nextRunAt));
    if (instant) update.run(instant.toISOString(), row.id);
  }
}
