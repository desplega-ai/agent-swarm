import { getAgentById } from "../be/db";
import { scrubSecrets } from "../utils/secret-scrubber";
import type { RoutingVia } from "./types";

/**
 * Fail-open validation for a handler-supplied hard-assign target.
 *
 * Handlers are user-authored scripts, so `assignTo` can be a typo, a stale id
 * for a deleted agent, or the Lead (which never claims pool work). Every
 * lifecycle via that acts on `decision.final.assignTo` must run it through
 * here first: an invalid target is dropped with a warning and the caller falls
 * back to its own selection, rather than stranding the task on an id no worker
 * can ever poll.
 *
 * Returns the target when usable, `undefined` otherwise.
 */
export function validateRoutingAssignTarget(
  assignTo: string | undefined,
  via: RoutingVia,
): string | undefined {
  if (!assignTo) return undefined;
  const target = getAgentById(assignTo);
  if (!target || target.isLead) {
    // `assignTo` is raw handler-script output, so a malformed script can put a
    // token-shaped value here — scrub at this logging egress.
    console.warn(
      `[routing] Ignoring handler assignTo "${scrubSecrets(assignTo)}" (${
        target ? "lead agent" : "unknown agent"
      }) on via=${via} — falling back to default assignment`,
    );
    return undefined;
  }
  return assignTo;
}
