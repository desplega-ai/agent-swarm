import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SubscriptionPlansResponse, UsageSummaryByCredentialRow } from "../../api/types";

// `bun test` does not read vite's `@/` alias: map every specifier to its real
// file, except the key hooks, which read the state each test sets.
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
// Spread the real module so a later file in the same process finds every export.
const realHooks = await import(stubbedFile);

let plans: { data: SubscriptionPlansResponse | undefined; isLoading: boolean } = {
  data: undefined,
  isLoading: true,
};
mock.module(STUBBED, () => ({
  ...realHooks,
  useSubscriptionPlans: () => plans,
  useApiKeyStatuses: () => ({ data: [] }),
  useSetApiKeyPlan: () => ({ mutate: () => {}, isPending: false }),
}));

const { SubscriptionsCard } = await import("./subscriptions-card");
const { TooltipProvider } = await import("../../components/ui/tooltip");

const DAY_MS = 24 * 60 * 60 * 1000;
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

function row(costUsd: number): UsageSummaryByCredentialRow {
  return {
    keyType: "CLAUDE_CODE_OAUTH_TOKEN",
    keySuffix: "1LAAA",
    name: null,
    subscription: true,
    plan: "claude_max_20x",
    planSource: "manual",
    costUsd,
    inputTokens: 0,
    outputTokens: 0,
    sessions: 3,
    firstSessionAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
    lastSessionAt: new Date().toISOString(),
  };
}

function render(costUsd: number) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <SubscriptionsCard
          rows={[row(costUsd)]}
          windowStartMs={Date.now() - 2 * DAY_MS}
          filtered={false}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("SubscriptionsCard", () => {
  test("shows a skeleton, not a headline, until the plan prices load", () => {
    plans = { data: undefined, isLoading: true };
    const html = render(5000);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Saved");
    expect(html).not.toContain("Pick a plan");
  });

  test("a saving reads green", () => {
    plans = { data: CATALOG, isLoading: false };
    const html = render(5000);
    expect(html).toMatch(/text-status-success-strong">\$4,9\d\d</);
    expect(html).not.toContain("text-status-error-strong");
  });

  test("plans costing more than the API value read red, with a minus sign", () => {
    plans = { data: CATALOG, isLoading: false };
    // Two days of a $200 plan cost about $13, more than $1.45 of runs.
    const html = render(1.45);
    expect(html).toMatch(/text-status-error-strong">-\$1[12]\.\d\d</);
    expect(html).toContain("plans cost more");
  });
});
