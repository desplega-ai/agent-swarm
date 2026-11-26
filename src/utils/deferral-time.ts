// Pure time formatting for deferral cards, shared by `defer-task` and the
// channel renderers. Kept apart from the tool so Slack rendering does not load
// the tool's module graph.

export function isValidTimezone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Date/time parts of `date` as rendered in IANA zone `tz`. */
function partsInTz(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  // Map each local date to UTC midnight so consecutive dates stay one day apart across DST.
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return {
    dayNumber: calendarDate.getTime() / 86_400_000,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    abbreviation: parts.timeZoneName!,
  };
}

/**
 * "today"/"tomorrow" or "MM-dd" plus "HH:MM", both computed in `tz`.
 * Falls back to UTC (parts still computed correctly) if `tz` is not a valid
 * IANA zone — the caller decides whether to label the fallback.
 */
export function formatDeferralDateTime(
  target: Date,
  now: Date,
  tz: string,
  labelZone = false,
): { date: string; time: string } {
  const zone = isValidTimezone(tz) ? tz : "UTC";
  const t = partsInTz(target, zone);
  // Minute precision: this string is read by a human deciding whether to wait,
  // and the wake-up is scheduler-polled anyway, so seconds were false precision.
  const time = `${t.hour}:${t.minute}${labelZone ? ` ${t.abbreviation}` : ""}`;
  const daysAhead = t.dayNumber - partsInTz(now, zone).dayNumber;
  if (daysAhead === 0) return { date: "today", time };
  if (daysAhead === 1) return { date: "tomorrow", time };
  return { date: `${t.month}-${t.day}`, time };
}
