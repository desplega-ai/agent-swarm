import { getDb } from "../db";

const SCRATCH_RETENTION_DAYS = 14;
const SCRATCH_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

let scratchGcTimer: ReturnType<typeof setInterval> | null = null;

/** Delete auto-saved scratch scripts that have not run within the retention window. */
export function purgeExpiredScratchScripts(now = new Date()): number {
  const cutoff = new Date(
    now.getTime() - SCRATCH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  return (
    getDb()
      .prepare<{ id: string }, [string]>(
        `DELETE FROM scripts
       WHERE scope = 'agent'
         AND isScratch = 1
         AND name GLOB 'scratch-*'
         AND updatedAt < ?
       RETURNING id`,
      )
      // RETURNING counts scripts only; SQLite's change count includes cascaded rows.
      .all(cutoff).length
  );
}

function runScratchScriptGc(label: "Initial" | "Periodic"): void {
  try {
    const purged = purgeExpiredScratchScripts();
    console.log(`[scratch-script-gc] ${label} purge removed ${purged} scratch script row(s)`);
  } catch (err) {
    console.error(`[scratch-script-gc] ${label} purge failed:`, (err as Error).message);
  }
}

/** Start the scratch-script retention GC (daily tick, immediate first run). */
export function startScratchScriptGc(intervalMs = SCRATCH_GC_INTERVAL_MS): void {
  if (scratchGcTimer) return;
  runScratchScriptGc("Initial");
  scratchGcTimer = setInterval(() => runScratchScriptGc("Periodic"), intervalMs);
  if (typeof scratchGcTimer.unref === "function") scratchGcTimer.unref();
}

export function stopScratchScriptGc(): void {
  if (!scratchGcTimer) return;
  clearInterval(scratchGcTimer);
  scratchGcTimer = null;
}
