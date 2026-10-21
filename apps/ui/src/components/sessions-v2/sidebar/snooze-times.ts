// Later = snooze: the wake times of the Later menu and the short forms of a
// wake time for rows, menus, and toasts (SPEC R4). Local time.
//
// Pure, with no `@/` imports: `bun:test` runs it from the repo root.

export type SnoozeChoice = "hour" | "evening" | "tomorrow" | "week";

interface SnoozeOption {
  id: SnoozeChoice;
  label: string;
  /** ISO wake time. */
  at: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const monthDay = (d: Date) => d.toLocaleDateString("en", { month: "short", day: "numeric" });

/**
 * The Later menu: In 1 hour, This evening (18:00, while it is more than 30
 * minutes away), Tomorrow 09:00, and Next week (Monday 09:00).
 */
export function snoozeOptions(now: Date): SnoozeOption[] {
  const options: SnoozeOption[] = [
    { id: "hour", label: "In 1 hour", at: new Date(now.getTime() + 3_600_000).toISOString() },
  ];
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() - now.getTime() > 30 * 60_000) {
    options.push({ id: "evening", label: "This evening", at: evening.toISOString() });
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  options.push({ id: "tomorrow", label: "Tomorrow", at: tomorrow.toISOString() });
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7));
  nextWeek.setHours(9, 0, 0, 0);
  options.push({ id: "week", label: "Next week", at: nextWeek.toISOString() });
  return options;
}

/** A wake time on a row: "now", "in 40m", "18:00", "Thu 09:00", "Oct 28". */
export function formatWakeShort(at: string, now: Date): string {
  const d = new Date(at);
  const ms = d.getTime() - now.getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  if (sameDay(d, now)) return hhmm(d);
  if (ms < 6 * 86_400_000) return `${DAYS[d.getDay()]} ${hhmm(d)}`;
  return monthDay(d);
}

/** A wake time in a sentence: "in a minute", "at 18:00", "on Thu at 09:00", "on Oct 28 at 09:00". */
export function wakePhrase(at: string, now: Date): string {
  const d = new Date(at);
  const ms = d.getTime() - now.getTime();
  if (ms < 90_000) return "in a minute";
  if (sameDay(d, now)) return `at ${hhmm(d)}`;
  if (ms < 6 * 86_400_000) return `on ${DAYS[d.getDay()]} at ${hhmm(d)}`;
  return `on ${monthDay(d)} at ${hhmm(d)}`;
}

/** The time column of the Later menu: "18:00" today, else "Thu 09:00". */
export function menuTime(at: string, now: Date): string {
  const d = new Date(at);
  return sameDay(d, now) ? hhmm(d) : `${DAYS[d.getDay()]} ${hhmm(d)}`;
}

/** A `datetime-local` value in local time. */
export function localInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${hhmm(d)}`;
}
