import cronstrue from "cronstrue";
import type { ScheduledTask } from "../api/types";
import { formatUTCTime } from "./utils";

// Translate a cron expression to plain English. Falls back to the raw
// expression on parse error. Used by the schedules list and detail pages so
// they stay in lockstep on the human-readable description shown alongside
// `<code>{cron}</code>`.

export function describeCron(expr: string): string {
  try {
    return cronstrue.toString(expr, { use24HourTimeFormat: true });
  } catch {
    return expr;
  }
}

// The zone a cron schedule runs in, as the list, detail and mobile rows show
// it. A cron time means nothing without it, and stored rows may omit it.

export function cronTimezone(timezone: string | null | undefined): string {
  return timezone || "UTC";
}

// Format an interval expressed in milliseconds as a compact "Xs", "Xm", "Xh"
// or "Xd" label, matching the schedules list / detail "Every {interval}"
// renderer.

export function formatInterval(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours}h`;
  return `${hours / 24}d`;
}

/**
 * One-line cadence for a schedule: the same words and zone the list's
 * Schedule column shows, for the mobile rows and list search.
 */
export function scheduleCadence(data: ScheduledTask): string {
  if (data.scheduleType === "one_time") {
    return data.nextRunAt
      ? `at ${formatUTCTime(data.nextRunAt)}`
      : data.lastRunAt
        ? `ran ${formatUTCTime(data.lastRunAt)}`
        : "One-time";
  }
  if (data.cronExpression) {
    return `${describeCron(data.cronExpression)} (${cronTimezone(data.timezone)})`;
  }
  if (data.intervalMs) return `every ${formatInterval(data.intervalMs)}`;
  return "No cadence";
}
