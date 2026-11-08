import { describe, expect, test } from "bun:test";
import {
  normalizeCodexRateLimits,
  normalizeCodexRateLimitsResponse,
} from "../utils/codex-rate-limits";
import {
  applyProviderQuotaReport,
  codexWindowKey,
  mergeProviderAccountTelemetry,
  providerAccountTelemetrySchema,
  scrubProviderQuotaReport,
} from "../utils/provider-account-telemetry";

const observedAt = "2026-11-08T01:00:00.000Z";
describe("native Codex quota normalization", () => {
  test("preserves weekly primary, null secondary, model scope, units and limit identity", () => {
    const quota = normalizeCodexRateLimits(
      {
        limitId: "model-limit",
        limitName: "Model weekly",
        normalModelSlug: "gpt-test",
        primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1794704400 },
        secondary: null,
        planType: "promax",
        rateLimitReachedType: "rate_limit_reached",
        credits: { hasCredits: true, unlimited: false, balance: "8.25", paymentMethod: "excluded" },
        individualLimit: { limit: "80", used: "20", remainingPercent: 75, resetsAt: 1794704400 },
        spendControlReached: false,
        accountId: "excluded",
        arbitrary: "excluded",
      },
      observedAt,
    )!;
    expect(quota.windows).toEqual({
      "codex:model-limit:primary": {
        source: "codex",
        limitId: "model-limit",
        label: "Model weekly",
        normalModelSlug: "gpt-test",
        status: "rejected",
        utilization: 1,
        durationMins: 10080,
        resetsAt: 1794704400,
        lastSeenAt: observedAt,
      },
    });
    expect(quota.replace[0]?.slots).toEqual(["primary", "secondary"]);
    expect(quota.account.limits?.["model-limit"]?.credits).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: "8.25",
    });
    expect(quota.account.limits?.["model-limit"]?.spend?.limit).toBe("80");
    expect(JSON.stringify(quota)).not.toContain("excluded");
  });

  test("preserves over-limit percentages without assuming a 100-percent schema ceiling", () => {
    const quota = normalizeCodexRateLimits(
      {
        primary: { usedPercent: 125 },
        individualLimit: { limit: "80", used: "100", remainingPercent: -25, resetsAt: 1794704400 },
      },
      observedAt,
    )!;
    expect(quota.windows["codex:codex:primary"]?.utilization).toBe(1.25);
    expect(quota.windows["codex:codex:primary"]?.status).toBe("rejected");
    expect(quota.account.limits?.codex?.spend?.remainingPercent).toBe(-25);
  });

  test("account-only and explicit removal snapshots survive without utilization", () => {
    const quota = normalizeCodexRateLimits(
      { primary: null, secondary: null, credits: null },
      observedAt,
    )!;
    expect(quota.windows).toEqual({});
    expect(quota.account.limits?.codex?.credits).toBeNull();
    expect(quota.replace).toHaveLength(1);
    expect(normalizeCodexRateLimits({ planType: "future-plan" }, observedAt)?.replace).toEqual([]);
  });

  test("sparse metadata nulls preserve known values, but spend-control null remains explicit", () => {
    const full = normalizeCodexRateLimits(
      {
        planType: "pro",
        credits: { hasCredits: true, unlimited: false },
        spendControlReached: true,
      },
      observedAt,
    )!;
    const sparse = normalizeCodexRateLimits(
      { planType: null, credits: null, spendControlReached: null },
      "2026-11-08T01:01:00.000Z",
      true,
    )!;
    const account = mergeProviderAccountTelemetry(full.account, sparse.account)!;
    expect(account.limits?.codex?.planRaw).toBe("pro");
    expect(account.limits?.codex?.credits?.hasCredits).toBe(true);
    expect(account.limits?.codex?.spendControlReached).toBeNull();
    expect(mergeProviderAccountTelemetry(account, full.account)).toEqual(account);
  });

  test.each([
    NaN,
    Infinity,
    -1,
    2147483648,
    0.5,
  ])("rejects malformed percentages %p without a false removal", (usedPercent) => {
    expect(normalizeCodexRateLimits({ primary: { usedPercent } }, observedAt)?.replace).toEqual([]);
  });
  test("omits invalid resets and durations without creating default measurements", () => {
    const quota = normalizeCodexRateLimits(
      { primary: { usedPercent: 45, resetsAt: 1e20, windowDurationMins: -1 } },
      observedAt,
    )!;
    expect(quota.windows["codex:codex:primary"]?.utilization).toBe(0.45);
    expect(quota.windows["codex:codex:primary"]?.resetsAt).toBeUndefined();
    expect(quota.windows["codex:codex:primary"]?.durationMins).toBeUndefined();
    expect(normalizeCodexRateLimits({}, "invalid")).toBeUndefined();
    expect(normalizeCodexRateLimits(undefined, observedAt)).toBeUndefined();
  });
  test("report schemas reject payment metadata and unbounded text", () => {
    expect(
      providerAccountTelemetrySchema.safeParse({
        source: "codex",
        observedAt,
        accountId: "forbidden",
      }).success,
    ).toBe(false);
    expect(
      providerAccountTelemetrySchema.safeParse({
        source: "codex",
        observedAt,
        limits: { codex: { observedAt, planRaw: "x".repeat(257) } },
      }).success,
    ).toBe(false);
  });
});

const older = "2026-11-01T01:00:00.000Z";
const newer = "2026-11-08T01:00:00.000Z";
const empty = { windows: {} };
const normalized = (raw: unknown, at = newer, sparse = false) =>
  normalizeCodexRateLimits(raw, at, sparse)!;

describe("quota report application", () => {
  test("sparse windows retain metadata and its actual observation time after an expired reset", () => {
    const initial = normalized(
      {
        limitName: "Weekly",
        normalModelSlug: "model",
        primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793581200 },
      },
      older,
    );
    const first = applyProviderQuotaReport(empty, initial);
    const result = applyProviderQuotaReport(
      first,
      normalized(
        {
          limitName: null,
          normalModelSlug: null,
          primary: { usedPercent: 10, windowDurationMins: null, resetsAt: null },
        },
        newer,
        true,
      ),
    );
    expect(result.windows["codex:codex:primary"]).toMatchObject({
      utilization: 0.1,
      status: "allowed",
      lastSeenAt: newer,
      durationMins: 10080,
      label: "Weekly",
      normalModelSlug: "model",
      resetsAt: 1793581200,
      fieldObservedAt: {
        durationMins: older,
        label: older,
        normalModelSlug: older,
        resetsAt: older,
      },
    });
    // Recovery changes utilization. An expired reset stays expired until the provider reports another reset.
    expect(result.windows["codex:codex:primary"]!.resetsAt! * 1000).toBeLessThan(Date.parse(newer));
  });

  test("window-only events and removals retain actual account fact ages", () => {
    const initial = normalized(
      {
        planType: "pro",
        credits: { hasCredits: true, unlimited: false, balance: "9" },
        individualLimit: { limit: "40", used: "2", remainingPercent: 95, resetsAt: 1796000000 },
      },
      older,
    );
    let result = applyProviderQuotaReport(empty, {
      ...initial,
      account: { ...initial.account, ordinaryUsageAllowed: false, resetCreditsAvailable: 2 },
    });
    result = applyProviderQuotaReport(result, normalized({ primary: { usedPercent: 20 } }));
    result = applyProviderQuotaReport(result, normalized({ secondary: null }));
    expect(result.account).toMatchObject({
      ordinaryUsageAllowed: false,
      resetCreditsAvailable: 2,
      fieldObservedAt: { ordinaryUsageAllowed: older, resetCreditsAvailable: older },
      limits: {
        codex: {
          fieldObservedAt: { planRaw: older, credits: older, spend: older },
          windowRemovedAt: { secondary: newer },
        },
      },
    });
    expect(result.account?.limits?.codex?.credits?.balance).toBe("9");
    expect(result.account?.limits?.codex?.spend?.used).toBe("2");
    expect(providerAccountTelemetrySchema.safeParse(result.account).success).toBe(true);
  });

  test("delayed facts fill omissions independently of newer bucket observations", () => {
    const current = applyProviderQuotaReport(
      empty,
      normalized({ primary: { usedPercent: 70 }, planType: "promax" }),
    );
    const result = applyProviderQuotaReport(
      current,
      normalized(
        {
          primary: { usedPercent: 10, windowDurationMins: 43200, resetsAt: 1796000000 },
          secondary: { usedPercent: 30 },
          planType: "plus",
          credits: { hasCredits: true, unlimited: false, balance: "8" },
        },
        older,
      ),
    );
    expect(result.windows["codex:codex:primary"]).toMatchObject({
      utilization: 0.7,
      lastSeenAt: newer,
      durationMins: 43200,
      resetsAt: 1796000000,
    });
    expect(result.windows["codex:codex:secondary"]?.utilization).toBe(0.3);
    expect(result.account?.limits?.codex).toMatchObject({
      planRaw: "promax",
      credits: { balance: "8" },
      fieldObservedAt: { planRaw: newer, credits: older },
    });
  });

  test("an explicit null slot blocks old resurrection without blocking other facts", () => {
    const removed = applyProviderQuotaReport(empty, normalized({ primary: null }));
    const result = applyProviderQuotaReport(
      removed,
      normalized(
        {
          primary: { usedPercent: 1 },
          secondary: { usedPercent: 10 },
          credits: { hasCredits: true, unlimited: true },
        },
        older,
      ),
    );
    expect(result.windows["codex:codex:primary"]).toBeUndefined();
    expect(result.windows["codex:codex:secondary"]?.utilization).toBe(0.1);
    expect(result.account?.limits?.codex?.credits?.unlimited).toBe(true);
  });

  test("a removal blocks metadata from an earlier incarnation after recovery", () => {
    const removed = applyProviderQuotaReport(
      empty,
      normalized({ primary: null }, "2026-11-02T01:00:00.000Z"),
    );
    const recovered = applyProviderQuotaReport(
      removed,
      normalized({ primary: { usedPercent: 2 } }),
    );
    const result = applyProviderQuotaReport(
      recovered,
      normalized(
        { primary: { usedPercent: 90, resetsAt: 1796000000, windowDurationMins: 10080 } },
        older,
      ),
    );
    expect(result.windows["codex:codex:primary"]?.durationMins).toBeUndefined();
    expect(result.windows["codex:codex:primary"]?.resetsAt).toBeUndefined();
  });

  test("initial reads lose ties to notification facts and removals, but fill other facts", () => {
    const notification = applyProviderQuotaReport(
      empty,
      normalized({ primary: { usedPercent: 80 }, secondary: null, planType: "pro" }),
    );
    const result = applyProviderQuotaReport(
      notification,
      normalized({
        primary: { usedPercent: 10, windowDurationMins: 10080 },
        secondary: { usedPercent: 1 },
        planType: "plus",
        credits: { hasCredits: true, unlimited: false },
      }),
      true,
    );
    expect(result.windows["codex:codex:primary"]).toMatchObject({
      utilization: 0.8,
      durationMins: 10080,
    });
    expect(result.windows["codex:codex:secondary"]).toBeUndefined();
    expect(result.account?.limits?.codex?.planRaw).toBe("pro");
    const kept = applyProviderQuotaReport(notification, normalized({ primary: null }), true);
    expect(kept.windows["codex:codex:primary"]?.utilization).toBe(0.8);
  });

  test("scrubbing preserves parseable facts, bounded fields, and linked removal identities", () => {
    const secret = `sk-ant-api03-${"X".repeat(90)}`;
    const raw = normalized(
      {
        limitId: secret,
        limitName: `quoted " ${secret}`,
        normalModelSlug: secret,
        planType: secret,
        rateLimitReachedType: secret,
        credits: { hasCredits: true, unlimited: false, balance: secret },
        individualLimit: {
          limit: secret,
          used: secret,
          remainingPercent: 80,
          resetsAt: 1796000000,
        },
        primary: { usedPercent: 10 },
      },
      older,
    );
    const clean = scrubProviderQuotaReport(raw);
    const result = applyProviderQuotaReport(empty, clean);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(providerAccountTelemetrySchema.safeParse(JSON.parse(serialized).account).success).toBe(
      true,
    );
    const id = Object.keys(result.account!.limits!)[0]!;
    expect(result.windows[codexWindowKey(id, "primary")]?.utilization).toBe(0.1);
    const removed = applyProviderQuotaReport(
      result,
      scrubProviderQuotaReport(normalized({ limitId: secret, primary: null })),
    );
    expect(removed.windows).toEqual({});
    expect(removed.account?.limits?.[id]?.windowRemovedAt?.primary).toBe(newer);
    expect(applyProviderQuotaReport(removed, clean).windows).toEqual({});
  });
});

test.each([
  {},
  null,
  undefined,
])("an empty multi-limit map %p falls back to the legacy snapshot", (rateLimitsByLimitId) => {
  const result = normalizeCodexRateLimitsResponse(
    { rateLimitsByLimitId, rateLimits: { primary: { usedPercent: 40 }, planType: "pro" } },
    observedAt,
  )!;
  expect(result.windows["codex:codex:primary"]?.utilization).toBe(0.4);
});

test("a delayed removal retains newer recovery and rejects metadata from before removal", () => {
  const initial = applyProviderQuotaReport(
    empty,
    normalized(
      { primary: { usedPercent: 100, resetsAt: 1796000000, windowDurationMins: 10080 } },
      older,
    ),
  );
  const recovered = applyProviderQuotaReport(initial, normalized({ primary: { usedPercent: 10 } }));
  const removalAt = "2026-11-02T01:00:00.000Z";
  const result = applyProviderQuotaReport(recovered, normalized({ primary: null }, removalAt));
  expect(result.windows["codex:codex:primary"]?.utilization).toBe(0.1);
  expect(result.windows["codex:codex:primary"]?.resetsAt).toBeUndefined();
  expect(result.account?.limits?.codex?.windowRemovedAt?.primary).toBe(removalAt);
  expect(
    applyProviderQuotaReport(
      result,
      normalized({ primary: { usedPercent: 100, resetsAt: 1796000000 } }, older),
    ).windows["codex:codex:primary"]?.resetsAt,
  ).toBeUndefined();
});
