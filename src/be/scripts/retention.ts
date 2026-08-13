import { collectScriptReferences } from "../../apps/definition";
import { listAppRecords } from "../../apps/store";
import { getDb } from "../db";

const SCRATCH_RETENTION_DAYS = 14;
const SCRATCH_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

let scratchGcTimer: ReturnType<typeof setInterval> | null = null;

/** Every script id wired into an app definition, as an action or model source. */
function appReferencedScriptIds(): Set<string> {
  const ids = new Set<string>();
  for (const app of listAppRecords()) {
    for (const scriptId of collectScriptReferences(app.definition).keys()) {
      ids.add(scriptId);
    }
  }
  return ids;
}

/** Delete auto-saved scratch scripts that have not run within the retention window. */
export function purgeExpiredScratchScripts(now = new Date()): number {
  const cutoff = new Date(
    now.getTime() - SCRATCH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const candidates = getDb()
    .prepare<{ id: string }, [string]>(
      `SELECT id FROM scripts
       WHERE scope = 'agent'
         AND isScratch = 1
         AND name GLOB 'scratch-*'
         AND updatedAt < ?`,
    )
    .all(cutoff);
  if (candidates.length === 0) return 0;

  // A scratch script wired into an app (action source or model source) is no
  // longer "scratch" in effect — deleting it leaves the app's definition
  // dangling. Same guard the interactive scripts-API delete route enforces
  // via appScriptReferenceIssues, applied here to the whole sweep at once.
  const referenced = appReferencedScriptIds();
  const idsToDelete = candidates.map((row) => row.id).filter((id) => !referenced.has(id));
  if (idsToDelete.length === 0) return 0;

  const placeholders = idsToDelete.map(() => "?").join(",");
  return (
    getDb()
      .prepare<{ id: string }, string[]>(
        `DELETE FROM scripts WHERE id IN (${placeholders}) RETURNING id`,
      )
      // RETURNING counts scripts only; SQLite's change count includes cascaded rows.
      .all(...idsToDelete).length
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
