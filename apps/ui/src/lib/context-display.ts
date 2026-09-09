import type { ContextSnapshot } from "@/api/types";

type UsableContextSnapshot = ContextSnapshot & {
  contextUsedTokens: number;
  contextTotalTokens: number;
  contextPercent: number;
};

function hasCompleteUsage(snapshot: ContextSnapshot): snapshot is UsableContextSnapshot {
  return (
    snapshot.contextUsedTokens !== undefined &&
    snapshot.contextTotalTokens !== undefined &&
    snapshot.contextPercent !== undefined
  );
}

/**
 * Terminal and compaction snapshots can omit usage values. A display must use
 * one usage snapshot so its percentage, used tokens, and window agree.
 */
export function findLatestUsableContextSnapshot(
  snapshots: ContextSnapshot[],
): UsableContextSnapshot | undefined {
  for (let index = snapshots.length - 1; index >= 0; index--) {
    const snapshot = snapshots[index];
    if (hasCompleteUsage(snapshot)) {
      return snapshot;
    }
  }
  return undefined;
}
