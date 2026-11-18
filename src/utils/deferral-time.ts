// Pure time formatting for deferral cards, shared by `defer-task` and the
// channel renderers. Kept apart from the tool so Slack rendering does not load
// the tool's module graph.

/** Date/time parts of `date` as rendered in IANA zone `tz`. */
function partsInTz(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  // Some locales render midnight as "24" under hour12: false.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: hour!,
    minute: parts.minute!,
    second: parts.second!,
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
): { date: string; time: string } {
  let zone = tz;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const t = partsInTz(target, zone);
  // Minute precision: this string is read by a human deciding whether to wait,
  // and the wake-up is scheduler-polled anyway, so seconds were false precision.
  const time = `${t.hour}:${t.minute}`;
  const n = partsInTz(now, zone);
  if (t.year === n.year && t.month === n.month && t.day === n.day) return { date: "today", time };
  const tm = partsInTz(new Date(now.getTime() + 86_400_000), zone);
  if (t.year === tm.year && t.month === tm.month && t.day === tm.day) {
    return { date: "tomorrow", time };
  }
  return { date: `${t.month}-${t.day}`, time };
}
