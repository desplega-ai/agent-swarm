import { describe, expect, test } from "bun:test";
import {
  API_SANDBOX_SHAPE,
  attemptMeteredUsd,
  configBilling,
  DEFAULT_SUBSCRIPTION_CONFIG_CONCURRENCY,
  e2bUsdPerSandboxHour,
  estimateSandboxUsd,
  sandboxHourlyUsd,
  subscriptionConfigConcurrency,
  WORKER_SANDBOX_SHAPE,
} from "./billing.ts";

describe("configBilling mirrors the credential the sandbox is given", () => {
  test("claude: OAuth token -> subscription, else the API key -> metered", () => {
    expect(configBilling({ provider: "claude" }, { CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBe(
      "subscription",
    );
    expect(configBilling({ provider: "claude" }, {})).toBe("metered");
  });

  test("codex: only OPENAI_API_KEY reaches the sandbox, so metered unless declared a flat plan", () => {
    expect(configBilling({ provider: "codex" }, { OPENAI_API_KEY: "k" })).toBe("metered");
    expect(configBilling({ provider: "codex" }, { EVALS_CODEX_BILLING: "subscription" })).toBe(
      "subscription",
    );
    expect(configBilling({ provider: "codex" }, { EVALS_CODEX_BILLING: "metered" })).toBe(
      "metered",
    );
  });

  test("pi and opencode are always metered", () => {
    expect(configBilling({ provider: "pi" }, { CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBe("metered");
    expect(configBilling({ provider: "opencode" }, {})).toBe("metered");
  });
});

describe("env knobs", () => {
  test("subscription concurrency: integer >= 1, else the default of 3", () => {
    expect(subscriptionConfigConcurrency({})).toBe(DEFAULT_SUBSCRIPTION_CONFIG_CONCURRENCY);
    expect(DEFAULT_SUBSCRIPTION_CONFIG_CONCURRENCY).toBe(3);
    expect(subscriptionConfigConcurrency({ EVALS_SUBSCRIPTION_CONFIG_CONCURRENCY: "2" })).toBe(2);
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      expect(subscriptionConfigConcurrency({ EVALS_SUBSCRIPTION_CONFIG_CONCURRENCY: bad })).toBe(3);
    }
  });

  test("E2B flat override: positive number, else null (published per-shape rates apply)", () => {
    expect(e2bUsdPerSandboxHour({})).toBeNull();
    expect(e2bUsdPerSandboxHour({ EVALS_E2B_USD_PER_SANDBOX_HOUR: "0.25" })).toBe(0.25);
    expect(e2bUsdPerSandboxHour({ EVALS_E2B_USD_PER_SANDBOX_HOUR: "0" })).toBeNull();
    expect(e2bUsdPerSandboxHour({ EVALS_E2B_USD_PER_SANDBOX_HOUR: "nope" })).toBeNull();
  });
});

describe("E2B published rates", () => {
  test("hourly price of each sandbox shape (2 vCPU / 2 GiB API, 4 vCPU / 8 GiB worker)", () => {
    // (2 x 0.000014 + 2 x 0.0000045) x 3600
    expect(sandboxHourlyUsd(API_SANDBOX_SHAPE)).toBeCloseTo(0.1332, 6);
    // (4 x 0.000014 + 8 x 0.0000045) x 3600
    expect(sandboxHourlyUsd(WORKER_SANDBOX_SHAPE)).toBeCloseTo(0.3312, 6);
  });
});

describe("attemptMeteredUsd", () => {
  const sandbox = (workers: number) =>
    ({ workers: Array.from({ length: workers }, () => ({})) }) as never;

  test("default: hours x (API shape + one worker shape per roster entry)", () => {
    // 30 min, API + 2 workers: 0.5 x (0.1332 + 2 x 0.3312)
    expect(estimateSandboxUsd({ durationMs: 1_800_000, sandbox: sandbox(2) })).toBeCloseTo(
      0.5 * (0.1332 + 2 * 0.3312),
      6,
    );
    // no roster persisted yet counts one worker
    expect(estimateSandboxUsd({ durationMs: 3_600_000, sandbox: null })).toBeCloseTo(
      0.1332 + 0.3312,
      6,
    );
    expect(estimateSandboxUsd({ durationMs: null, sandbox: null })).toBe(0);
  });

  test("flat override: wall clock x (API + workers) x rate", () => {
    // 30 min, 3 sandboxes, $0.10/h -> 0.5h x 3 x 0.1
    expect(estimateSandboxUsd({ durationMs: 1_800_000, sandbox: sandbox(2) }, 0.1)).toBeCloseTo(
      0.15,
      10,
    );
  });

  test("metered agent cost + judge + sandbox; a subscription agent contributes only judge and sandbox", () => {
    const attempt = {
      costUsd: 1,
      judgeCostUsd: 0.02,
      durationMs: 3_600_000,
      sandbox: sandbox(1),
    };
    expect(attemptMeteredUsd(attempt, "metered", 0.1)).toBeCloseTo(1 + 0.02 + 0.2, 10);
    expect(attemptMeteredUsd(attempt, "subscription", 0.1)).toBeCloseTo(0.02 + 0.2, 10);
    expect(attemptMeteredUsd(attempt, "subscription")).toBeCloseTo(0.02 + 0.1332 + 0.3312, 6);
  });

  test("unpriced parts count as zero, never NaN", () => {
    const v = attemptMeteredUsd(
      { costUsd: null, judgeCostUsd: null, durationMs: null, sandbox: null },
      "metered",
    );
    expect(v).toBe(0);
  });
});
