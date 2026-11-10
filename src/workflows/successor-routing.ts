/**
 * Successor routing owed on a run, in this process.
 *
 * A step that completed has successors with no step row until a walk claims
 * them, so step rows alone can read as "nothing left to do". Every run
 * finalizer checks `hasOwedSuccessors` inside its transaction and leaves the
 * run to the walk that owes them: that walk's own finalizer settles the run.
 */

/** Claims waiting for their walk plus walks still routing, per run. */
const owed = new Map<string, number>();
/** The share of `owed` whose caller has not entered its walk yet, per run. */
const unwalked = new Map<string, number>();

function add(counts: Map<string, number>, runId: string, delta: number): void {
  const next = (counts.get(runId) ?? 0) + delta;
  if (next > 0) counts.set(runId, next);
  else counts.delete(runId);
}

export function hasOwedSuccessors(runId: string): boolean {
  return owed.has(runId);
}

/**
 * Hold the run for a walk the caller starts right after its transaction.
 * Call it inside the transaction that completes the step, so no finalizer can
 * read the completed row without also seeing the debt. The caller must then
 * call `walkGraph` for the run: a claim that never walks keeps the run from
 * finalizing. Returns an undo for a transaction that fails to commit.
 */
export function oweSuccessorWalk(runId: string): () => void {
  add(owed, runId, 1);
  add(unwalked, runId, 1);
  return () => {
    add(owed, runId, -1);
    add(unwalked, runId, -1);
  };
}

/**
 * Hold the run while a walk routes successors. Takes over the hold of a claim
 * that owes a walk on this run, else takes a new one. The release is
 * idempotent; run it before the holder's own finalizer.
 */
export function holdSuccessorRouting(runId: string): () => void {
  if (unwalked.has(runId)) add(unwalked, runId, -1);
  else add(owed, runId, 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    add(owed, runId, -1);
  };
}
