import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { act, useLayoutEffect } from "react";
import type { AgentWithTasks, ModelTierPreview } from "../../../../api/types";
import { tierRows } from "../../../../lib/model-tier-fixtures";

// A DOM for the click tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists
// (a static import would load it first and leave later files without events).
const { createRoot } = await import("react-dom/client");
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const runtimeCalls: Array<Record<string, unknown>> = [];
const harnessCalls: Array<[string, string]> = [];
let storedConfigs: Array<{ key: string; value: string; scope: string }> = [];
mock.module("@/api/client", () => ({
  api: {
    updateAgentRuntime: async (input: Record<string, unknown>) => {
      runtimeCalls.push(input);
    },
    setAgentHarnessProvider: async (id: string, harness: string) => {
      harnessCalls.push([id, harness]);
    },
  },
}));
// Mocks of shared modules keep every export of the real module: in one `bun test`
// process the first file to register a specifier fixes its export names, and a
// later file importing another name fails to link.
// The real hook modules import the API client, which reads `@/lib/config`.
mock.module("@/lib/config", () => require("../../../../lib/config"));
mock.module("@/api/hooks/use-config-api", () => ({
  ...require("../../../../api/hooks/use-config-api"),
  resolvedConfigsQuery: (filters: { agentId: string }) =>
    queryOptions({
      queryKey: ["configs", "resolved", filters],
      queryFn: async () => ({ configs: storedConfigs }),
    }),
}));
mock.module("@/api/hooks/use-onboarding", () => require("../../../../api/hooks/use-onboarding"));
mock.module("@/api/types", () => require("../../../../api/types"));
mock.module("@/lib/utils", () => require("../../../../lib/utils"));
mock.module("@/components/ui/spinner", () => require("../../../../components/ui/spinner"));
mock.module("@/components/kibo-ui/spinner", () =>
  require("../../../../components/kibo-ui/spinner"),
);
mock.module("@/components/onboarding/setup-card", () =>
  require("../../../../components/onboarding/setup-card"),
);
mock.module("@/components/shared/animated-reveal", () =>
  require("../../../../components/shared/animated-reveal"),
);
mock.module("@/components/shared/harness-icon", () =>
  require("../../../../components/shared/harness-icon"),
);
mock.module("@/components/shared/status-icon", () =>
  require("../../../../components/shared/status-icon"),
);
mock.module("@/components/ui/badge", () => require("../../../../components/ui/badge"));
mock.module("@/components/ui/button", () => require("../../../../components/ui/button"));
mock.module("@/components/ui/select", () => require("../../../../components/ui/select"));
mock.module("@/components/ui/tooltip", () => require("../../../../components/ui/tooltip"));
mock.module("@/lib/agent-runtime-models", () => require("../../../../lib/agent-runtime-models"));
mock.module("@/lib/model-dial", () => require("../../../../lib/model-dial"));

const { HarnessSwitch } = await import("./harness-switch");
const { TooltipProvider } = await import("../../../../components/ui/tooltip");

const agent = {
  id: "agent-1",
  name: "Worker",
  isLead: false,
  status: "idle",
  harnessProvider: "claude",
  createdAt: "",
  lastUpdatedAt: "",
} as unknown as AgentWithTasks;

async function mount(tiers: readonly ModelTierPreview[] | null, targets: string[] = ["codex"]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <HarnessSwitch
            harnessPhrase="Codex"
            targets={targets as never}
            agents={[agent]}
            dialContext={{ openrouter: false, catalog: null, tiers }}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  return { container, unmount: () => act(async () => root.unmount()) };
}

const switchButton = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.includes("Switch") || b.textContent?.includes("Loading model tiers"),
  );

async function switchAgent(container: HTMLElement) {
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
  });
  await act(async () => {
    switchButton(container)?.click();
  });
  // The switch awaits the agent's resolved config, then the write.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  runtimeCalls.length = 0;
  harnessCalls.length = 0;
  storedConfigs = [];
  document.body.innerHTML = "";
});

describe("HarnessSwitch", () => {
  test("waits for the model tiers: no switch before the level can carry over", async () => {
    const view = await mount(null);
    const button = switchButton(view.container);
    expect(button?.textContent).toContain("Loading model tiers");
    expect(button?.disabled).toBe(true);
    await view.unmount();
  });

  test("an agent on a dial level moves to the same level of the new harness", async () => {
    // Claude Optimal: the smart tier's Claude model at high effort.
    storedConfigs = [
      { key: "MODEL_OVERRIDE", value: "claude-opus-5-5", scope: "agent" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "high", scope: "agent" },
    ];
    const view = await mount(tierRows());
    await switchAgent(view.container);
    // Codex Optimal: the smart tier's Codex model, a valid effort for it.
    expect(runtimeCalls).toEqual([
      {
        id: "agent-1",
        harnessProvider: "codex",
        model: "gpt-5.6-sol",
        allowCustomModel: false,
        reasoningEffort: "high",
      },
    ]);
    expect(harnessCalls).toEqual([]);
    await view.unmount();
  });

  test("Max carries over with its own effort, and follows a retuned tier", async () => {
    storedConfigs = [
      { key: "MODEL_OVERRIDE", value: "claude-fable-5-1", scope: "agent" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "high", scope: "agent" },
    ];
    const view = await mount(tierRows({ "codex:ultra": "gpt-5.6-terra" }));
    await switchAgent(view.container);
    expect(runtimeCalls).toEqual([
      {
        id: "agent-1",
        harnessProvider: "codex",
        model: "gpt-5.6-terra",
        allowCustomModel: false,
        reasoningEffort: "xhigh",
      },
    ]);
    await view.unmount();
  });

  test("a model outside the dial changes only the harness", async () => {
    storedConfigs = [{ key: "MODEL_OVERRIDE", value: "claude-haiku-4-5", scope: "agent" }];
    const view = await mount(tierRows());
    await switchAgent(view.container);
    expect(runtimeCalls).toEqual([]);
    expect(harnessCalls).toEqual([["agent-1", "codex"]]);
    await view.unmount();
  });

  test("a level whose tier has no model for the new harness changes only the harness", async () => {
    storedConfigs = [
      { key: "MODEL_OVERRIDE", value: "claude-opus-5-5", scope: "agent" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "high", scope: "agent" },
    ];
    const view = await mount(tierRows().filter((r) => r.provider !== "codex"));
    await switchAgent(view.container);
    expect(runtimeCalls).toEqual([]);
    expect(harnessCalls).toEqual([["agent-1", "codex"]]);
    await view.unmount();
  });
});
