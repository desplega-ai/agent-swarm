export const DURATION_UNITS = ["ms", "s", "min", "h", "days"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

const milliseconds: Record<DurationUnit, number> = {
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  days: 86_400_000,
};

/** Empty is unset, never zero. Invalid existing values remain visible for repair. */
export function convertDuration(
  value: string | undefined,
  from: DurationUnit,
  to: DurationUnit,
): string {
  if (value === undefined || value.trim() === "") return "";
  if (from === to || !Number.isFinite(Number(value))) return value;
  const converted = Number(value) * (milliseconds[from] / milliseconds[to]);
  // Avoid exposing binary floating-point artifacts (e.g. 0.1 minutes in ms).
  return String(Number(converted.toPrecision(15)));
}

export function preferredDurationUnit(
  value: string | undefined,
  native: DurationUnit,
): DurationUnit {
  const amount = Number(value) * milliseconds[native];
  if (!Number.isFinite(amount) || amount <= 0) return native;
  return [...DURATION_UNITS].reverse().find((unit) => amount % milliseconds[unit] === 0) ?? native;
}

export function formatDuration(value: string, native: DurationUnit): string {
  if (!Number.isFinite(Number(value))) return value;
  const unit = preferredDurationUnit(value, native);
  return `${convertDuration(value, native, unit)} ${unit}`;
}

export function parseConfigList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
