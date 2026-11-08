// The use-case Overview tab (step-10): which groups get one, and the pure
// rules its widgets share (next run, schedule search, outputs order).
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { ScheduledTask } from "../api/types";
import type { LsEntry } from "./agent-fs/types";
import { describeCron, formatInterval } from "./schedule-format";
import {
  groupKeyOf,
  resourceOfGroupKey,
  SESSION_RESOURCE_KINDS,
  sourceOfGroupKey,
} from "./session-groups";
import { type GroupPane, parseView, SESSION_SECTIONS } from "./sessions-v2";

/** The Schedules widget shows its search field from this many schedules up. */
export const SCHEDULE_SEARCH_FROM = 8;

const resourcePrefix = new RegExp(
  `^(?:shared/|personal/[^/]+/)(?:${SESSION_RESOURCE_KINDS.join("|")}):`,
);

/**
 * Whether a `?view=` can have an Overview: a user group (the server's
 * `showsScheduleRuns`). Sections, namespace roots, source groups (Slack,
 * Telegram, Discord) and resource groups (`shared/schedule:<id>/`) never do.
 */
export function canHaveOverview(view: string | null): view is string {
  const key = parseView(view);
  if (!key || (SESSION_SECTIONS as readonly string[]).includes(key)) return false;
  if (key === "shared/" || /^personal\/[^/]+\/$/.test(key)) return false;
  if (sourceOfGroupKey(key) || resourceOfGroupKey(key) || resourcePrefix.test(key)) return false;
  return groupKeyOf(key) === key;
}

/** The schedules whose runs file into `groupKey`: the key itself, or a leaf right under it. */
export function schedulesInGroup<T extends Pick<ScheduledTask, "key">>(
  schedules: readonly T[] | undefined,
  groupKey: string,
): T[] {
  return (schedules ?? []).filter((schedule) => groupKeyOf(schedule.key) === groupKey);
}

/** The files of a folder listing, newest first. Folders and undated files go last. */
export function outputFiles(entries: readonly LsEntry[] | undefined): LsEntry[] {
  const time = (entry: LsEntry) => (entry.modifiedAt ? Date.parse(entry.modifiedAt) : 0);
  return (entries ?? [])
    .filter((entry) => entry.type === "file")
    .sort((a, b) => time(b) - time(a) || a.name.localeCompare(b.name));
}

/**
 * Whether a group qualifies for an Overview: at least one schedule or one
 * file under its key. `pending` while a source that could still say yes
 * loads. A source that failed or is off counts as empty.
 */
export function overviewQualifies(input: {
  schedules: number | undefined;
  files: number | undefined;
}): boolean | "pending" {
  const { schedules, files } = input;
  if ((schedules ?? 0) > 0 || (files ?? 0) > 0) return true;
  if (schedules === undefined || files === undefined) return "pending";
  return false;
}

/**
 * The face the group tab shows. `?tab=list` is the list. Else a group that
 * qualifies opens on its Overview, one that does not on its list, and an
 * unknown one waits (`pending`), so the list never flashes before the
 * Overview.
 */
export function resolveGroupPane(
  param: GroupPane | null,
  qualifies: boolean | "pending",
): GroupPane | "pending" {
  if (param === "list" || qualifies === false) return "list";
  return qualifies === "pending" ? "pending" : "overview";
}

/**
 * The schedule the next-run bar shows: the enabled one that runs first.
 * With no enabled schedule (or none with a next run), the first one.
 */
export function nextRunSchedule<T extends Pick<ScheduledTask, "enabled" | "nextRunAt">>(
  schedules: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const schedule of schedules) {
    if (!schedule.enabled || !schedule.nextRunAt) continue;
    if (!best?.nextRunAt || Date.parse(schedule.nextRunAt) < Date.parse(best.nextRunAt)) {
      best = schedule;
    }
  }
  return best ?? schedules[0];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A cron expression in a few words for the common shapes: "Daily 07:30",
 * "Mon, Thu 09:00", "Hourly at :15". Null for anything else.
 */
export function compactCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*" || !/^\d{1,2}$/.test(minute)) return null;
  const mm = minute.padStart(2, "0");
  if (hour === "*" && dow === "*") return `Hourly at :${mm}`;
  if (!/^\d{1,2}$/.test(hour)) return null;
  const time = `${hour.padStart(2, "0")}:${mm}`;
  if (dow === "*") return `Daily ${time}`;
  if (dow === "1-5") return `Weekdays ${time}`;
  if (!/^[0-7](,[0-7])*$/.test(dow)) return null;
  const days = [...new Set(dow.split(",").map((d) => Number(d) % 7))].sort((a, b) => a - b);
  // Monday first, as people read a week.
  days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return `${days.map((d) => DAY_NAMES[d]).join(", ")} ${time}`;
}

/**
 * A schedule's cadence in a few words: "Mon, Thu 09:00", "Every 1h". A cron
 * time reads in the schedule's zone, so a zone other than the browser's
 * shows after it.
 */
export function cadenceWords(
  schedule: Pick<ScheduledTask, "cronExpression" | "intervalMs" | "scheduleType" | "timezone">,
  browserZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  if (schedule.scheduleType === "one_time") return "Once";
  if (schedule.cronExpression) {
    const words = compactCron(schedule.cronExpression) ?? describeCron(schedule.cronExpression);
    const zone = schedule.timezone || "UTC";
    return zone === browserZone ? words : `${words} ${zone}`;
  }
  if (schedule.intervalMs) return `Every ${formatInterval(schedule.intervalMs)}`;
  return "No cadence";
}

/**
 * The Schedules widget order: enabled schedules by their next run, the
 * soonest first, then the paused ones by name.
 */
export function sortSchedules<T extends Pick<ScheduledTask, "enabled" | "nextRunAt" | "name">>(
  schedules: readonly T[],
): T[] {
  const due = (s: T) =>
    s.enabled && s.nextRunAt ? Date.parse(s.nextRunAt) : Number.POSITIVE_INFINITY;
  return [...schedules].sort(
    (a, b) =>
      Number(!a.enabled) - Number(!b.enabled) || due(a) - due(b) || a.name.localeCompare(b.name),
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * When a run is due, in local time: "Today 15:00", "Tomorrow 09:00",
 * "Thu 09:00" within a week, else "Nov 12 09:00". `in` is the wait:
 * "in 18h 14m", "in 3d 2h", "now".
 */
export function formatNextRun(iso: string, now: number): { when: string; in: string } {
  const at = new Date(iso);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  const when =
    days === 0
      ? `Today ${time}`
      : days === 1
        ? `Tomorrow ${time}`
        : days > 1 && days < 7
          ? `${at.toLocaleDateString("en", { weekday: "short" })} ${time}`
          : `${at.toLocaleDateString("en", { month: "short", day: "numeric" })} ${time}`;
  const minutes = Math.floor((at.getTime() - now) / 60_000);
  if (minutes < 1) return { when, in: "now" };
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const wait = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return { when, in: `in ${wait}` };
}

/** Whether a schedule matches the Schedules search: its name, its agent, or its cadence. */
export function matchesScheduleSearch(
  schedule: Pick<
    ScheduledTask,
    "name" | "cronExpression" | "intervalMs" | "scheduleType" | "timezone"
  >,
  agentName: string | undefined,
  query: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = [schedule.name, agentName ?? "", cadenceWords(schedule)].join(" ").toLowerCase();
  return terms.every((term) => text.includes(term));
}

/** The drive path of a group key: the key string under the drive root. */
export function groupDrivePath(groupKey: string): string {
  return `/${groupKey}`;
}
