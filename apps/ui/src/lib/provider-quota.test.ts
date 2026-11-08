import { describe, expect, test } from "bun:test";
import type { ApiKeyStatus, ProviderAccountTelemetry, SubscriptionPlan } from "../api/types";
import {
  accountFacts,
  currentQuotaWindows,
  formatPeriod,
  planDisplay,
  quotaRemaining,
  quotaResetIn,
  usageCreditsLabel,
} from "./provider-quota";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => Math.floor(ms / 1000);

function row(
  windows: ApiKeyStatus["rateLimitWindows"],
  extra: Partial<ApiKeyStatus> = {},
): ApiKeyStatus {
  return {
    id: extra.id ?? "status-global",
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    keySuffix: "a91f2",
    scope: "global",
    scopeId: "",
    provider: "claude",
    rateLimitWindows: windows,
    ...extra,
  } as ApiKeyStatus;
}

const names = (statuses: ApiKeyStatus[], now = NOW) =>
  currentQuotaWindows(statuses, now).map((w) => w.name);

describe("current quota windows", () => {
  test("Claude credit rejection does not change the included quota", () => {
    const [window] = currentQuotaWindows(
      [
        row({
          seven_day: {
            status: "allowed",
            utilization: 0.5,
            lastSeenAt: iso(NOW),
            resetsAt: sec(NOW + H),
            overageStatus: "rejected",
            overageDisabledReason: "group_zero_credit_limit",
            isUsingOverage: false,
          },
        }),
      ],
      NOW,
    );
    expect(window).toMatchObject({ percent: 50, limited: false, overageStatus: "rejected" });
    expect(usageCreditsLabel(window!)).toBe(
      "Usage credits: rejected · group zero credit limit · not in use",
    );
  });

  test("Codex slots without lengths have distinct names", () => {
    const windows = currentQuotaWindows(
      [
        row(
          {
            "codex:codex:primary": { status: "allowed", utilization: 0.3, lastSeenAt: iso(NOW) },
            "codex:codex:secondary": { status: "allowed", utilization: 0.6, lastSeenAt: iso(NOW) },
          },
          { provider: "codex", keyType: "CODEX_OAUTH" },
        ),
      ],
      NOW,
    );
    expect(windows.map((w) => w.name)).toEqual(["Primary limit", "Secondary limit"]);
    expect(windows.every((w) => w.durationMins === null)).toBe(true);
  });
  test("a passed reset hides the window; the boundary itself counts as passed", () => {
    const status = row({
      five_hour: {
        status: "allowed",
        utilization: 0.87,
        resetsAt: sec(NOW - 187 * H),
        lastSeenAt: iso(NOW - 192 * H),
      },
      seven_day: {
        status: "allowed",
        utilization: 0.64,
        resetsAt: sec(NOW + 3 * H),
        lastSeenAt: iso(NOW - 6 * 60_000),
      },
    });
    // A verified Ultra account keeps only its current weekly window.
    expect(names([status])).toEqual(["7 d"]);
    expect(names([status], NOW + 3 * H)).toEqual([]);
    expect(names([status], NOW + 3 * H - 1)).toEqual(["7 d"]);
  });

  test("without a reset, a window of known length lapses one length after it was seen", () => {
    const status = row({
      five_hour: { status: "allowed", utilization: 0.4, lastSeenAt: iso(NOW - 4 * H) },
    });
    expect(currentQuotaWindows([status], NOW)[0]).toMatchObject({
      name: "5 h",
      percent: 40,
      resetsAtMs: null,
    });
    expect(names([status], NOW + H)).toEqual([]);
  });

  test("missing utilization stays unknown, and an unknown length with no reset stays visible", () => {
    const status = row({
      overage: { status: "allowed", lastSeenAt: iso(NOW - 3 * H) },
    });
    const [window] = currentQuotaWindows([status], NOW);
    expect(window).toMatchObject({ name: "Usage credits", percent: null, resetsAtMs: null });
    expect(window?.percent).not.toBe(0);
  });

  test("custom Claude windows read their scope and length", () => {
    const status = row({
      seven_day_overage_included: {
        status: "allowed",
        utilization: 0.31,
        resetsAt: sec(NOW + 50 * H),
        lastSeenAt: iso(NOW),
      },
      seven_day_opus: {
        status: "rejected",
        utilization: 1,
        resetsAt: sec(NOW + 2 * H),
        lastSeenAt: iso(NOW),
      },
      seven_day_cowork: {
        status: "allowed",
        utilization: 0.1,
        durationMins: 43200,
        label: "Cowork",
        resetsAt: sec(NOW + 20 * 24 * H),
        lastSeenAt: iso(NOW),
      },
    });
    const windows = currentQuotaWindows([status], NOW);
    expect(windows.map((w) => w.name)).toEqual(["Fable 7 d", "Opus 7 d", "Cowork 30 d"]);
    expect(windows[1]?.limited).toBe(true);
  });

  test("a weekly Codex primary is weekly, and a model limit keeps a percent above 100", () => {
    const status = row(
      {
        "codex:codex:primary": {
          source: "codex",
          limitId: "codex",
          status: "allowed",
          utilization: 0.22,
          durationMins: 10080,
          resetsAt: sec(NOW + 90 * H),
          lastSeenAt: iso(NOW),
        },
        "codex:codex_bengalfox:primary": {
          source: "codex",
          limitId: "codex_bengalfox",
          label: "GPT-5.3-Codex-Spark",
          normalModelSlug: "gpt-5.3-codex-spark",
          status: "rejected",
          utilization: 1.04,
          durationMins: 300,
          resetsAt: sec(NOW + H),
          lastSeenAt: iso(NOW),
        },
      },
      { keyType: "CODEX_OAUTH", provider: "codex" },
    );
    const windows = currentQuotaWindows([status], NOW);
    expect(windows.map((w) => [w.name, w.scope, w.percent])).toEqual([
      ["7 d", null, 22],
      ["GPT-5.3-Codex-Spark 5 h", "GPT-5.3-Codex-Spark", 104],
    ]);
    expect(formatPeriod(90)).toBe("1.5 h");
  });

  test("equal windows from global and agent rows count once, newest first", () => {
    const window = (utilization: number, seen: number) => ({
      seven_day: {
        status: "allowed",
        utilization,
        resetsAt: sec(NOW + 10 * H),
        lastSeenAt: iso(seen),
      },
    });
    const global = row(window(0.5, NOW - H));
    const agent = row(window(0.6, NOW - 60_000), {
      id: "status-agent",
      scope: "agent",
      scopeId: "agent-1",
    });
    const windows = currentQuotaWindows([global, agent], NOW);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ statusId: "status-agent", percent: 60 });
    // A tie prefers the global row.
    const tie = row(window(0.7, NOW - H), { id: "status-agent", scope: "agent" });
    expect(currentQuotaWindows([tie, global], NOW)[0]?.statusId).toBe("status-global");
  });

  test("an expired newer report does not hide a current older one", () => {
    const fresh = row({
      five_hour: {
        status: "allowed",
        utilization: 0.9,
        resetsAt: sec(NOW - 1),
        lastSeenAt: iso(NOW),
      },
    });
    const older = row(
      {
        five_hour: {
          status: "allowed",
          utilization: 0.3,
          resetsAt: sec(NOW + H),
          lastSeenAt: iso(NOW - H),
        },
      },
      { id: "status-agent", scope: "agent" },
    );
    expect(currentQuotaWindows([fresh, older], NOW).map((w) => w.percent)).toEqual([30]);
  });

  test("a newer explicit slot removal on any row hides an older report of that slot", () => {
    const codex = { keyType: "CODEX_OAUTH", provider: "codex" } as const;
    const removal: ProviderAccountTelemetry = {
      source: "codex",
      observedAt: iso(NOW - 4 * 60_000),
      limits: {
        codex: {
          observedAt: iso(NOW - 4 * 60_000),
          windowRemovedAt: { secondary: iso(NOW - 4 * 60_000) },
        },
      },
    };
    const global = row({}, { ...codex, providerAccount: removal });
    const secondary = (seen: number) => ({
      "codex:codex:secondary": {
        source: "codex" as const,
        limitId: "codex",
        status: "allowed",
        utilization: 0.71,
        durationMins: 300,
        resetsAt: sec(NOW + 3 * H),
        lastSeenAt: iso(seen),
      },
    });
    const older = row(secondary(NOW - 40 * 60_000), { ...codex, id: "a", scope: "agent" });
    expect(currentQuotaWindows([global, older], NOW)).toEqual([]);
    const newer = row(secondary(NOW - 60_000), { ...codex, id: "a", scope: "agent" });
    expect(currentQuotaWindows([global, newer], NOW).map((w) => w.name)).toEqual(["5 h"]);
  });

  test("an older reset fact is reported separately from the utilization", () => {
    const status = row({
      seven_day: {
        status: "allowed",
        utilization: 0.2,
        resetsAt: sec(NOW + H),
        lastSeenAt: iso(NOW),
        fieldObservedAt: { resetsAt: iso(NOW - 2 * H) },
      },
    });
    expect(currentQuotaWindows([status], NOW)[0]?.resetObservedAt).toBe(iso(NOW - 2 * H));
  });
});

describe("account facts", () => {
  test("each fact keeps its newest value and its own time across rows", () => {
    const older: ProviderAccountTelemetry = {
      source: "codex",
      observedAt: iso(NOW - H),
      ordinaryUsageAllowed: false,
      limits: {
        codex: {
          observedAt: iso(NOW - H),
          credits: { hasCredits: true, unlimited: false, balance: "125.50" },
        },
      },
    };
    const newer: ProviderAccountTelemetry = {
      source: "codex",
      observedAt: iso(NOW),
      fieldObservedAt: { ordinaryUsageAllowed: iso(NOW), resetCreditsAvailable: iso(NOW - 2 * H) },
      ordinaryUsageAllowed: true,
      resetCreditsAvailable: 2,
      limits: {
        codex: {
          observedAt: iso(NOW),
          fieldObservedAt: { spend: iso(NOW - 30 * 60_000) },
          spend: { limit: "80", used: "20", remainingPercent: 75, resetsAt: sec(NOW + H) },
        },
        codex_bengalfox: {
          observedAt: iso(NOW),
          label: "Spark",
          reachedType: "rate_limit_reached",
        },
      },
    };
    const facts = accountFacts([
      row({}, { providerAccount: older }),
      row({}, { id: "b", scope: "agent", providerAccount: newer }),
    ]);
    expect(facts?.ordinaryUsageAllowed).toEqual({ value: true, at: iso(NOW) });
    // The aggregate time is not the age of a retained fact.
    expect(facts?.resetCreditsAvailable).toEqual({ value: 2, at: iso(NOW - 2 * H) });
    expect(facts?.limits.map((l) => l.name)).toEqual(["Default limit", "Spark"]);
    const account = facts?.limits[0]?.facts;
    expect(account?.credits).toEqual({
      value: { hasCredits: true, unlimited: false, balance: "125.50" },
      at: iso(NOW - H),
    });
    expect(account?.spend?.at).toBe(iso(NOW - 30 * 60_000));
    expect(accountFacts([row({})])).toBeNull();
  });
});

describe("plan display", () => {
  const plans = [
    { id: "claude_max_20x", label: "Claude Ultra", keyType: "CLAUDE_CODE_OAUTH_TOKEN" },
    { id: "chatgpt_pro", label: "ChatGPT Pro 200", keyType: "CODEX_OAUTH" },
    { id: "chatgpt_plus", label: "ChatGPT Plus", keyType: "CODEX_OAUTH" },
    { id: "chatgpt_business", label: "ChatGPT Business, standard seat", keyType: "CODEX_OAUTH" },
  ] as SubscriptionPlan[];
  const key = (
    plan: string | null,
    planSource: ApiKeyStatus["planSource"],
    planRaw: string | null,
  ) => ({
    keyType: plan?.startsWith("claude") ? "CLAUDE_CODE_OAUTH_TOKEN" : "CODEX_OAUTH",
    plan,
    planSource,
    planRaw,
  });

  test("a manual choice wins over the raw claim, and an old estimate is unverified", () => {
    expect(planDisplay(key("chatgpt_pro", "manual", "promax"), plans)).toMatchObject({
      label: "ChatGPT Pro 200",
      note: "Set by you",
      raw: "promax",
      uncertain: false,
    });
    expect(planDisplay(key("claude_max_20x", "estimated", null), plans)).toMatchObject({
      label: "Claude Ultra",
      note: "Unverified estimate",
      uncertain: true,
    });
  });

  test("raw Pro claims never become a priced tier", () => {
    for (const raw of ["pro", "prolite", "promax"]) {
      expect(planDisplay(key(null, null, raw), plans)).toEqual({
        known: true,
        uncertain: true,
        label: "ChatGPT Pro",
        note: "Price tier unknown",
        raw,
      });
    }
    expect(planDisplay(key(null, null, "enterprise"), plans)).toMatchObject({
      label: "ChatGPT Enterprise",
      note: null,
    });
    // An unambiguous claim names its catalog plan.
    expect(planDisplay(key(null, null, "plus"), plans)).toMatchObject({
      label: "ChatGPT Plus",
      note: "Detected",
    });
    expect(planDisplay(key(null, null, "team"), plans)).toMatchObject({
      label: "ChatGPT Business, standard seat",
      note: "Detected",
    });
    expect(planDisplay(key(null, null, null), plans)).toMatchObject({
      known: false,
      label: "No plan set",
    });
  });
});

describe("compact quota values", () => {
  test("remaining allowance clamps provider overage and negative readings", () => {
    expect(quotaRemaining(64)).toBe(36);
    expect(quotaRemaining(125)).toBe(0);
    expect(quotaRemaining(-5)).toBe(100);
  });

  test("reset countdown preserves days and hours without implying an early reset", () => {
    expect(quotaResetIn(NOW + 500, NOW)).toBe("1m");
    expect(quotaResetIn(NOW + 90 * 60_000, NOW)).toBe("1h 30m");
    expect(quotaResetIn(NOW + 75 * 3_600_000, NOW)).toBe("3d 3h");
  });
});
