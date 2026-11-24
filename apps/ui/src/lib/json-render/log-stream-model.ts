/**
 * Pure logic for the catalog `LogStream`: severity buckets, the line time, and
 * the "N new" count of a live tail. No React, so it is unit-testable.
 */

export type SeverityLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "unknown";

/** OTel severity number ranges (1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17-20 error, 21-24 fatal). */
function levelFromNumber(n: number): SeverityLevel {
  if (n >= 21) return "fatal";
  if (n >= 17) return "error";
  if (n >= 13) return "warn";
  if (n >= 9) return "info";
  if (n >= 5) return "debug";
  if (n >= 1) return "trace";
  return "unknown";
}

/** A severity text (`WARN`, `warning`, `Error`) or number to its level. */
export function severityLevel(value: unknown): SeverityLevel {
  if (typeof value === "number" && Number.isFinite(value)) return levelFromNumber(value);
  if (typeof value !== "string") return "unknown";
  const text = value.trim().toLowerCase();
  if (/^\d+$/.test(text)) return levelFromNumber(Number(text));
  if (text.startsWith("fatal") || text === "critical" || text === "crit" || text === "emerg")
    return "fatal";
  if (text.startsWith("err")) return "error";
  if (text.startsWith("warn")) return "warn";
  if (text.startsWith("info") || text === "notice") return "info";
  if (text.startsWith("debug")) return "debug";
  if (text.startsWith("trace")) return "trace";
  return "unknown";
}

/** Bar colour per level (Tailwind classes, full names for the class scanner). */
export const SEVERITY_BAR_CLASS: Record<SeverityLevel, string> = {
  trace: "bg-muted-foreground/40",
  debug: "bg-muted-foreground/70",
  info: "bg-status-info-strong",
  warn: "bg-status-warning-strong",
  error: "bg-status-error-strong",
  fatal: "bg-destructive",
  unknown: "bg-border",
};

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * `HH:mm:ss.SSS` in local time, or the raw value when it does not parse.
 * Epoch numbers in seconds, ms or ns are accepted (OTel uses ns).
 */
export function lineTime(value: unknown): string {
  let date: Date | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms =
      value > 1e17 ? value / 1e6 : value > 1e14 ? value / 1e3 : value < 1e11 ? value * 1000 : value;
    date = new Date(Math.round(ms));
  } else if (typeof value === "string" && value !== "") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date || Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** One-line body: objects as JSON, newlines folded to spaces. */
export function lineBody(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s*\n\s*/g, " ");
}

/** Key/value pairs of an attributes field (an object, or a JSON string of one). */
export function attributePairs(value: unknown): [string, string][] {
  let record: unknown = value;
  if (typeof value === "string") {
    try {
      record = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  return Object.entries(record as Record<string, unknown>)
    .map(([key, entry]): [string, string] => [
      key,
      typeof entry === "string" ? entry : JSON.stringify(entry),
    ])
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Rows ahead of the previous first row: the entries a live tail added on top
 * (data is newest first). 0 when the previous first row is gone or unchanged.
 */
export function newOnTop(keys: readonly string[], previousFirst: string | undefined): number {
  if (previousFirst === undefined) return 0;
  const index = keys.indexOf(previousFirst);
  return index > 0 ? index : 0;
}

/**
 * Stable row keys: `keyField` when set and present, else time + body. A repeat
 * gets `#n` by occurrence, so a row keeps its key when a tail adds rows on top.
 */
export function rowKeys(
  rows: readonly Record<string, unknown>[],
  fields: { keyField?: string; timeField: string; bodyField: string },
): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const own = fields.keyField ? row[fields.keyField] : undefined;
    const base =
      typeof own === "string" || typeof own === "number"
        ? String(own)
        : `${String(row[fields.timeField] ?? "")}|${lineBody(row[fields.bodyField]).slice(0, 120)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  });
}
