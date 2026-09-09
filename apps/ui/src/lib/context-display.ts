import type { ContextSnapshot } from "@/api/types";

/**
 * Terminal and compaction snapshots can omit usage values. A display must use
 * one usage snapshot so its percentage, used tokens, and window agree.
 */
export function findLatestUsableContextSnapshot(
  snapshots: ContextSnapshot[],
): ContextSnapshot | undefined {
  for (let index = snapshots.length - 1; index >= 0; index--) {
    const snapshot = snapshots[index];
    if (
      snapshot.contextUsedTokens !== undefined &&
      snapshot.contextTotalTokens !== undefined &&
      snapshot.contextPercent !== undefined
    ) {
      return snapshot;
    }
  }
  return undefined;
}
