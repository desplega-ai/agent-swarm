import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { MotionGlobalConfig } from "motion/react";
import { act, useLayoutEffect } from "react";
import type { AgentWithTasks, ModelTierPreview } from "../../../../api/types";
import { tierRows } from "../../../../lib/model-tier-fixtures";

// A DOM for the render tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists
// (a static import would load it first and leave later files without events).
const { createRoot } = await import("react-dom/client");
// happy-dom rejects a cancelled Web Animation, which motion does on unmount.
MotionGlobalConfig.skipAnimations = true;
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await GlobalRegistrator.unregister();
});

let tiers: ModelTierPreview[] | undefined;
let tiersError = false;
let storedConfigs: Array<{ key: string; value: string }> = [];
const writes: Array<Record<string, unknown>> = [];
const holds: Array<string | null> = [];
let continueAction: (() => Promise<void>) | null = null;
let tiersRefetches = 0;

mock.module("@/api/hooks/use-model-tiers", () => ({
  useModelTiers: () => ({
    data: tiers,
    isError: tiersError,
    isFetching: false,
    refetch: () => {
      tiersRefetches += 1;
    },
  }),
}));
mock.module("@/api/hooks/use-models-catalog", () => ({
  useModelsCatalog: () => ({ data: undefined }),
}));
// Mocks of shared modules keep every export of the real module: in one `bun test`
// process the first file to register a specifier fixes its export names, and a
// later file importing another name fails to link.
// The real hook modules import the API client, which reads `@/lib/config`.
mock.module("@/lib/config", () => require("../../../../lib/config"));
mock.module("@/api/hooks/use-agents", () => ({
  ...require("../../../../api/hooks/use-agents"),
  useUpdateAgentRuntime: () => ({
    mutateAsync: async (input: Record<string, unknown>) => {
      writes.push(input);
    },
  }),
}));
mock.module("@/api/hooks/use-config-api", () => ({
  ...require("../../../../api/hooks/use-config-api"),
  resolvedConfigsQuery: (filters: { agentId: string }) =>
    queryOptions({
      queryKey: ["configs", "resolved", filters],
      queryFn: async () => ({ configs: storedConfigs }),
      select: (data: { configs: typeof storedConfigs }) => data.configs,
    }),
}));
mock.module("@/hooks/use-autosave", () => ({
  ...require("../../../../hooks/use-autosave"),
  useAutosave: () => ({ phase: "idle", error: null }),
  useContinueHold: (reason: string | null) => {
    holds.push(reason);
  },
  useContinueAction: (
    setter: (action: (() => Promise<void>) | null) => void,
    action: (() => Promise<void>) | null,
  ) => {
    continueAction = action;
    void setter;
  },
}));
for (const [alias, path] of [
  ["@/api/types", "../../../../api/types"],
  ["@/lib/utils", "../../../../lib/utils"],
  ["@/lib/cost-format", "../../../../lib/cost-format"],
  ["@/lib/agent-runtime-models", "../../../../lib/agent-runtime-models"],
  ["@/lib/model-dial", "../../../../lib/model-dial"],
  ["@/lib/model-vendor", "../../../../lib/model-vendor"],
  ["@/components/onboarding/setup-card", "../../../../components/onboarding/setup-card"],
  ["@/components/shared/animated-reveal", "../../../../components/shared/animated-reveal"],
  ["@/components/shared/harness-icon", "../../../../components/shared/harness-icon"],
  ["@/components/shared/model-logo", "../../../../components/shared/model-logo"],
  [
    "@/components/shared/reasoning-effort-icon",
    "../../../../components/shared/reasoning-effort-icon",
  ],
  ["@/components/shared/status-icon", "../../../../components/shared/status-icon"],
  ["@/components/ui/badge", "../../../../components/ui/badge"],
  ["@/components/ui/segmented-control", "../../../../components/ui/segmented-control"],
  ["@/components/ui/skeleton", "../../../../components/ui/skeleton"],
  ["@/components/ui/tooltip", "../../../../components/ui/tooltip"],
] as const) {
  mock.module(alias, () => require(path));
}

const { AgentModels } = await import("./agent-models");
const { TooltipProvider } = await import("../../../../components/ui/tooltip");

const agent = (id: string, harnessProvider: string, isLead = false) =>
  ({
    id,
    name: `agent-${id}`,
    isLead,
    status: "idle",
    harnessProvider,
  }) as unknown as AgentWithTasks;

async function mount(agents: AgentWithTasks[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AgentModels
          agents={agents}
          agentsLoading={false}
          configs={[]}
          presence={{}}
          completed={null}
          onComplete={async () => {}}
          setContinueAction={() => {}}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  await act(async () => root.render(element()));
  // Let the per-agent config queries settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return {
    container,
    rerender: async () => {
      await act(async () => root.render(element()));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    },
    unmount: () => act(async () => root.unmount()),
  };
}

const tiles = (container: HTMLElement) =>
  [...container.querySelectorAll("fieldset button")].map((b) => b.textContent ?? "");

beforeEach(() => {
  tiers = tierRows();
  tiersError = false;
  storedConfigs = [];
  writes.length = 0;
  holds.length = 0;
  continueAction = null;
  tiersRefetches = 0;
  document.body.innerHTML = "";
});

describe("AgentModels reads the model tiers", () => {
  test("nothing shows or stores until the tiers load: Continue holds", async () => {
    tiers = undefined;
    const view = await mount([agent("1", "codex")]);
    expect(holds.at(-1)).toBe("Loading model tiers…");
    expect(tiles(view.container).every((t) => t.includes("Loading model tiers…"))).toBe(true);
    expect(view.container.textContent).not.toContain("Sol");
    expect(writes).toEqual([]);
    await view.unmount();
  });

  test("a level shows the model of its tier; codex Optimal and Max differ by effort", async () => {
    const view = await mount([agent("1", "codex")]);
    expect(holds.at(-1)).toBeNull();
    const [cheap, optimal, max] = tiles(view.container);
    expect(cheap).toContain("Terra");
    expect(cheap).toContain("Medium");
    expect(optimal).toContain("Sol");
    expect(optimal).toContain("High");
    // The smart and ultra tiers share a model: the effort tells them apart.
    expect(max).toContain("Sol");
    expect(max).toContain("X-High");
    await view.unmount();
  });

  test("a tier change changes the dial with no code change", async () => {
    const view = await mount([agent("1", "codex")]);
    expect(tiles(view.container)[1]).toContain("Sol");
    tiers = tierRows({ "codex:smart": "gpt-5.6-luna" });
    await view.rerender();
    expect(tiles(view.container)[1]).toContain("Luna");
    await view.unmount();
  });

  test("a level with no model for the harness says so, and Continue does not guess", async () => {
    tiers = tierRows().filter((row) => row.provider !== "codex");
    const view = await mount([agent("1", "codex")]);
    expect(tiles(view.container).every((t) => t.includes("No model for this level"))).toBe(true);
    await expect(continueAction?.()).rejects.toThrow(/No model is set for Optimal on Codex/);
    expect(writes).toEqual([]);
    await view.unmount();
  });

  test("Continue stores Optimal: the smart tier's model at a clamped effort", async () => {
    const view = await mount([agent("1", "codex")]);
    await act(async () => {
      await continueAction?.();
    });
    expect(writes).toEqual([
      {
        id: "1",
        harnessProvider: "codex",
        model: "gpt-5.6-sol",
        allowCustomModel: false,
        reasoningEffort: "high",
      },
    ]);
    await view.unmount();
  });

  test("a failed tier load marks the dial rows so Continue skips them, with a retry", async () => {
    tiers = undefined;
    tiersError = true;
    const view = await mount([agent("1", "codex")]);
    const retry = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Retry loading the model"]',
    );
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
    });
    expect(tiersRefetches).toBe(1);
    await expect(continueAction?.()).rejects.toThrow(/did not load/);
    await view.unmount();
  });

  test("an agent already on a level shows it selected", async () => {
    storedConfigs = [
      { key: "MODEL_OVERRIDE", value: "gpt-5.6-sol" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "xhigh" },
    ];
    const view = await mount([agent("1", "codex")]);
    const max = view.container.querySelector<HTMLElement>(
      '[role="radiogroup"] [aria-checked="true"]',
    );
    expect(max?.textContent).toContain("Max");
    await view.unmount();
  });
});
