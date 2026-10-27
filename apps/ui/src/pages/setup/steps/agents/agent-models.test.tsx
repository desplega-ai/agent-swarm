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
mock.module("@/components/shared/setup-chip", () =>
  require("../../../../components/shared/setup-chip"),
);
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
let skips = 0;
// `true`: rows store through the real autosave hook instead of the idle stub.
let liveAutosave = false;
// Set by a test: each write waits for it, then stores its setting (as the API does).
let writeGate: Promise<void> | null = null;

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
      if (!writeGate) return;
      await writeGate;
      storedConfigs = [
        { key: "MODEL_OVERRIDE", value: String(input.model) },
        { key: "REASONING_EFFORT_OVERRIDE", value: String(input.reasoningEffort) },
      ];
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
const realAutosave = require("../../../../hooks/use-autosave");
const idleAutosave = () => ({ phase: "idle", error: null });
mock.module("@/hooks/use-autosave", () => ({
  ...realAutosave,
  // A test sets `liveAutosave` before it mounts, so a row always runs the same hook.
  useAutosave: (options: unknown) =>
    (liveAutosave ? realAutosave.useAutosave : idleAutosave)(options),
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
  ["@/components/shared/setup-card", "../../../../components/shared/setup-card"],
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
          onSkip={async () => {
            skips += 1;
          }}
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

/** The header of the per-agent card: its text, and a click that opens the rows. */
function customize(container: HTMLElement) {
  const header = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(
    (b) => b.textContent?.includes("Customize per agent"),
  );
  if (!header) throw new Error("no Customize per agent header");
  return {
    text: header.textContent ?? "",
    open: () =>
      act(async () => {
        header.click();
      }),
  };
}

beforeEach(() => {
  tiers = tierRows();
  tiersError = false;
  storedConfigs = [];
  writes.length = 0;
  holds.length = 0;
  continueAction = null;
  tiersRefetches = 0;
  skips = 0;
  liveAutosave = false;
  writeGate = null;
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
    expect(customize(view.container).text).toContain("1 agent did not load. Open to retry.");
    await customize(view.container).open();
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
    await customize(view.container).open();
    const max = view.container.querySelector<HTMLElement>(
      '[role="radiogroup"] [aria-checked="true"]',
    );
    expect(max?.textContent).toContain("Max");
    await view.unmount();
  });

  test("the per-agent rows wait behind Customize per agent", async () => {
    const view = await mount([agent("1", "codex"), agent("2", "codex")]);
    expect(view.container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(customize(view.container).text).toContain("2 agents on Optimal.");
    await customize(view.container).open();
    expect(view.container.querySelectorAll('[role="radiogroup"]')).toHaveLength(2);
    await view.unmount();
  });

  test("a level tile stores every agent while the rows are closed", async () => {
    liveAutosave = true;
    const view = await mount([agent("1", "codex"), agent("2", "codex")]);
    const max = view.container.querySelectorAll<HTMLButtonElement>("fieldset button")[2];
    await act(async () => {
      max.click();
    });
    // The row saves wait 400 ms.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(writes.map((w) => [w.id, w.model, w.reasoningEffort])).toEqual([
      ["1", "gpt-5.6-sol", "xhigh"],
      ["2", "gpt-5.6-sol", "xhigh"],
    ]);
    expect(view.container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(customize(view.container).text).toContain("Saved. Applies to the next task.");
    await view.unmount();
  });

  test("quick picks store only the last level", async () => {
    liveAutosave = true;
    const view = await mount([agent("1", "codex")]);
    const [cheap, , max] = view.container.querySelectorAll<HTMLButtonElement>("fieldset button");
    await act(async () => {
      cheap.click();
    });
    await act(async () => {
      max.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(writes.map((w) => w.reasoningEffort)).toEqual(["xhigh"]);
    await view.unmount();
  });

  test("a pick back to the stored level while a write runs stores it again", async () => {
    liveAutosave = true;
    storedConfigs = [
      { key: "MODEL_OVERRIDE", value: "gpt-5.6-sol" },
      { key: "REASONING_EFFORT_OVERRIDE", value: "high" },
    ];
    let release = () => {};
    writeGate = new Promise((resolve) => {
      release = resolve;
    });
    const view = await mount([agent("1", "codex")]);
    const [, optimal, max] = view.container.querySelectorAll<HTMLButtonElement>("fieldset button");
    await act(async () => {
      max.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    // The Max write runs. The row still reads Optimal from before it.
    expect(writes.map((w) => w.reasoningEffort)).toEqual(["xhigh"]);
    await act(async () => {
      optimal.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(writes.map((w) => w.reasoningEffort)).toEqual(["xhigh", "high"]);
    expect(storedConfigs).toContainEqual({ key: "REASONING_EFFORT_OVERRIDE", value: "high" });
    await view.unmount();
  });

  test("agents that pick their own models: Continue skips the step and stores nothing", async () => {
    const view = await mount([agent("1", "devin")]);
    expect(view.container.textContent).toContain("These agents pick their own models.");
    await act(async () => {
      await continueAction?.();
    });
    expect(skips).toBe(1);
    expect(writes).toEqual([]);
    await view.unmount();
  });

  test("each tile shows its price per token next to Cheap", async () => {
    const view = await mount([agent("1", "claude")]);
    const [cheap, optimal, max] = tiles(view.container);
    expect(cheap).toContain("Price per token: 1x");
    expect(optimal).toMatch(/Price per token: \d+(\.\d)?x/);
    expect(max).toMatch(/Price per token: \d+(\.\d)?x/);
    await view.unmount();
  });
});
