// Current provider quota windows and account facts for one credential. The
// Providers page reads windows through `currentQuotaWindows`.

import {
  FABLE_WINDOW,
  OPUS_WINDOW,
  SONNET_WINDOW,
} from "../../../../src/utils/model-rate-limit-windows";
import type {
  ApiKeyStatus,
  ProviderLimitTelemetry,
  RateLimitWindow,
  SubscriptionPlan,
} from "../api/types";

const MINUTE_MS = 60_000;

/** Claude's own window keys. Their lengths come from the CLI, not from the labels. */
const CLAUDE_WINDOWS: Record<string, { durationMins: number | null; scope?: string }> = {
  five_hour: { durationMins: 300 },
  seven_day: { durationMins: 10080 },
  [OPUS_WINDOW]: { durationMins: 10080, scope: "Opus" },
  [SONNET_WINDOW]: { durationMins: 10080, scope: "Sonnet" },
  [FABLE_WINDOW]: { durationMins: 10080, scope: "Fable" },
  // Account-wide credits have a separate label from included quota.
  overage: { durationMins: null, scope: "Usage credits" },
};

/** The default Codex limit covers the whole account. */
const CODEX_ACCOUNT_LIMIT = "codex";

export type PlanSource = "manual" | "detected" | "estimated";

export const PLAN_SOURCES: Record<PlanSource, { label: string; hint: string }> = {
  detected: { label: "Detected", hint: "Read from the credential." },
  manual: { label: "Set by you", hint: "Picked by an operator." },
  estimated: {
    label: "Unverified estimate",
    hint: "This older estimate is unverified. Select your plan to confirm it.",
  },
};

export function quotaIsHigh(percent: number | null): boolean {
  return percent !== null && percent >= 75;
}

export function quotaRemaining(percent: number): number {
  return Math.min(100, Math.max(0, 100 - percent));
}

export function quotaLabel(window: QuotaWindow): string {
  return window.durationMins === 10080
    ? ["Weekly", window.scope].filter(Boolean).join(" · ")
    : window.name;
}

/** A short countdown, rounded up so an active window never reads zero minutes. */
export function quotaResetIn(resetsAtMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((resetsAtMs - nowMs) / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

export interface QuotaWindow {
  /** The `rateLimitWindows` key, for example `seven_day` or `codex:codex:primary`. */
  key: string;
  /** The status row the observation came from. Usage joins on it. */
  statusId: string;
  /** "5 h", "7 d", "Fable 7 d", or a provider label. */
  name: string;
  /** A model or limit name, null for an account-wide window. */
  scope: string | null;
  /** Null when the provider did not report the window length. */
  durationMins: number | null;
  /** Whole percent as reported. It can exceed 100. Null when not reported. */
  percent: number | null;
  /** The provider rejected requests in this window. */
  limited: boolean;
  /** Null when the provider did not report a reset. */
  resetsAtMs: number | null;
  /** When the utilization arrived. */
  observedAt: string;
  /** When the reset time arrived, when older than `observedAt`. */
  resetObservedAt: string | null;
  /** Claude reports usage credits separately from included quota. */
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

/** 300 as "5 h", 10080 as "7 d", 43200 as "30 d". */
export function formatPeriod(durationMins: number): string {
  if (durationMins < 60) return `${durationMins} min`;
  if (durationMins % 1440 === 0) return `${durationMins / 1440} d`;
  const hours = durationMins / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

function windowSource(status: ApiKeyStatus, window: RateLimitWindow): "claude" | "codex" | null {
  if (window.source) return window.source;
  if (status.provider === "claude") return "claude";
  return status.provider === "codex" ? "codex" : null;
}

function codexSlot(key: string): { limitId: string; slot: "primary" | "secondary" } | null {
  const match = /^codex:(.+):(primary|secondary)$/.exec(key);
  return match ? { limitId: match[1]!, slot: match[2] as "primary" | "secondary" } : null;
}

function timeOf(iso: string | undefined | null): number {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function describe(
  key: string,
  status: ApiKeyStatus,
  window: RateLimitWindow,
): { scope: string | null; durationMins: number | null } {
  const source = windowSource(status, window);
  if (source === "claude") {
    const known = CLAUDE_WINDOWS[key];
    return {
      scope: known?.scope ?? (known ? null : (window.label ?? key)),
      durationMins: window.durationMins ?? known?.durationMins ?? null,
    };
  }
  const limitId = window.limitId ?? codexSlot(key)?.limitId ?? null;
  const scope =
    limitId === CODEX_ACCOUNT_LIMIT
      ? null
      : (window.label ?? window.normalModelSlug ?? limitId ?? key);
  return { scope, durationMins: window.durationMins ?? null };
}

/** The newest explicit removal of each Codex slot, across every scope row of the credential. */
function removals(statuses: ApiKeyStatus[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const status of statuses) {
    const account = status.providerAccount;
    if (account?.source !== "codex") continue;
    for (const [limitId, limit] of Object.entries(account.limits ?? {})) {
      for (const slot of ["primary", "secondary"] as const) {
        const at = timeOf(limit.windowRemovedAt?.[slot]);
        const key = `codex:${limitId}:${slot}`;
        if (Number.isFinite(at) && at > (out.get(key) ?? Number.NEGATIVE_INFINITY)) {
          out.set(key, at);
        }
      }
    }
  }
  return out;
}

/**
 * The windows that apply now for one credential, read from all of its status
 * rows (global and per agent). A window is gone once its reset passes. Without
 * a reset, a window of known length is gone once a full length has passed
 * since it was seen. A newer explicit Codex slot removal hides older reports.
 * Select the newest observation across scopes before checking expiry.
 * An expired latest report must not reveal an older report with a later reset.
 */
export function currentQuotaWindows(statuses: ApiKeyStatus[], nowMs: number): QuotaWindow[] {
  const removed = removals(statuses);
  const best = new Map<string, { window: QuotaWindow; seenMs: number; global: boolean }>();
  for (const status of statuses) {
    for (const [key, window] of Object.entries(status.rateLimitWindows ?? {})) {
      const seenMs = timeOf(window.lastSeenAt);
      if (!Number.isFinite(seenMs)) continue;
      const removedAt = removed.get(key);
      if (removedAt !== undefined && removedAt > seenMs) continue;
      const { scope, durationMins } = describe(key, status, window);
      const resetsAtMs =
        typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
          ? window.resetsAt * 1000
          : null;
      const period = durationMins === null ? null : formatPeriod(durationMins);
      const resetAt = window.fieldObservedAt?.resetsAt ?? null;
      const candidate: QuotaWindow = {
        key,
        statusId: status.id,
        name:
          [scope, period].filter(Boolean).join(" ") ||
          (codexSlot(key)?.slot === "secondary" ? "Secondary limit" : "Primary limit"),
        scope,
        durationMins,
        percent:
          typeof window.utilization === "number" && Number.isFinite(window.utilization)
            ? Math.round(window.utilization * 100)
            : null,
        limited: window.status === "rejected",
        resetsAtMs,
        observedAt: window.lastSeenAt,
        resetObservedAt:
          resetsAtMs !== null && resetAt && timeOf(resetAt) < seenMs - MINUTE_MS ? resetAt : null,
        overageStatus: window.overageStatus,
        overageDisabledReason: window.overageDisabledReason,
        isUsingOverage: window.isUsingOverage,
      };
      const global = status.scope === "global";
      const seen = best.get(key);
      if (!seen || seenMs > seen.seenMs || (seenMs === seen.seenMs && global && !seen.global)) {
        best.set(key, { window: candidate, seenMs, global });
      }
    }
  }
  return [...best.values()]
    .filter(({ window, seenMs }) =>
      window.resetsAtMs !== null
        ? window.resetsAtMs > nowMs
        : window.durationMins === null || seenMs + window.durationMins * MINUTE_MS > nowMs,
    )
    .map((entry) => entry.window)
    .sort(
      (a, b) =>
        Number(a.scope !== null) - Number(b.scope !== null) ||
        (a.durationMins ?? Number.POSITIVE_INFINITY) -
          (b.durationMins ?? Number.POSITIVE_INFINITY) ||
        a.name.localeCompare(b.name),
    );
}

/** Keep the provider's credit state distinct from the included-usage percentage. */
export function usageCreditsLabel(window: QuotaWindow): string | null {
  const parts = [
    window.overageStatus?.replaceAll("_", " "),
    window.overageDisabledReason?.replaceAll("_", " "),
    window.isUsingOverage === undefined ? null : window.isUsingOverage ? "in use" : "not in use",
  ].filter(Boolean);
  return parts.length ? `Usage credits: ${parts.join(" · ")}` : null;
}

/** A provider fact with the time it was reported. */
export interface Fact<T> {
  value: T;
  at: string;
}

const LIMIT_FIELDS = [
  "planRaw",
  "label",
  "credits",
  "spend",
  "spendControlReached",
  "reachedType",
] as const;
type LimitField = (typeof LIMIT_FIELDS)[number];

export interface AccountLimit {
  id: string;
  /** A provider label, or "Default limit" for the default Codex limit. */
  name: string;
  facts: { [K in LimitField]?: Fact<NonNullable<ProviderLimitTelemetry[K]> | null> };
}

export interface AccountFacts {
  source: "codex" | "claude";
  ordinaryUsageAllowed: Fact<boolean | null> | null;
  resetCreditsAvailable: Fact<number | null> | null;
  limits: AccountLimit[];
}

function newer<T>(
  current: Fact<T> | null | undefined,
  value: T | undefined,
  at: string | undefined,
) {
  if (value === undefined || !at) return current ?? null;
  if (current && timeOf(current.at) >= timeOf(at)) return current;
  return { value, at };
}

/**
 * Account facts merged over the credential's status rows. Each field keeps its
 * own newest value and time, because a report can carry only some fields.
 */
export function accountFacts(statuses: ApiKeyStatus[]): AccountFacts | null {
  const accounts = statuses
    .map((s) => s.providerAccount)
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
    .sort((a, b) => timeOf(b.observedAt) - timeOf(a.observedAt));
  const source = accounts[0]?.source;
  if (!source) return null;
  let ordinaryUsageAllowed: Fact<boolean | null> | null = null;
  let resetCreditsAvailable: Fact<number | null> | null = null;
  const limits = new Map<string, AccountLimit>();
  for (const account of accounts.filter((a) => a.source === source)) {
    const rootAt = (field: "ordinaryUsageAllowed" | "resetCreditsAvailable") =>
      account.fieldObservedAt?.[field] ?? account.observedAt;
    ordinaryUsageAllowed = newer(
      ordinaryUsageAllowed,
      account.ordinaryUsageAllowed,
      rootAt("ordinaryUsageAllowed"),
    );
    resetCreditsAvailable = newer(
      resetCreditsAvailable,
      account.resetCreditsAvailable,
      rootAt("resetCreditsAvailable"),
    );
    for (const [id, limit] of Object.entries(account.limits ?? {})) {
      const merged = limits.get(id) ?? { id, name: "", facts: {} };
      const facts = merged.facts as Record<LimitField, Fact<unknown> | null | undefined>;
      for (const field of LIMIT_FIELDS) {
        const at = limit.fieldObservedAt?.[field] ?? limit.observedAt;
        facts[field] = newer(facts[field], limit[field], at) ?? undefined;
      }
      limits.set(id, merged);
    }
  }
  for (const limit of limits.values()) {
    const label = limit.facts.label?.value;
    limit.name =
      typeof label === "string" && label
        ? label
        : limit.id === CODEX_ACCOUNT_LIMIT
          ? "Default limit"
          : limit.id;
  }
  const ordered = [...limits.values()].sort(
    (a, b) =>
      Number(b.id === CODEX_ACCOUNT_LIMIT) - Number(a.id === CODEX_ACCOUNT_LIMIT) ||
      a.name.localeCompare(b.name),
  );
  return { source, ordinaryUsageAllowed, resetCreditsAvailable, limits: ordered };
}

/** Raw ChatGPT plan claims for the Pro family. Their price tier is not verified. */
const CHATGPT_PRO_RAW = new Set(["pro", "prolite", "promax"]);

export interface PlanDisplay {
  /** False for "No plan set". */
  known: boolean;
  uncertain: boolean;
  label: string;
  /** "Set by you", "Detected", "Unverified estimate", "Price tier unknown". */
  note: string | null;
  /** The provider's raw plan, for a tooltip. */
  raw: string | null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * How a credential's plan reads. A manual choice always wins. An old estimate
 * is unverified. A raw Pro claim never becomes a priced Pro tier.
 */
export function planDisplay(
  key: {
    keyType: string;
    plan: string | null;
    planSource: ApiKeyStatus["planSource"];
    planRaw: string | null;
  },
  plans: SubscriptionPlan[] | undefined,
): PlanDisplay {
  const raw = key.planRaw?.trim() || null;
  const known = plans?.find((p) => p.id === key.plan && p.keyType === key.keyType);
  if (known) {
    const note = key.planSource ? PLAN_SOURCES[key.planSource].label : null;
    return {
      known: true,
      uncertain: key.planSource === "estimated",
      label: known.label,
      note,
      raw,
    };
  }
  if (raw) {
    const lower = raw.toLowerCase();
    const codex = key.keyType === "CODEX_OAUTH";
    if (codex && CHATGPT_PRO_RAW.has(lower)) {
      return {
        known: true,
        uncertain: true,
        label: "ChatGPT Pro",
        note: "Price tier unknown",
        raw,
      };
    }
    // Unambiguous claims (`go`, `plus`) name one catalog plan, as the API maps them.
    const claimed = codex
      ? plans?.find(
          (p) =>
            p.keyType === key.keyType &&
            p.id === `chatgpt_${lower === "team" ? "business" : lower}`,
        )
      : undefined;
    if (claimed)
      return {
        known: true,
        uncertain: false,
        label: claimed.label,
        note: PLAN_SOURCES.detected.label,
        raw,
      };
    return {
      known: true,
      uncertain: false,
      label: codex ? `ChatGPT ${capitalize(raw)}` : raw,
      note: null,
      raw,
    };
  }
  return { known: false, uncertain: false, label: "No plan set", note: null, raw: null };
}

/** The account's raw plan: the status row, the merged account facts, or the stored login. */
export function rawPlanOf(
  statuses: ApiKeyStatus[],
  fallback: string | null | undefined,
): string | null {
  for (const status of statuses) {
    if (status.detectedPlanRaw) return status.detectedPlanRaw;
  }
  const facts = accountFacts(statuses);
  const fromAccount = facts?.limits.find((l) => l.id === CODEX_ACCOUNT_LIMIT)?.facts.planRaw?.value;
  if (typeof fromAccount === "string" && fromAccount) return fromAccount;
  return fallback ?? null;
}
