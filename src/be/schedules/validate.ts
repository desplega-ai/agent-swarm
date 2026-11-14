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

/** The fields that pick what a schedule runs. A fire runs as the schedule's creator. */
export const SCHEDULE_TARGET_FIELDS = [
  "targetType",
  "taskTemplate",
  "workflowId",
  "scriptName",
  "scriptArgs",
  "params",
] as const;

type ScheduleTargetFields = Partial<Record<(typeof SCHEDULE_TARGET_FIELDS)[number], unknown>>;

/**
 * True when `patch` changes any target field of `existing`. A restated value is
 * not a change, so a full-form save that keeps the target passes.
 */
export function changesScheduleTarget(
  existing: ScheduleTargetFields,
  patch: ScheduleTargetFields,
): boolean {
  return SCHEDULE_TARGET_FIELDS.some(
    (field) =>
      patch[field] !== undefined && !Bun.deepEquals(patch[field] ?? null, existing[field] ?? null),
  );
}
