import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionGlobalConfig } from "motion/react";
import { act, type ReactNode, useLayoutEffect } from "react";
import type { ApiKeyStatus } from "../../api/types";

// A DOM for the click tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
// happy-dom rejects a cancelled Web Animation; the details reveal must not animate here.
MotionGlobalConfig.skipAnimations = true;
afterAll(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await GlobalRegistrator.unregister();
});

// `bun test` does not read the `@/` path alias: map every alias the panel and
// the key row import to the real module. Each mock keeps every export.
for (const path of [
  "api/client",
  "api/hooks/use-api-keys",
  "api/hooks/use-codex-accounts",
  "api/hooks/use-config-api",
  "api/hooks/use-onboarding",
  "api/hooks/use-pool-keys",
  "components/kibo-ui/spinner",
  "components/shared/animated-reveal",
  "components/onboarding/autosave-secret-field",
  "components/onboarding/codex-accounts-list",
  "components/onboarding/pool-keys-list",
  "components/onboarding/save-indicator",
  "components/shared/brand-logo",
  "components/shared/copy-icon-button",
  "components/shared/key-status-pill",
  "components/shared/plan-picker",
  "components/shared/provider-icon",
  "components/shared/secret-input",
  "components/shared/status-icon",
  "components/ui/alert-callout",
  "components/ui/alert-dialog",
  "components/ui/badge",
  "components/ui/button",
  "components/ui/dialog",
  "components/ui/dropdown-menu",
  "components/ui/info-row",
  "components/ui/input",
  "components/ui/select",
  "components/ui/sheet",
  "components/ui/skeleton",
  "components/ui/spinner",
  "components/ui/textarea",
  "components/ui/tooltip",
  "hooks/use-autosave",
  "hooks/use-codex-device-flow",
  "hooks/use-copy-to-clipboard",
  "hooks/use-minute-clock",
  "lib/ai-providers",
  "lib/config",
  "lib/connection-url-params",
  "lib/cost-format",
  "lib/deployment-config",
  "lib/format-tokens",
  "lib/provider-quota",
  "lib/utils",
]) {
  mock.module(`@/${path}`, () => require(`../../${path}`));
}
mock.module("@/hooks/use-config", () => ({
  ...require("../../hooks/use-config"),
  useConfig: () => ({ config: { apiUrl: "http://api.test", apiKey: "" } }),
}));

const { ProviderSetupPanel } = await import("./provider-setup-panel");
const { PoolKeyRow } = await import("./pool-key-row");
const { findAiProvider } = await import("../../lib/ai-providers");
const { CODEX_EXPIRED_MESSAGE } = await import("../../hooks/use-codex-device-flow");
// The API client sends nothing without a stored connection.
const { addConnection } = await import("../../lib/config");
addConnection({ name: "test", apiUrl: "http://api.test", apiKey: "test-key" });

// ─── a fake API behind `fetch` ──────────────────────────────────────────────

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
let routes: Record<string, Handler> = {};
const calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
const realSetTimeout = window.setTimeout;
beforeEach(() => {
  routes = {};
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://api.test");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return json({ error: `no route ${method} ${url.pathname}` }, 404);
    return handler(url, init);
  }) as typeof fetch;
  // The device flow polls every few seconds: run its timers at once.
  window.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof window.setTimeout;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  window.setTimeout = realSetTimeout;
  document.body.innerHTML = "";
});

const EMPTY_POOL = (key: string) => ({ key, source: "none", readOnly: false, keys: [] });

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return {
    cleanup: () => act(async () => root.unmount()),
  };
}

/** Let fetches, React Query and the zero-delay timers settle. */
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => realSetTimeout(resolve, 5));
    });
  }
}

function text(): string {
  return document.body.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`no button "${label}" in: ${text()}`);
  return found;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const OPENROUTER_KEY = `sk-or-v1-${"a".repeat(59)}12345`;

// ─── Add provider side panel ────────────────────────────────────────────────

describe("ProviderSetupPanel: add a pool key", () => {
  const openrouter = findAiProvider("openrouter")!;

  test("shows the steps and the config key, checks the key, then lists it", async () => {
    let finish: (r: Response) => void = () => {};
    const saved = {
      index: 0,
      suffix: "12345",
      status: "ok",
      error: null,
      checkedAt: null,
      rateLimitedUntil: null,
    };
    let stored = false;
    routes["GET /api/config/pool-keys"] = () =>
      json({ ...EMPTY_POOL("OPENROUTER_API_KEY"), keys: stored ? [saved] : [] });
    routes["POST /api/config/pool-keys"] = () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    const view = await mount(<ProviderSetupPanel provider={openrouter} onOpenChange={() => {}} />);
    await settle();

    expect(text()).toContain("Get a key");
    expect(text()).toContain("openrouter.ai/settings/keys");
    expect(text()).toContain("OPENROUTER_API_KEY");
    const input = document.body.querySelector<HTMLInputElement>('input[type="password"]')!;
    await typeInto(input, OPENROUTER_KEY);
    await click(button("Add key"));
    await settle(2);

    // The live probe runs on the server: the button says so until it answers.
    expect(text()).toContain("Checking the key…");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      key: "OPENROUTER_API_KEY",
      value: OPENROUTER_KEY,
    });

    stored = true;
    await act(async () => {
      finish(
        json({
          key: "OPENROUTER_API_KEY",
          source: "stored",
          readOnly: false,
          keys: [saved],
          checks: [{ suffix: "12345", result: "verified", httpStatus: 200, error: null }],
        }),
      );
    });
    await settle();
    expect(text()).toContain("The key ending 12345 works.");
    expect(text()).toContain("Key ending 12345");
    expect(input.value).toBe("");
    await view.cleanup();
  });

  test("a 422 shows the rejection inline and keeps the input", async () => {
    routes["GET /api/config/pool-keys"] = () => json(EMPTY_POOL("OPENROUTER_API_KEY"));
    routes["POST /api/config/pool-keys"] = () =>
      json(
        {
          error: "OpenRouter rejected the key ending 12345 (HTTP 401). Nothing was saved.",
          checks: [{ suffix: "12345", result: "rejected", httpStatus: 401, error: "HTTP 401" }],
        },
        422,
      );
    const view = await mount(<ProviderSetupPanel provider={openrouter} onOpenChange={() => {}} />);
    await settle();
    const input = document.body.querySelector<HTMLInputElement>('input[type="password"]')!;
    await typeInto(input, OPENROUTER_KEY);
    await click(button("Add key"));
    await settle();

    expect(text()).toContain(
      "OpenRouter rejected the key ending 12345 (HTTP 401). Nothing was saved.",
    );
    expect(input.value).toBe(OPENROUTER_KEY);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await view.cleanup();
  });
});

describe("ProviderSetupPanel: plain config fields", () => {
  const bedrock = findAiProvider("bedrock")!;
  const row = (key: string, value: string) => ({
    id: `cfg-${key}`,
    scope: "global",
    scopeId: null,
    key,
    value,
    isSecret: false,
    envPath: null,
    description: null,
    createdAt: "2026-11-04T00:00:00.000Z",
    lastUpdatedAt: "2026-11-04T00:00:00.000Z",
    encrypted: false,
    exportToEnv: true,
  });

  test("clearing a stored text value and saving deletes it", async () => {
    routes["GET /api/config"] = () =>
      json({
        configs: [row("AWS_REGION", "us-east-1"), row("MODEL_OVERRIDE", "amazon-bedrock/x")],
      });
    routes["DELETE /api/config/cfg-MODEL_OVERRIDE"] = () => json({ success: true });
    const view = await mount(<ProviderSetupPanel provider={bedrock} onOpenChange={() => {}} />);
    await settle();
    const inputs = Array.from(document.body.querySelectorAll<HTMLInputElement>("input"));
    const model = inputs.find((i) => i.value === "amazon-bedrock/x")!;
    expect(button("Save").disabled).toBe(true);
    await typeInto(model, "");
    expect(button("Save").disabled).toBe(false);
    await click(button("Save"));
    await settle();

    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "/api/config/cfg-MODEL_OVERRIDE",
    ]);
    expect(calls.some((c) => c.method === "PUT" || c.method === "POST")).toBe(false);
    expect(text()).toContain("Saved. Workers use it on their next task.");
    await view.cleanup();
  });
});

describe("ProviderSetupPanel: Codex device sign-in", () => {
  const codex = findAiProvider("codex")!;
  const start = {
    flowId: "flow-1",
    userCode: "ABCD-1234",
    verificationUrl: "https://auth.openai.com/codex/device",
    intervalSeconds: 5,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };

  test("names the harnesses, shows the code and the link, polls, then lists the account", async () => {
    let polls = 0;
    let linked = false;
    routes["GET /api/codex-oauth/accounts"] = () =>
      json({
        accounts: linked
          ? [
              {
                slot: 2,
                configKey: "codex_oauth_2",
                legacy: false,
                suffix: "zz123",
                plan: "pro",
                email: "ops@acme.dev",
                status: "ok",
              },
            ]
          : [],
      });
    routes["POST /api/codex-oauth/device"] = () => json(start);
    // Never resolves on its own: the test steps the poll by hand.
    let answerPoll: (r: Response) => void = () => {};
    routes["POST /api/codex-oauth/device/flow-1/poll"] = () => {
      polls += 1;
      return new Promise<Response>((resolve) => {
        answerPoll = resolve;
      });
    };
    const view = await mount(<ProviderSetupPanel provider={codex} onOpenChange={() => {}} />);
    await settle();
    expect(text()).toContain("serves the codex and pi harnesses");
    expect(text()).not.toContain("opencode");

    await click(button("Sign in with ChatGPT"));
    await settle();
    expect(text()).toContain("ABCD-1234");
    const link = document.body.querySelector<HTMLAnchorElement>(
      'a[href="https://auth.openai.com/codex/device"]',
    );
    expect(link?.target).toBe("_blank");
    expect(text()).toContain("Waiting for you to approve in ChatGPT…");

    // Still pending: the panel keeps polling.
    await act(async () => answerPoll(json({ status: "pending" })));
    await settle();
    expect(polls).toBe(2);
    expect(text()).toContain("ABCD-1234");

    linked = true;
    await act(async () => answerPoll(json({ status: "complete", slot: 2 })));
    await settle();
    expect(text()).toContain("Signed in. The account joined the pool as slot 2.");
    expect(text()).toContain("ChatGPT account ending zz123");
    await view.cleanup();
  });

  test("an expired code says so and offers a new sign-in", async () => {
    routes["GET /api/codex-oauth/accounts"] = () => json({ accounts: [] });
    routes["POST /api/codex-oauth/device"] = () => json(start);
    routes["POST /api/codex-oauth/device/flow-1/poll"] = () => json({ status: "expired" });
    const view = await mount(<ProviderSetupPanel provider={codex} onOpenChange={() => {}} />);
    await settle();
    await click(button("Sign in with ChatGPT"));
    await settle();

    expect(text()).toContain(CODEX_EXPIRED_MESSAGE);
    expect(button("Try again")).toBeTruthy();
    expect(text()).not.toContain("ABCD-1234");
    await view.cleanup();
  });
});

// ─── Remove from the key row menu ───────────────────────────────────────────

async function openMenuAndRemove(label: string, confirm: string) {
  const trigger = button(`Actions for ${label}`);
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle(2);
  const item = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
    (el) => el.textContent === "Remove",
  ) as HTMLElement | undefined;
  if (!item) throw new Error(`no Remove item in: ${text()}`);
  await click(item);
  await settle(2);
  // The confirm dialog: nothing is deleted before the click.
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await click(button(confirm));
  await settle();
}

function providerKey(keyType: string, index: number, suffix: string | null, label: string) {
  return {
    id: `${keyType}:${index}`,
    keyType,
    suffix,
    index,
    label,
    name: null,
    health: "ok" as const,
    reason: null,
    rateLimitedUntil: null,
    lastUsedAt: null,
    plan: null,
    planSource: null,
    planRaw: null,
    costToday: 0,
    cost7d: 0,
    status: null as ApiKeyStatus | null,
    statuses: [] as ApiKeyStatus[],
  };
}

describe("PoolKeyRow: usage limits", () => {
  const realNow = Date.now;
  const realSetInterval = window.setInterval;
  afterEach(() => {
    Date.now = realNow;
    window.setInterval = realSetInterval;
  });

  function claudeStatus(nowMs: number, extra: Partial<ApiKeyStatus> = {}): ApiKeyStatus {
    const at = (ms: number) => Math.floor(ms / 1000);
    return {
      id: "status-global",
      keyType: "CLAUDE_CODE_OAUTH_TOKEN",
      keySuffix: "a91f2",
      scope: "global",
      scopeId: null,
      provider: "claude",
      rateLimitWindows: {
        five_hour: {
          status: "allowed",
          utilization: 0.62,
          resetsAt: at(nowMs + 30_000),
          lastSeenAt: new Date(nowMs - 60_000).toISOString(),
        },
        seven_day: {
          status: "allowed",
          utilization: 0.41,
          resetsAt: at(nowMs + 50 * 3_600_000),
          lastSeenAt: new Date(nowMs - 60_000).toISOString(),
        },
      },
      modelLimits: [
        {
          model: "fable",
          window: "seven_day_overage_included",
          resetsAt: at(nowMs + 3_600_000),
          resetsAtIso: "",
          active: true,
        },
        {
          model: "opus",
          window: "seven_day_opus",
          resetsAt: at(nowMs + 3_600_000),
          resetsAtIso: "",
          active: false,
        },
      ],
      ...extra,
    } as unknown as ApiKeyStatus;
  }

  test("hides a window at its reset on the next clock tick, with no new response", async () => {
    let now = Date.parse("2026-11-08T12:00:00Z");
    Date.now = () => now;
    const ticks: Array<() => void> = [];
    window.setInterval = ((fn: () => void, ms?: number) => {
      if (ms === 60_000) ticks.push(fn);
      return 0;
    }) as typeof window.setInterval;
    const status = claudeStatus(now);
    const view = await mount(
      <ul>
        <PoolKeyRow
          provider={findAiProvider("claude")!}
          poolKey={{
            ...providerKey("CLAUDE_CODE_OAUTH_TOKEN", 0, "a91f2", "team-max"),
            status,
            statuses: [status],
          }}
          readOnly={false}
        />
      </ul>,
    );
    expect(text()).toContain("5 h");
    expect(text()).toContain("62%");
    expect(text()).toContain("Fable limit, resets");
    expect(text()).not.toContain("Opus limit");
    expect(ticks.length).toBeGreaterThan(0);

    now += 31_000;
    await act(async () => {
      for (const tick of ticks) tick();
    });
    expect(text()).not.toContain("5 h");
    expect(text()).not.toContain("62%");
    expect(text()).toContain("7 d");
    expect(text()).toContain("41%");
    // No status or usage request refreshed the row: the clock alone hid the window.
    expect(calls.map((c) => c.path)).toEqual(["/api/keys/plans"]);
    await view.cleanup();
  });

  test("Claude credit rejection stays separate from its included usage", async () => {
    const now = Date.now();
    const status = claudeStatus(now, {
      rateLimitWindows: {
        seven_day: {
          status: "allowed",
          utilization: 0.5,
          lastSeenAt: new Date(now).toISOString(),
          resetsAt: Math.floor(now / 1000) + 3600,
          overageStatus: "rejected",
          overageDisabledReason: "group_zero_credit_limit",
          isUsingOverage: false,
        },
      },
      modelLimits: [],
    });
    const view = await mount(
      <ul>
        <PoolKeyRow
          provider={findAiProvider("claude")!}
          poolKey={{
            ...providerKey("CLAUDE_CODE_OAUTH_TOKEN", 0, "a91f2", "claude-credit-test"),
            status,
            statuses: [status],
          }}
          readOnly={false}
        />
      </ul>,
    );
    expect(text()).toContain("50%");
    expect(text()).toContain("Usage credits: rejected · group zero credit limit · not in use");
    await click(button("Limits and usage for claude-credit-test"));
    await settle();
    const detail = document.querySelector(
      'section[aria-label="claude-credit-test limits and usage"]',
    );
    expect(detail?.textContent).toContain(
      "Usage credits: rejected · group zero credit limit · not in use",
    );
    expect(detail?.textContent).not.toContain("Limit reached");
    await view.cleanup();
  });

  test("a key with no current window says so instead of showing 0%", async () => {
    const now = Date.now();
    const status = claudeStatus(now, {
      rateLimitWindows: {
        five_hour: {
          status: "allowed",
          utilization: 0.87,
          resetsAt: Math.floor((now - 187 * 3_600_000) / 1000),
          lastSeenAt: new Date(now - 192 * 3_600_000).toISOString(),
        },
      },
      modelLimits: [],
    });
    const view = await mount(
      <ul>
        <PoolKeyRow
          provider={findAiProvider("claude")!}
          poolKey={{
            ...providerKey("CLAUDE_CODE_OAUTH_TOKEN", 0, "a91f2", "team-max"),
            status,
            statuses: [status],
          }}
          readOnly={false}
        />
      </ul>,
    );
    expect(text()).toContain("No current limit data");
    expect(text()).not.toContain("87%");
    expect(text()).not.toContain("0%");
    await view.cleanup();
  });

  test("expands account details and joins Swarm usage by status row and window", async () => {
    let now = Date.now();
    Date.now = () => now;
    const ticks: Array<() => void> = [];
    window.setInterval = ((fn: () => void, ms?: number) => {
      if (ms === 60_000) ticks.push(fn);
      return 0;
    }) as typeof window.setInterval;
    const at = (ms: number) => Math.floor(ms / 1000);
    const seen = new Date(now - 4 * 60_000).toISOString();
    const creditsAt = new Date(now - 2 * 3_600_000).toISOString();
    const global = {
      id: "codex-global",
      keyType: "CODEX_OAUTH",
      keySuffix: "11x11-1",
      scope: "global",
      scopeId: null,
      provider: "codex",
      plan: null,
      planSource: null,
      detectedPlanRaw: null,
      modelLimits: [],
      rateLimitWindows: {
        "codex:codex:primary": {
          source: "codex",
          limitId: "codex",
          status: "allowed",
          utilization: 0.58,
          durationMins: 10080,
          resetsAt: at(now + 48 * 3_600_000),
          lastSeenAt: seen,
        },
      },
      providerAccount: {
        source: "codex",
        observedAt: seen,
        ordinaryUsageAllowed: true,
        limits: {
          codex: {
            observedAt: seen,
            fieldObservedAt: { credits: creditsAt, spend: creditsAt },
            planRaw: "promax",
            credits: { hasCredits: true, unlimited: false, balance: "125.50" },
            spend: { limit: "80", used: "20", remainingPercent: 75, resetsAt: at(now + 3_600_000) },
            spendControlReached: true,
            reachedType: "workspace_member_usage_limit_reached",
          },
        },
      },
    } as unknown as ApiKeyStatus;
    // An older agent row reports the same window: it must not show twice.
    const agent = {
      ...global,
      id: "codex-agent",
      scope: "agent",
      scopeId: "agent-1",
      providerAccount: null,
      rateLimitWindows: {
        "codex:codex:primary": {
          ...global.rateLimitWindows["codex:codex:primary"]!,
          utilization: 0.4,
          lastSeenAt: new Date(now - 60 * 60_000).toISOString(),
        },
      },
    } as ApiKeyStatus;
    const counter = (value: number | null, measured: number, missing: number) => ({
      value,
      measuredSessions: measured,
      missingSessions: missing,
    });
    const usageWindow = (statusId: string, sessions: number) => ({
      statusId,
      keyType: "CODEX_OAUTH",
      keySuffix: "11x11-1",
      scope: statusId === "codex-global" ? "global" : "agent",
      scopeId: null,
      windowKey: "codex:codex:primary",
      durationMins: 10080,
      startsAt: new Date(now - 5 * 24 * 3_600_000).toISOString(),
      endsAt: new Date(now + 48 * 3_600_000).toISOString(),
      dataThrough: new Date(now).toISOString(),
      observedAt: seen,
      observationAgeMs: 240_000,
      modelScope: { kind: "account", model: null },
      unavailableReason: null,
      usage: {
        sessions,
        errorSessions: 1,
        completedTasks: 2,
        tokens: {
          uncachedInput: counter(4000, 3, 0),
          output: counter(1800, 3, 0),
          cacheRead: counter(6000, 3, 0),
          cacheWrite: counter(6000, 2, 1),
          reasoning: counter(300, 3, 0),
          thinking: counter(null, 0, 3),
        },
        modelUnattributedSessions: 0,
        swarmUnattributedSessions: 4,
      },
    });
    routes["GET /api/keys/window-usage"] = () =>
      json({
        success: true,
        asOf: new Date(now).toISOString(),
        accounting: "session_cost_receipt_time",
        windows: [usageWindow("codex-agent", 99), usageWindow("codex-global", 3)],
      });
    routes["GET /api/keys/plans"] = () => json({ checkedAt: "2026-11-08", plans: [] });
    const view = await mount(
      <ul>
        <PoolKeyRow
          provider={findAiProvider("codex")!}
          poolKey={{
            ...providerKey("CODEX_OAUTH", 1, "11x11-1", "codex-credits@example.test"),
            planRaw: "promax",
            status: global,
            statuses: [global, agent],
          }}
          readOnly={false}
        />
      </ul>,
    );
    await settle();
    expect(text()).toContain("ChatGPT Pro");
    expect(text()).toContain("Price tier unknown");
    expect(text()).toContain("58%");
    expect(text()).not.toContain("40%");
    expect(calls.some((c) => c.path === "/api/keys/window-usage")).toBe(false);

    const toggle = button("Limits and usage for codex-credits@example.test");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    await settle();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const request = calls.find((c) => c.path === "/api/keys/window-usage");
    expect(request?.search).toBe("?keyType=CODEX_OAUTH&keySuffix=11x11-1");
    const body = text();
    expect(body).toContain("7 d58% used");
    expect(body).toContain("Swarm runs: 3 sessions (1 with errors), 2 tasks completed");
    expect(body).not.toContain("99 sessions");
    expect(body).toContain("6.0K (2 of 3 sessions)");
    expect(body).toContain("ThinkingNot reported");
    expect(body).toContain("Across the swarm, 4 sessions in this period reported no credential.");
    expect(body).toContain("Balance 125.50");
    expect(body).toContain("75% left, 20 of 80 used (provider units)");
    expect(body).not.toContain("$80");
    expect(body).toContain("reported 2 hours ago");
    expect(body).toContain("Spend cap reachedYes");
    expect(body).toContain("Blocked byworkspace member usage limit reached");
    now += 3_600_000;
    await act(async () => {
      for (const tick of ticks) tick();
    });
    expect(text()).toContain("Period reset");
    expect(text()).toContain("no newer report");
    expect(text()).not.toContain("75% left");
    expect(text()).toContain("Spend cap reachedPrevious period, current state unknown");
    expect(text()).toContain("Blocked byPrevious period, current state unknown");
    expect(text()).toContain("Balance 125.50");
    await view.cleanup();
  });
});

describe("PoolKeyRow: Remove", () => {
  test("a pool key confirms, then deletes that pool member", async () => {
    routes["DELETE /api/config/pool-keys"] = () => json(EMPTY_POOL("DEEPSEEK_API_KEY"));
    const view = await mount(
      <ul>
        <PoolKeyRow
          provider={findAiProvider("deepseek")!}
          poolKey={providerKey("DEEPSEEK_API_KEY", 1, "4f1cc", "Key ending 4f1cc")}
          readOnly={false}
        />
      </ul>,
    );
    await openMenuAndRemove("Key ending 4f1cc", "Remove key");
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.path).toBe("/api/config/pool-keys");
    expect(Object.fromEntries(new URLSearchParams(del?.search))).toEqual({
      key: "DEEPSEEK_API_KEY",
      index: "1",
      suffix: "4f1cc",
    });
    await view.cleanup();
  });

  test("a ChatGPT account confirms, then deletes its slot", async () => {
    routes["DELETE /api/codex-oauth/accounts/3"] = () => json({ accounts: [] });
    const view = await mount(
      <ul>
        <PoolKeyRow
          provider={findAiProvider("codex")!}
          poolKey={providerKey("CODEX_OAUTH", 3, "zz123", "ops@acme.dev")}
          readOnly={false}
        />
      </ul>,
    );
    await openMenuAndRemove("ops@acme.dev", "Remove account");
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "/api/codex-oauth/accounts/3",
    ]);
    await view.cleanup();
  });

  test("an env-only pool has no Remove", async () => {
    const view = await mount(
      <ul>
        <PoolKeyRow
          provider={findAiProvider("deepseek")!}
          poolKey={providerKey("DEEPSEEK_API_KEY", 0, "4f1cc", "Key ending 4f1cc")}
          readOnly
        />
      </ul>,
    );
    expect(document.body.querySelector('[aria-label="Actions for Key ending 4f1cc"]')).toBeNull();
    await view.cleanup();
  });
});
