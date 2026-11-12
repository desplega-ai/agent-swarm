import { agentsMayMerge, type RepoGuidelines } from "@/types";

type MergePolicyFields = Pick<RepoGuidelines, "allowMerge" | "mergePolicy">;

/** Stable JSON: object keys sorted, so a reordered resend of the same record compares equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/**
 * True when writing `incoming` would change a repo's merge policy: its effective
 * `agentsMayMerge` (the record's flag, else `allowMerge`) or any part of its `mergePolicy`
 * record. An omitted `guidelines` leaves it alone and `null` clears it. A resend that drops
 * a stored `mergePolicy` counts as a change. Only the lead, the operator or a user may make
 * such a change: the policy is rendered into every agent's prompt and read by the merge scripts.
 */
export function changesMergePolicy(
  current: MergePolicyFields | null | undefined,
  incoming: MergePolicyFields | null | undefined,
): boolean {
  if (incoming === undefined) return false;
  return (
    agentsMayMerge(current) !== agentsMayMerge(incoming) ||
    canonical(current?.mergePolicy) !== canonical(incoming?.mergePolicy)
  );
}
