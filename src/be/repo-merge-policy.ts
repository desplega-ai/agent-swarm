import type { RepoGuidelines } from "@/types";

/**
 * True when writing `incoming` would change a repo's effective `allowMerge`. An omitted
 * `guidelines` leaves it alone, `null` clears it (so it reads false), and a missing flag
 * reads false. Only the lead, the operator or a user may make such a change: the flag is
 * rendered into every agent's prompt as the merge policy.
 */
export function changesAllowMerge(
  current: Pick<RepoGuidelines, "allowMerge"> | null | undefined,
  incoming: Pick<RepoGuidelines, "allowMerge"> | null | undefined,
): boolean {
  if (incoming === undefined) return false;
  return (incoming?.allowMerge === true) !== (current?.allowMerge === true);
}
