/**
 * A memory or script written while the embeddings endpoint is down keeps no
 * vector, and the backfills (`runBootReembed`, `runBootReembedScripts`) run
 * only at boot or when a config reload turns embeddings on. When an embedding
 * call works again after a failed one (for example, a local TEI restarted),
 * run both backfills once more, so those rows do not wait for the next API
 * restart.
 */

let failedSinceBackfill = false;
let backfill: Promise<void> | null = null;

/** An embedding call failed (network, server error, rejected request). */
export function noteEmbeddingFailure(): void {
  failedSinceBackfill = true;
}

/** An embedding call returned a vector. Starts the backfill after a failure. */
export function noteEmbeddingSuccess(): void {
  if (!failedSinceBackfill || backfill) return;
  failedSinceBackfill = false;
  const report = (what: string) => (err: unknown) => {
    console.error(
      `[memory] ${what} backfill after embeddings recovered failed:`,
      (err as Error).message,
    );
  };
  // Also resumes a space re-embed the outage paused.
  backfill = import("./embedding-space")
    .then(({ runEmbeddingMaintenance }) => runEmbeddingMaintenance({ backfill: true }))
    .catch(report("Embedding"))
    .finally(() => {
      backfill = null;
    });
}

/** The backfill started by the last recovery, if it still runs. For tests. */
export function pendingRecoveryBackfill(): Promise<void> | null {
  return backfill;
}

/** Forget a failure seen by an earlier test. */
export function resetEmbeddingRecoveryForTests(): void {
  failedSinceBackfill = false;
}
