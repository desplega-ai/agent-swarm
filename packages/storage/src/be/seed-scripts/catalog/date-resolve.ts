import { z } from "zod";

export const argsSchema = z.object({
  expr: z
    .string()
    .describe("Natural date expression: yesterday, last week, Thursday, 7d ago, 2026-01-01"),
  now: z
    .string()
    .optional()
    .describe("ISO timestamp to resolve relative to (default: current time)"),
});

const DAY = 86400000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const UNIT_MS: any = {
  hour: 3600000,
  hours: 3600000,
  h: 3600000,
  day: DAY,
  days: DAY,
  d: DAY,
  week: 7 * DAY,
  weeks: 7 * DAY,
  w: 7 * DAY,
};

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function single(d: Date): any {
  return { iso: d.toISOString(), date: ymd(d) };
}

function range(start: Date, end: Date): any {
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Resolve a natural date expression to an ISO date or a {start,end} range. */
export default async function dateResolve(args: any, _ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };

  const nowMs = parsed.data.now ? Date.parse(parsed.data.now) : Date.now();
  if (Number.isNaN(nowMs)) return { error: "invalid 'now' timestamp" };
  const now = new Date(nowMs);
  const today = startOfDay(now);
  const expr = parsed.data.expr.trim().toLowerCase();

  if (expr === "now") return single(now);
  if (expr === "today") return single(today);
  if (expr === "yesterday") return single(new Date(today.getTime() - DAY));
  if (expr === "tomorrow") return single(new Date(today.getTime() + DAY));

  if (/^\d{4}-\d{2}-\d{2}/.test(expr)) {
    const ms = Date.parse(parsed.data.expr.trim());
    if (Number.isNaN(ms)) return { error: "unparseable ISO date" };
    return single(new Date(ms));
  }

  // "N <unit> ago" / "in N <unit>" / "Nd ago"
  const rel = expr.match(/^(?:in\s+)?(\d+)\s*([a-z]+)\s*(ago)?$/);
  if (rel) {
    const amount = Number.parseInt(rel[1] as string, 10);
    const unitMs = UNIT_MS[rel[2] as string];
    if (unitMs) {
      const dir = rel[3] === "ago" ? -1 : 1;
      return single(new Date(now.getTime() + dir * amount * unitMs));
    }
  }

  // Weekday name → most recent occurrence on or before today.
  const wd = WEEKDAYS.indexOf(expr);
  if (wd >= 0) {
    let back = today.getUTCDay() - wd;
    if (back < 0) back += 7;
    return single(new Date(today.getTime() - back * DAY));
  }

  // Week ranges (weeks start Monday).
  const weekMatch = expr.match(/^(last|this|next)\s+week$/);
  if (weekMatch) {
    const offset = today.getUTCDay() === 0 ? 6 : today.getUTCDay() - 1;
    const monday = new Date(today.getTime() - offset * DAY);
    const shift = weekMatch[1] === "last" ? -7 : weekMatch[1] === "next" ? 7 : 0;
    const start = new Date(monday.getTime() + shift * DAY);
    return range(start, new Date(start.getTime() + 7 * DAY));
  }

  // Month ranges.
  const monthMatch = expr.match(/^(last|this|next)\s+month$/);
  if (monthMatch) {
    const delta = monthMatch[1] === "last" ? -1 : monthMatch[1] === "next" ? 1 : 0;
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + delta, 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + delta + 1, 1));
    return range(start, end);
  }

  return { error: "could not resolve expression: " + parsed.data.expr };
}
