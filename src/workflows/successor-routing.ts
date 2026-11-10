/**
 * Successor routing owed on a run, in this process.
 *
 * A step that completed has successors with no step row until a walk claims
 * them, so step rows alone can read as "nothing left to do". Every run
 * finalizer checks `hasOwedSuccessors` inside its transaction and leaves the
 * run to the walk that owes them: that walk's own finalizer settles the run.
 */

import { getDbClient } from "../be/db";
import type { WorkflowNode } from "../types";

/** Open holds per run: claims waiting for their walk plus walks still routing. */
const owed = new Map<string, number>();

function add(runId: string, delta: number): void {
  const next = (owed.get(runId) ?? 0) + delta;
  if (next > 0) owed.set(runId, next);
  else owed.delete(runId);
}

export function hasOwedSuccessors(runId: string): boolean {
  return owed.has(runId);
}

/**
 * One claim's hold on its run. Only the walk handed this object takes it over,
 * so no other walk on the run can release it.
 */
export interface SuccessorWalkDebt {
  readonly runId: string;
  /** Drop the hold. Idempotent. */
  release(): void;
  /** True once a walk took the hold over. */
  takenOver: boolean;
}

/**
 * Hold the run for a walk the caller starts right after its transaction.
 * Call it inside the transaction that completes the step, so no finalizer can
 * read the completed row without also seeing the debt. The caller must then
 * pass the debt to `walkGraph` (`options.successorDebt`), or release it: a
 * claim that never walks keeps the run from finalizing.
 */
export function oweSuccessorWalk(runId: string): SuccessorWalkDebt {
  add(runId, 1);
  let released = false;
  return {
    runId,
    takenOver: false,
    release() {
      if (released) return;
      released = true;
      add(runId, -1);
    },
  };
}

/**
 * Hold the run while a walk routes successors. Takes over `debt`, the hold of
 * the claim this walk routes, else takes a new one. The release is idempotent;
 * run it before the holder's own finalizer.
 */
export function holdSuccessorRouting(runId: string, debt?: SuccessorWalkDebt): () => void {
  if (debt && debt.runId === runId && !debt.takenOver) {
    debt.takenOver = true;
    return () => debt.release();
  }
  return oweSuccessorWalk(runId).release;
}

/** The fields of a claim result that decide whether it owes a walk. */
interface SuccessorClaim {
  claimed: boolean;
  runFailed: boolean;
  successors: WorkflowNode[];
}

/**
 * Run a claim that completes a step and hands its successors to the caller.
 * The successors have no step row until the caller's walk claims them, so the
 * claim holds the run against finalizers from inside its own transaction.
 * Callers pass a claimed result with successors straight to `walkGraph`, with
 * `successorDebt` in its options, or release the debt.
 */
export async function claimAndOweWalk<T extends SuccessorClaim>(
  runId: string,
  claim: () => Promise<T>,
): Promise<T & { successorDebt?: SuccessorWalkDebt }> {
  let debt: SuccessorWalkDebt | undefined;
  try {
    return await getDbClient().transaction(async () => {
      const result = await claim();
      if (result.claimed && !result.runFailed && result.successors.length > 0) {
        debt = oweSuccessorWalk(runId);
        // Inside a caller's transaction the claim publishes only at its
        // COMMIT; a rollback there (or a failed COMMIT) must drop the hold too.
        getDbClient().afterRollback(debt.release);
        return { ...result, successorDebt: debt };
      }
      return result;
    });
  } catch (err) {
    // This claim's own savepoint rolled back while the outer transaction lives on.
    debt?.release();
    throw err;
  }
}
