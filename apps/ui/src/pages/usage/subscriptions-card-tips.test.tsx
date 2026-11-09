import { afterAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect } from "react";
import type { SubscriptionPlansResponse, UsageSummaryByCredentialRow } from "../../api/types";

// A DOM for the click tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
// react-dom reads the DOM when it first loads: import it after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));

// `bun test` does not read vite's `@/` alias: map every specifier to its real
// file, except the key hooks, which return fixed data.
const STUBBED = "@/api/hooks/use-api-keys";
const SRC = join(import.meta.dir, "../..");
let stubbedFile = "";
for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
  if (/\.test\.tsx?$/.test(file)) continue;
  const specifier = `@/${file.replace(/\.tsx?$/, "").replace(/\/index$/, "")}`;
  if (specifier === STUBBED) {
    stubbedFile = join(SRC, file);
    continue;
  }
  mock.module(specifier, async () => await import(join(SRC, file)));
}
const realHooks = await import(stubbedFile);
const CATALOG: SubscriptionPlansResponse = {
  checkedAt: "2026-09-25",
  plans: [
    {
      id: "claude_max_20x",
      label: "Claude Max 20x",
      keyType: "CLAUDE_CODE_OAUTH_TOKEN",
      monthlyUsd: 200,
    },
  ],
};
mock.module(STUBBED, () => ({
  ...realHooks,
  useSubscriptionPlans: () => ({ data: CATALOG, isLoading: false }),
  useApiKeyStatuses: () => ({ data: [] }),
  useSetApiKeyPlan: () => ({ mutate: () => {}, isPending: false }),
}));

const { SubscriptionsCard } = await import("./subscriptions-card");
const { TooltipProvider } = await import("../../components/ui/tooltip");

const DAY_MS = 24 * 60 * 60 * 1000;

function row(over: Partial<UsageSummaryByCredentialRow>): UsageSummaryByCredentialRow {
  return {
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    keySuffix: "1LAAA",
    name: null,
    subscription: true,
    plan: "claude_max_20x",
    planSource: "manual",
    costUsd: 5000,
    inputTokens: 0,
    outputTokens: 0,
    sessions: 3,
    firstSessionAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
    lastSessionAt: new Date().toISOString(),
    ...over,
  };
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <TooltipProvider>
          <SubscriptionsCard
            rows={[
              row({}),
              row({ keySuffix: "D4wAA", plan: null, planSource: null }),
              row({
                keyType: null,
                keySuffix: null,
                subscription: false,
                plan: null,
                planSource: null,
              }),
            ]}
            windowStartMs={Date.now() - 2 * DAY_MS}
            filtered
          />
        </TooltipProvider>
      </MemoryRouter>,
    );
  });
  return root;
}

const EXPLANATIONS: Array<[string, string]> = [
  ["How savings are counted", "prorated per day"],
  ["About 1 without a plan", "Its savings are not counted"],
  ["About Filter on", "plan costs are for the whole credential"],
  ["About unattributed spend", "reported no credential"],
];

describe("SubscriptionsCard explanations", () => {
  test.each(
    EXPLANATIONS,
  )("%s opens from a focusable trigger on click or tap", async (label, text) => {
    const root = await mount();
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(trigger).not.toBeNull();
    // Keyboard: a real button in the tab order.
    expect(trigger?.getAttribute("tabindex")).not.toBe("-1");
    expect(document.body.textContent).not.toContain(text);
    // Click and tap both fire `click`; a hover-only tooltip would stay shut.
    await act(async () => trigger?.click());
    expect(document.body.textContent).toContain(text);
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });
});
