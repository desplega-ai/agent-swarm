import type { Database } from "bun:sqlite";

/** Runs inside the migration transaction before the scheduler can query due rows. */
export function normalizeScheduleNextRunTimes(
  db: Database,
  normalize: (value: string) => string | undefined,
): void {
  const rows = db.query<{ id: string; nextRunAt: string }, []>(`
    SELECT id, "nextRunAt" FROM scheduled_tasks
    WHERE "nextRunAt" IS NOT NULL
      AND "nextRunAt" NOT GLOB '????-??-??T??:??:??.???Z'
  `);
  const update = db.prepare('UPDATE scheduled_tasks SET "nextRunAt" = ? WHERE id = ?');
  for (const row of rows.all()) {
    const instant = normalize(row.nextRunAt);
    if (instant) update.run(instant, row.id);
  }
}
