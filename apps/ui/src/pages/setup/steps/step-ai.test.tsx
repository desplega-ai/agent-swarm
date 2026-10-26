import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { act, useEffect, useLayoutEffect } from "react";
import type { AgentWithTasks, ModelTierPreview, OnboardingResponse } from "../../../api/types";
import { tierRows } from "../../../lib/model-tier-fixtures";

// A DOM for the render tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

let agents: AgentWithTasks[] = [];
let tiers: ModelTierPreview[] | undefined;
let presenceFetching = false;
const harnessCalls: Array<[string, string]> = [];

mock.module("@/api/client", () => ({
  api: {
    updateAgentRuntime: async () => {},
    setAgentHarnessProvider: async (id: string, harness: string) => {
      harnessCalls.push([id, harness]);
    },
  },
}));
// Mocks of shared modules keep every export of the real module: in one `bun test`
// process the first file to register a specifier fixes its export names, and a
// later file importing another name fails to link.
mock.module("@/lib/config", () => require("../../../lib/config"));
mock.module("@/api/hooks/use-agents", () => ({
  ...require("../../../api/hooks/use-agents"),
  useAgents: () => ({ data: agents }),
}));
mock.module("@/api/hooks/use-config-api", () => ({
  ...require("../../../api/hooks/use-config-api"),
  useConfigs: () => ({ data: [], isFetching: false }),
  // No agent-scope model: the switch changes only the harness.
  resolvedConfigsQuery: (filters: { agentId: string }) =>
    queryOptions({
      queryKey: ["configs", "resolved", filters],
      queryFn: async () => ({ configs: [] }),
    }),
}));
mock.module("@/api/hooks/use-integrations-meta", () => ({
  useEnvPresence: () => ({ data: {}, isFetching: presenceFetching }),
}));
mock.module("@/api/hooks/use-model-tiers", () => ({
  useModelTiers: () => ({ data: tiers, isError: false }),
}));
mock.module("@/api/hooks/use-models-catalog", () => ({
  useModelsCatalog: () => ({ data: undefined }),
}));
mock.module("@/components/onboarding/onboarding-redirect", () => ({
  markSetupVisited: () => {},
  wasSetupVisited: () => false,
  setupExitHref: (path: string) => path,
  OnboardingRedirect: () => null,
}));
for (const [alias, path] of [
  ["@/api/types", "../../../api/types"],
  ["@/api/hooks/use-onboarding", "../../../api/hooks/use-onboarding"],
  ["@/hooks/use-autosave", "../../../hooks/use-autosave"],
  ["@/lib/utils", "../../../lib/utils"],
  ["@/lib/agent-runtime-models", "../../../lib/agent-runtime-models"],
  ["@/lib/model-dial", "../../../lib/model-dial"],
  ["@/components/ui/badge", "../../../components/ui/badge"],
  ["@/components/ui/button", "../../../components/ui/button"],
  ["@/components/ui/select", "../../../components/ui/select"],
  ["@/components/ui/spinner", "../../../components/ui/spinner"],
  ["@/components/kibo-ui/spinner", "../../../components/kibo-ui/spinner"],
  ["@/components/shared/harness-icon", "../../../components/shared/harness-icon"],
  ["@/components/shared/setup-chip", "../../../components/shared/setup-chip"],
] as const) {
  mock.module(alias, () => require(path));
}

interface CardStubProps {
  onSaved: (method: string) => void;
  reportSaved: (card: string, saved: boolean) => void;
}

// The cards are stubs: each reports the saved state in `savedState` (nothing
// saved by default, like a card on a fresh swarm). The open harnesses card
// hands out its `onSaved`, which a key save calls.
const savedState: Record<string, boolean> = {};
let saveOpenKey: CardStubProps["onSaved"] = () => {};
function stubCard(card: string) {
  return function Card({ onSaved, reportSaved }: CardStubProps) {
    const saved = savedState[card] ?? false;
    useEffect(() => reportSaved(card, saved), [reportSaved, saved]);
    if (card === "open") saveOpenKey = onSaved;
    return null;
  };
}
mock.module("./ai/claude-card", () => ({ ClaudeCard: stubCard("claude") }));
mock.module("./ai/codex-card", () => ({ CodexCard: stubCard("codex") }));
mock.module("./ai/open-harness-card", () => ({ OpenHarnessCard: stubCard("open") }));
mock.module("./ai/devin-card", () => ({ DevinCard: stubCard("devin") }));

const { StepAi } = await import("./step-ai");

const onboarding = {
  state: { steps: { ai: { status: "pending", at: null, method: null, errorClass: null } } },
  signals: { providers: [] },
} as unknown as OnboardingResponse;

/** `--preset full`: 1 lead and 10 workers, all on Claude. */
const fleet = [
  { id: "lead", name: "lead", isLead: true },
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `worker-${i + 1}`,
    name: `worker-${i + 1}`,
    isLead: false,
  })),
].map((a) => ({ ...a, status: "idle", harnessProvider: "claude" }) as unknown as AgentWithTasks);

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StepAi
          onboarding={onboarding}
          act={async () => onboarding}
          setContinueBlocker={() => {}}
          setContinueAction={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => root.render(element()));
  const rerender = () => act(async () => root.render(element()));
  return {
    rerender,
    /** An OpenRouter key save: the card marks the key saved, then calls `onSaved`. */
    saveKey: async () => {
      savedState.open = true;
      await act(async () => saveOpenKey("openrouter"));
      await rerender();
      await settle();
    },
    /** The last key goes: the card header shows nothing saved. */
    removeKey: async () => {
      savedState.open = false;
      await rerender();
    },
    unmount: () => act(async () => root.unmount()),
  };
}

const onPi = fleet.map((a) => [a.id, "pi"]);

beforeEach(() => {
  for (const card of Object.keys(savedState)) delete savedState[card];
  agents = fleet;
  tiers = tierRows();
  presenceFetching = false;
  harnessCalls.length = 0;
  document.body.innerHTML = "";
});

describe("StepAi: the switch on the first credential", () => {
  test("a fresh full swarm: an OpenRouter key moves the lead and all 10 workers to Pi-Mono", async () => {
    const view = await mount();
    await view.saveKey();
    expect(harnessCalls).toEqual(onPi);
    await view.unmount();
  });

  test("a save while the tier models load switches when they arrive", async () => {
    tiers = undefined;
    const view = await mount();
    await view.saveKey();
    expect(harnessCalls).toEqual([]);
    tiers = tierRows();
    await view.rerender();
    await settle();
    expect(harnessCalls).toEqual(onPi);
    await view.unmount();
  });

  test("a card that loads with a key: another key keeps every agent where it is", async () => {
    savedState.open = true;
    const view = await mount();
    await view.saveKey();
    expect(harnessCalls).toEqual([]);
    await view.unmount();
  });

  test("a second key after the agents moved back to Claude keeps them on Claude", async () => {
    const view = await mount();
    await view.saveKey();
    expect(harnessCalls).toEqual(onPi);
    harnessCalls.length = 0;
    agents = fleet.map((a) => ({ ...a }));
    await view.rerender();
    await view.saveKey();
    expect(harnessCalls).toEqual([]);
    await view.unmount();
  });

  test("a key removed while the tier models load drops the queued switch", async () => {
    tiers = undefined;
    const view = await mount();
    await view.saveKey();
    await view.removeKey();
    tiers = tierRows();
    await view.rerender();
    await settle();
    expect(harnessCalls).toEqual([]);
    await view.unmount();
  });

  test("a card that shows no key only while env presence loads does not arm", async () => {
    // Restored cache data shows no key while the fetch runs; the fetch finds one.
    presenceFetching = true;
    const view = await mount();
    presenceFetching = false;
    savedState.open = true;
    await view.rerender();
    await view.saveKey();
    expect(harnessCalls).toEqual([]);
    await view.unmount();
  });

  test("a new key after the last one went is a first credential again", async () => {
    savedState.open = true;
    const view = await mount();
    await view.removeKey();
    await view.saveKey();
    expect(harnessCalls).toEqual(onPi);
    await view.unmount();
  });
});
