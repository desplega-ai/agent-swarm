import type { SwarmRepo } from "@/types";
import { getDbClient, getSwarmRepoById, updateSwarmRepo } from "./db";
import { changesAllowMerge } from "./repo-merge-policy";

export type CheckedRepoUpdate<Refusal> =
  | { kind: "updated"; repo: SwarmRepo }
  | { kind: "not-found" }
  | { kind: "refused"; refusal: Refusal };

/**
 * Applies a repo update whose `allowMerge` change the caller must be authorized for. The
 * guidelines `authorize` compares against, the decision and the write share one BEGIN IMMEDIATE
 * transaction, so a stale edit cannot overwrite a merge-policy change that committed after the
 * caller's read: the later writer waits, then decides against the committed value.
 *
 * `authorize` runs only when the update changes `allowMerge`. It returns a refusal to stop the
 * update, or null to allow it. It runs inside the transaction: read only what it needs through
 * the usual helpers (they join the transaction) and do no slow I/O.
 */
export async function updateSwarmRepoChecked<Refusal>(
  id: string,
  updates: Parameters<typeof updateSwarmRepo>[1],
  authorize: (existing: SwarmRepo) => Promise<Refusal | null> | Refusal | null,
): Promise<CheckedRepoUpdate<Refusal>> {
  return await getDbClient().transaction(async (): Promise<CheckedRepoUpdate<Refusal>> => {
    if (updates.guidelines !== undefined) {
      const existing = await getSwarmRepoById(id);
      if (existing && changesAllowMerge(existing.guidelines, updates.guidelines)) {
        const refusal = await authorize(existing);
        if (refusal !== null) return { kind: "refused", refusal };
      }
    }

    const repo = await updateSwarmRepo(id, updates);
    return repo ? { kind: "updated", repo } : { kind: "not-found" };
  });
}
