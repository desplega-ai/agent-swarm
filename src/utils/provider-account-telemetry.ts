import { z } from "zod";
import type { RateLimitWindowTelemetry } from "./error-tracker";
import { scrubSecrets } from "./secret-scrubber";

const accountFields = ["ordinaryUsageAllowed", "resetCreditsAvailable"] as const;
const limitFields = [
  "planRaw",
  "label",
  "normalModelSlug",
  "credits",
  "spend",
  "spendControlReached",
  "reachedType",
] as const;
export const windowMetadataFields = [
  "durationMins",
  "resetsAt",
  "label",
  "normalModelSlug",
] as const;
export const windowFieldObservedAtSchema = z.partialRecord(
  z.enum(windowMetadataFields),
  z.string().datetime(),
);
const slotTimesSchema = z.strictObject({
  primary: z.string().datetime().optional(),
  secondary: z.string().datetime().optional(),
});

export function codexWindowKey(limitId: string, slot: "primary" | "secondary"): string {
  return `codex:${limitId}:${slot}`;
}

const text = z.string().max(256);
export const providerLimitTelemetrySchema = z.strictObject({
  observedAt: z.string().datetime(),
  fieldObservedAt: z.partialRecord(z.enum(limitFields), z.string().datetime()).optional(),
  windowRemovedAt: slotTimesSchema.optional(),
  planRaw: text.nullable().optional(),
  label: text.nullable().optional(),
  normalModelSlug: text.nullable().optional(),
  credits: z
    .strictObject({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: text.nullable().optional(),
    })
    .nullable()
    .optional(),
  spend: z
    .strictObject({
      limit: text,
      used: text,
      remainingPercent: z.number().int().min(-2147483648).max(2147483647),
      resetsAt: z.number().int().nonnegative().max(8_640_000_000_000),
    })
    .nullable()
    .optional(),
  spendControlReached: z.boolean().nullable().optional(),
  reachedType: text.nullable().optional(),
});

export const providerAccountTelemetrySchema = z.strictObject({
  source: z.enum(["codex", "claude"]),
  observedAt: z.string().datetime(),
  fieldObservedAt: z.partialRecord(z.enum(accountFields), z.string().datetime()).optional(),
  ordinaryUsageAllowed: z.boolean().nullable().optional(),
  resetCreditsAvailable: z.number().int().nonnegative().nullable().optional(),
  limits: z.record(z.string().min(1).max(128), providerLimitTelemetrySchema).optional(),
});
export type ProviderAccountTelemetry = z.infer<typeof providerAccountTelemetrySchema>;

// Slot timestamps persist removal watermarks, including snapshots with no windows.
export const rateLimitReplacementSchema = z.strictObject({
  source: z.literal("codex"),
  limitId: z.string().min(1).max(128),
  observedAt: z.string().datetime(),
  slots: z
    .array(z.enum(["primary", "secondary"]))
    .min(1)
    .max(2),
});
export type RateLimitReplacement = z.infer<typeof rateLimitReplacementSchema>;

/** Missing fields retain their value and observation time. Aggregate times are not fact ages. */
function mergeFacts<
  T extends { observedAt: string; fieldObservedAt?: Partial<Record<K, string>> },
  K extends keyof T & string,
>(stored: T | undefined, reported: T, fields: readonly K[], preferStoredOnTie: boolean): T {
  const merged = {
    ...reported,
    ...stored,
    observedAt:
      stored && Date.parse(stored.observedAt) > Date.parse(reported.observedAt)
        ? stored.observedAt
        : reported.observedAt,
  } as T;
  const times: Partial<Record<K, string>> = {};
  for (const field of fields) {
    const oldAt = stored?.fieldObservedAt?.[field] ?? stored?.observedAt;
    if (stored?.[field] !== undefined && oldAt) times[field] = oldAt;
    if (reported[field] === undefined) continue;
    const at = reported.fieldObservedAt?.[field] ?? reported.observedAt;
    if (
      times[field] &&
      (Date.parse(times[field]) > Date.parse(at) || (preferStoredOnTie && times[field] === at))
    )
      continue;
    merged[field] = reported[field];
    times[field] = at;
  }
  merged.fieldObservedAt = times;
  return merged;
}

export function mergeProviderAccountTelemetry(
  stored: ProviderAccountTelemetry | null,
  reported?: ProviderAccountTelemetry,
  preferStoredOnTie = false,
): ProviderAccountTelemetry | null {
  if (!reported) return stored;
  if (stored?.source !== reported.source) stored = null;
  const root = mergeFacts(stored ?? undefined, reported, accountFields, preferStoredOnTie);
  const limits = { ...stored?.limits };
  for (const [id, limit] of Object.entries(reported.limits ?? {})) {
    const merged = mergeFacts(limits[id], limit, limitFields, preferStoredOnTie);
    const removals = { ...limits[id]?.windowRemovedAt };
    for (const slot of ["primary", "secondary"] as const) {
      const at = limit.windowRemovedAt?.[slot];
      if (at && Date.parse(at) >= Date.parse(removals[slot] ?? "1970-01-01")) removals[slot] = at;
    }
    if (Object.keys(removals).length) merged.windowRemovedAt = removals;
    limits[id] = merged;
  }
  return { ...root, ...(Object.keys(limits).length ? { limits } : {}) };
}

export interface ProviderQuotaReport {
  windows: RateLimitWindowTelemetry;
  account?: ProviderAccountTelemetry | null;
  replace?: RateLimitReplacement[];
}

/** Apply reports without I/O. A slot removal blocks older facts only for that slot. */
export function applyProviderQuotaReport(
  stored: ProviderQuotaReport,
  reported: ProviderQuotaReport,
  preferStoredOnTie = false,
): { windows: RateLimitWindowTelemetry; account: ProviderAccountTelemetry | null } {
  let account = mergeProviderAccountTelemetry(
    stored.account ?? null,
    reported.account ?? undefined,
    preferStoredOnTie,
  );
  const windows = { ...stored.windows };
  for (const replacement of reported.replace ?? []) {
    for (const slot of replacement.slots) {
      const key = codexWindowKey(replacement.limitId, slot);
      // An included window is an update, not an explicit null slot.
      if (Object.hasOwn(reported.windows, key)) continue;
      const current = windows[key];
      if (
        current &&
        (Date.parse(current.lastSeenAt) > Date.parse(replacement.observedAt) ||
          (preferStoredOnTie && current.lastSeenAt === replacement.observedAt))
      ) {
        // A delayed removal cannot delete a recovery, but older metadata belongs
        // to the removed window. Keep its tombstone for subsequent delayed reads.
        const retained = { ...current, fieldObservedAt: { ...current.fieldObservedAt } };
        for (const field of windowMetadataFields) {
          if (
            Date.parse(current.fieldObservedAt?.[field] ?? current.lastSeenAt) <
            Date.parse(replacement.observedAt)
          ) {
            delete retained[field];
            delete retained.fieldObservedAt[field];
          }
        }
        windows[key] = retained;
      } else delete windows[key];
      account = mergeProviderAccountTelemetry(account, {
        source: "codex",
        observedAt: replacement.observedAt,
        limits: {
          [replacement.limitId]: {
            observedAt: replacement.observedAt,
            windowRemovedAt: { [slot]: replacement.observedAt },
          },
        },
      });
    }
  }
  for (const [key, entry] of Object.entries(reported.windows)) {
    const current = windows[key];
    if (entry.source !== "codex" || !entry.limitId) {
      if (!current || !(Date.parse(current.lastSeenAt) > Date.parse(entry.lastSeenAt)))
        windows[key] = entry;
      continue;
    }
    const slot = key === codexWindowKey(entry.limitId, "primary") ? "primary" : "secondary";
    const removedAt =
      account?.source === "codex"
        ? account.limits?.[entry.limitId]?.windowRemovedAt?.[slot]
        : undefined;
    if (
      removedAt &&
      (Date.parse(removedAt) > Date.parse(entry.lastSeenAt) ||
        (preferStoredOnTie && removedAt === entry.lastSeenAt))
    )
      continue;
    const newer =
      !current ||
      Date.parse(entry.lastSeenAt) > Date.parse(current.lastSeenAt) ||
      (!preferStoredOnTie && entry.lastSeenAt === current.lastSeenAt);
    const merged = { ...(newer ? { ...current, ...entry } : current!) };
    const times = { ...current?.fieldObservedAt };
    for (const field of windowMetadataFields) {
      if (current?.[field] !== undefined) times[field] ??= current.lastSeenAt;
      if (entry[field] === undefined) continue;
      const at = entry.fieldObservedAt?.[field] ?? entry.lastSeenAt;
      const oldAt = times[field];
      if (
        (removedAt && Date.parse(at) < Date.parse(removedAt)) ||
        (oldAt && (Date.parse(oldAt) > Date.parse(at) || (preferStoredOnTie && oldAt === at)))
      ) {
        if (current?.[field] === undefined) delete merged[field];
        else Object.assign(merged, { [field]: current[field] });
        continue;
      }
      Object.assign(merged, { [field]: entry[field] });
      times[field] = at;
    }
    merged.fieldObservedAt = times;
    windows[key] = merged;
  }
  return { windows, account };
}

/** Scrub individual strings before JSON serialization. Keep typed fields and identity links intact. */
export function scrubProviderQuotaReport(report: ProviderQuotaReport): ProviderQuotaReport {
  const id = (value: string): string => {
    const scrubbed = scrubSecrets(value);
    return scrubbed === value
      ? value
      : `redacted-${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
  };
  const text = (value: string) => scrubSecrets(value).slice(0, 256);
  const windows: RateLimitWindowTelemetry = {};
  for (const [key, window] of Object.entries(report.windows)) {
    const clean = { ...window };
    for (const field of [
      "status",
      "label",
      "normalModelSlug",
      "overageStatus",
      "overageDisabledReason",
    ] as const) {
      if (clean[field] !== undefined) clean[field] = text(clean[field]);
    }
    if (clean.limitId) clean.limitId = id(clean.limitId);
    windows[
      window.source === "codex" && window.limitId
        ? codexWindowKey(
            clean.limitId!,
            key === codexWindowKey(window.limitId, "primary") ? "primary" : "secondary",
          )
        : id(key)
    ] = clean;
  }
  const account = report.account
    ? { ...report.account, limits: { ...report.account.limits } }
    : report.account;
  if (account) {
    account.limits = {};
    for (const [key, limit] of Object.entries(report.account?.limits ?? {})) {
      const clean = { ...limit };
      for (const field of ["planRaw", "label", "normalModelSlug", "reachedType"] as const) {
        if (typeof clean[field] === "string") clean[field] = text(clean[field]);
      }
      if (clean.credits)
        clean.credits = {
          ...clean.credits,
          ...(typeof clean.credits.balance === "string"
            ? { balance: text(clean.credits.balance) }
            : {}),
        };
      if (clean.spend)
        clean.spend = {
          ...clean.spend,
          limit: text(clean.spend.limit),
          used: text(clean.spend.used),
        };
      account.limits[id(key)] = clean;
    }
  }
  return {
    windows,
    account,
    replace: report.replace?.map((r) => ({ ...r, limitId: id(r.limitId) })),
  };
}
