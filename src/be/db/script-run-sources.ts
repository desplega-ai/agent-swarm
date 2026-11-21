import { getStorage } from "../storage";
import { computeContentHash } from "./context-versions";

// Keep legacy text readable while an upgrade backfills in batches. Both the
// public detail and the supervisor receive the exact executable source.
export const SCRIPT_RUN_SELECT = `SELECT r.*, s.source AS storedSource FROM script_runs r
  LEFT JOIN script_run_sources s ON s.hash = r.sourceHash`;

/** Called inside the same transaction that inserts the referencing run. */
export async function storeScriptRunSource(source: string): Promise<string> {
  const hash = computeContentHash(source);
  await getStorage().repos.scripts.storeScriptRunSource(hash, source);
  return hash;
}
