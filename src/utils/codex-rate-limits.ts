import type { RateLimitWindowTelemetry } from "./error-tracker";
import {
  applyProviderQuotaReport,
  codexWindowKey,
  type ProviderAccountTelemetry,
  providerLimitTelemetrySchema,
  type RateLimitReplacement,
} from "./provider-account-telemetry";

export interface CodexQuotaTelemetry {
  windows: RateLimitWindowTelemetry;
  account: ProviderAccountTelemetry;
  replace: RateLimitReplacement[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Normalize one Codex 0.167.0 bucket. Rolling metadata nulls mean unavailable. */
export function normalizeCodexRateLimits(
  value: unknown,
  observedAt: string,
  sparse = false,
  fallbackLimitId = "codex",
): CodexQuotaTelemetry | undefined {
  const raw = record(value);
  if (!raw || !Number.isFinite(Date.parse(observedAt))) return;
  const limitId = typeof raw.limitId === "string" ? raw.limitId : fallbackLimitId;
  if (!limitId || limitId.length > 128) return;
  const limit: Record<string, unknown> = { observedAt };
  for (const [field, input] of Object.entries({
    planRaw: raw.planType,
    label: raw.limitName,
    normalModelSlug: raw.normalModelSlug,
    credits:
      raw.credits === null
        ? null
        : record(raw.credits) && {
            hasCredits: record(raw.credits)!.hasCredits,
            unlimited: record(raw.credits)!.unlimited,
            balance: record(raw.credits)!.balance,
          },
    spend:
      raw.individualLimit === null
        ? null
        : record(raw.individualLimit) && {
            limit: record(raw.individualLimit)!.limit,
            used: record(raw.individualLimit)!.used,
            remainingPercent: record(raw.individualLimit)!.remainingPercent,
            resetsAt: record(raw.individualLimit)!.resetsAt,
          },
    reachedType: raw.rateLimitReachedType,
    spendControlReached: raw.spendControlReached,
  })) {
    if (input === undefined || (sparse && input === null && field !== "spendControlReached"))
      continue;
    const parsed = providerLimitTelemetrySchema.safeParse({ observedAt, [field]: input });
    if (parsed.success) Object.assign(limit, parsed.data);
  }
  const account: ProviderAccountTelemetry = {
    source: "codex",
    observedAt,
    limits: { [limitId]: providerLimitTelemetrySchema.parse(limit) },
  };
  const windows: RateLimitWindowTelemetry = {};
  const slots: RateLimitReplacement["slots"] = [];
  for (const slot of ["primary", "secondary"] as const) {
    if (raw[slot] === null) {
      slots.push(slot);
      continue;
    }
    const window = record(raw[slot]);
    if (
      !window ||
      typeof window.usedPercent !== "number" ||
      !Number.isFinite(window.usedPercent) ||
      !Number.isInteger(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 2147483647
    )
      continue;
    slots.push(slot);
    const duration = window.windowDurationMins;
    const reset = window.resetsAt;
    windows[codexWindowKey(limitId, slot)] = {
      status: window.usedPercent >= 100 ? "rejected" : "allowed",
      utilization: window.usedPercent / 100,
      lastSeenAt: observedAt,
      source: "codex",
      limitId,
      ...(typeof raw.limitName === "string" && raw.limitName.length <= 256
        ? { label: raw.limitName }
        : {}),
      ...(typeof raw.normalModelSlug === "string" && raw.normalModelSlug.length <= 256
        ? { normalModelSlug: raw.normalModelSlug }
        : {}),
      ...(typeof duration === "number" &&
      Number.isInteger(duration) &&
      duration > 0 &&
      duration <= 576000
        ? { durationMins: duration }
        : {}),
      ...(typeof reset === "number" &&
      Number.isSafeInteger(reset) &&
      reset > 0 &&
      reset <= 8_640_000_000_000
        ? { resetsAt: reset }
        : {}),
    };
  }
  return {
    windows,
    account,
    replace: slots.length ? [{ source: "codex", limitId, observedAt, slots }] : [],
  };
}

/** Normalize the read envelope. An empty or unusable map falls back to the legacy snapshot. */
export function normalizeCodexRateLimitsResponse(
  value: unknown,
  observedAt: string,
): CodexQuotaTelemetry | undefined {
  const raw = record(value);
  if (!raw || !Number.isFinite(Date.parse(observedAt))) return;
  let buckets = Object.entries(record(raw.rateLimitsByLimitId) ?? {}).flatMap(([id, bucket]) => {
    const normalized = normalizeCodexRateLimits(bucket, observedAt, false, id);
    return normalized ? [normalized] : [];
  });
  if (!buckets.length) {
    const legacy = normalizeCodexRateLimits(raw.rateLimits, observedAt);
    if (legacy) buckets = [legacy];
  }
  const account: ProviderAccountTelemetry = { source: "codex", observedAt };
  if (typeof raw.ordinaryUsageAllowed === "boolean" || raw.ordinaryUsageAllowed === null)
    account.ordinaryUsageAllowed = raw.ordinaryUsageAllowed;
  const credits = record(raw.rateLimitResetCredits);
  if (raw.rateLimitResetCredits === null) account.resetCreditsAvailable = null;
  else if (
    typeof credits?.availableCount === "number" &&
    Number.isSafeInteger(credits.availableCount) &&
    credits.availableCount >= 0
  )
    account.resetCreditsAvailable = credits.availableCount;
  if (
    !buckets.length &&
    account.ordinaryUsageAllowed === undefined &&
    account.resetCreditsAvailable === undefined
  )
    return;
  let merged = { windows: {} as RateLimitWindowTelemetry, account };
  for (const bucket of buckets) {
    const next = applyProviderQuotaReport(merged, bucket);
    merged = { ...next, account: next.account! };
  }
  return { ...merged, replace: buckets.flatMap((bucket) => bucket.replace) };
}
