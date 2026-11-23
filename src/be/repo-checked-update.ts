import { can } from "@/rbac";
import type { SwarmRepo } from "@/types";
import type { HttpRequestAuth } from "@/utils/request-auth-context";
import { getAgentById, getSwarmRepoById, updateSwarmRepo } from "./db";
import { changesMergePolicy } from "./repo-merge-policy";
import { getStorage } from "./storage";

export type CheckedRepoUpdate<Refusal> =
  | { kind: "updated"; repo: SwarmRepo }
  | { kind: "not-found" }
  | { kind: "refused"; refusal: Refusal };

type RepoUpdates = Parameters<typeof updateSwarmRepo>[1];

/**
 * True when `updates` changes the fields a worker acts on before any model step: the `url` it
 * clones, the `clonePath` it clones into, or whether it runs the hook install there. A resend of
 * the stored value is not a change.
 */
function changesExecConfig(existing: SwarmRepo, updates: RepoUpdates): boolean {
  return (
    (updates.url !== undefined && updates.url !== existing.url) ||
    (updates.clonePath !== undefined && updates.clonePath !== existing.clonePath) ||
    (updates.hooks !== undefined &&
      (updates.hooks?.enabled === true) !== (existing.hooks?.enabled === true))
  );
}

/**
 * The refusal text when the request authenticated with an agent session token (task, runtime or
 * agent-bound) whose agent may not do `repo.exec-config.write`, else null. The shared API key,
 * user tokens and dashboard sessions are not checked here, so a worker on the shared key behaves
 * as before.
 */
export async function execConfigRefusal(
  auth: HttpRequestAuth | null,
  source: "http" | "mcp",
): Promise<string | null> {
  // A page session carries its viewer's identity, but the page's code is agent-authored and
  // the page proxy forwards any /api/* route (same rule as human-only config keys).
  if (auth?.page) {
    return "Forbidden: a page session cannot change a repo's url, clonePath or hooks.";
  }
  if (auth?.kind !== "agent") return null;
  const agent = await getAgentById(auth.agentId);
  const decision = can({
    principal: { kind: "agent", agentId: auth.agentId, isLead: agent?.isLead === true },
    verb: "repo.exec-config.write",
    resource: { kind: "none" },
    source,
  });
  if (decision.allow) return null;
  return `Forbidden: ${decision.reason}. Only the lead, the operator or a user can change a repo's url, clonePath or hooks.`;
}

/**
 * Applies a repo update whose merge-policy change (`allowMerge` or `mergePolicy`) the caller must be authorized for. The
 * guidelines `authorize` compares against, the decision and the write share one BEGIN IMMEDIATE
 * transaction, so a stale edit cannot overwrite a merge-policy change that committed after the
 * caller's read: the later writer waits, then decides against the committed value.
 *
 * `authorize` runs only when the update changes the merge policy. `authorizeExecConfig` runs only
 * when the update changes `url`, `clonePath` or `hooks`. Each returns a refusal to stop the
 * update, or null to allow it. They run inside the transaction: read only what they need through
 * the usual helpers (they join the transaction) and do no slow I/O.
 */
export async function updateSwarmRepoChecked<Refusal>(
  id: string,
  updates: RepoUpdates,
  authorize: (existing: SwarmRepo) => Promise<Refusal | null> | Refusal | null,
  authorizeExecConfig: (existing: SwarmRepo) => Promise<Refusal | null> | Refusal | null,
): Promise<CheckedRepoUpdate<Refusal>> {
  return await getStorage().transaction(async (): Promise<CheckedRepoUpdate<Refusal>> => {
    const touchesExecConfig =
      updates.url !== undefined || updates.clonePath !== undefined || updates.hooks !== undefined;
    if (updates.guidelines !== undefined || touchesExecConfig) {
      const existing = await getSwarmRepoById(id);
      if (existing && changesMergePolicy(existing.guidelines, updates.guidelines)) {
        const refusal = await authorize(existing);
        if (refusal !== null) return { kind: "refused", refusal };
      }
      if (existing && changesExecConfig(existing, updates)) {
        const refusal = await authorizeExecConfig(existing);
        if (refusal !== null) return { kind: "refused", refusal };
      }
    }

    const repo = await updateSwarmRepo(id, updates);
    return repo ? { kind: "updated", repo } : { kind: "not-found" };
  });
}
