export type MergedScheduleTiming = { mergedCron: string | null; mergedInterval: number | null };
export type ScheduleTimingPatch = { cronExpression?: string | null; intervalMs?: number | null };

export function mergeScheduleTiming(
  existing: { cronExpression: string | null; intervalMs: number | null },
  patch: ScheduleTimingPatch,
): MergedScheduleTiming {
  return {
    mergedCron: patch.cronExpression !== undefined ? patch.cronExpression : existing.cronExpression,
    mergedInterval: patch.intervalMs !== undefined ? patch.intervalMs : existing.intervalMs,
  };
}

export type RecurringTimingError = { kind: "both-null" } | null;

export function validateRecurringTiming(merged: MergedScheduleTiming): RecurringTimingError {
  if (merged.mergedCron === null && merged.mergedInterval === null) {
    return { kind: "both-null" };
  }
  return null;
}
