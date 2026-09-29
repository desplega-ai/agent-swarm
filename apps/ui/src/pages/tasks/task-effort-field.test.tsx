import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect, useState } from "react";
import type { ModelTierPreview } from "../../api/types";
import { tierRows } from "../../lib/model-tier-fixtures";

// A DOM for the interaction tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists
// (a static import would load it first and leave later files without events).
const { createRoot } = await import("react-dom/client");
// Radix picks a no-op layout effect when it first loads with no document.
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

let tiers: ModelTierPreview[] | undefined;
let configs: { key: string; value: string }[] | undefined;
let tiersPending = false;
let configsPending = false;
mock.module("@/api/hooks/use-model-tiers", () => ({
  useModelTiers: () => ({ data: tiers, isPending: tiersPending }),
}));
mock.module("@/api/hooks/use-models-catalog", () => ({
  useModelsCatalog: () => ({ data: undefined }),
}));
// Mocks of shared modules keep every export of the real module: in one `bun test`
// process the first file to register a specifier fixes its export names, and a
// later file importing another name fails to link.
// The real hook modules import the API client, which reads `@/lib/config`.
mock.module("@/lib/config", () => require("../../lib/config"));
mock.module("@/api/hooks/use-config-api", () => ({
  ...require("../../api/hooks/use-config-api"),
  useResolvedConfigs: () => ({ data: configs, isPending: configsPending }),
}));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/label", () => require("../../components/ui/label"));
mock.module("@/components/ui/select", () => require("../../components/ui/select"));
mock.module("@/lib/task-effort", () => require("../../lib/task-effort"));

const { TaskEffortField } = await import("./task-effort-field");

type Agent = Parameters<typeof TaskEffortField>[0]["agent"];
const agent = (harnessProvider: string, latestModel?: string): Agent =>
  ({
    id: "agent-1",
    harnessProvider,
    credStatus: latestModel ? { latestModel: { model: latestModel } } : undefined,
  }) as Agent;

let seen: string[] = [];

/** The field with its own effort state, like the dialog holds it. */
function Harness({
  agent: a,
  tier,
  initial = "",
}: {
  agent: Agent;
  tier: string;
  initial?: string;
}) {
  const [effort, setEffort] = useState(initial);
  seen.push(effort);
  return <TaskEffortField agent={a} tier={tier} value={effort} onChange={setEffort} enabled />;
}

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    rerender: (next: React.ReactNode) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Open the Radix select and return its option labels. */
async function optionLabels(container: HTMLElement): Promise<string[]> {
  const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]');
  if (!trigger) throw new Error("no select trigger");
  // A click opens it (as a touch does); Radix opens on a mouse pointerdown too.
  await act(async () => {
    trigger.click();
  });
  const labels = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
  // Close it again so the next call starts clean.
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  return labels;
}

beforeEach(() => {
  tiers = tierRows();
  configs = [];
  tiersPending = false;
  configsPending = false;
  seen = [];
  document.body.innerHTML = "";
});

describe("TaskEffortField", () => {
  test("offers the levels of the tier's model for the agent's harness", async () => {
    const view = await mount(<Harness agent={agent("claude")} tier="smol" />);
    // smol on claude = haiku: a thinking-budget model, off but no xhigh.
    expect(await optionLabels(view.container)).toEqual([
      "Agent default",
      "off",
      "low",
      "medium",
      "high",
    ]);
    await view.unmount();
  });

  test("with no tier it reads the agent's stored model", async () => {
    configs = [{ key: "MODEL_OVERRIDE", value: "claude-opus-5-5" }];
    const view = await mount(<Harness agent={agent("claude")} tier="" />);
    expect(await optionLabels(view.container)).toEqual([
      "Agent default",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    await view.unmount();
  });

  test("a codex agent can take max", async () => {
    const view = await mount(<Harness agent={agent("codex")} tier="smart" />);
    expect(await optionLabels(view.container)).toContain("max");
    await view.unmount();
  });

  test("with no knowable model it offers only low, medium, high", async () => {
    const view = await mount(<Harness agent={agent("claude")} tier="" />);
    expect(await optionLabels(view.container)).toEqual(["Agent default", "low", "medium", "high"]);
    await view.unmount();
  });

  test("a harness without effort control disables the select and says why", async () => {
    const view = await mount(<Harness agent={agent("acp")} tier="smart" />);
    const trigger = view.container.querySelector<HTMLButtonElement>('button[role="combobox"]');
    expect(trigger?.disabled).toBe(true);
    expect(view.container.textContent).toContain("ACP has no reasoning effort control.");
    await view.unmount();
  });

  test("a tier change that makes the chosen effort unsupported clears it", async () => {
    const view = await mount(<Harness agent={agent("claude")} tier="smart" initial="xhigh" />);
    expect(seen.at(-1)).toBe("xhigh");
    // Same field, new tier: smol = haiku has no xhigh.
    await view.rerender(<Harness agent={agent("claude")} tier="smol" initial="xhigh" />);
    expect(seen.at(-1)).toBe("");
    await view.unmount();
  });

  test("an agent change that makes the chosen effort unsupported clears it", async () => {
    tiers = tierRows();
    const view = await mount(<Harness agent={agent("codex")} tier="smart" initial="max" />);
    expect(seen.at(-1)).toBe("max");
    // Claude takes no max.
    await view.rerender(<Harness agent={agent("claude")} tier="smart" initial="max" />);
    expect(seen.at(-1)).toBe("");
    await view.unmount();
  });

  test("a harness without effort control clears the chosen effort", async () => {
    const view = await mount(<Harness agent={agent("acp")} tier="" initial="high" />);
    expect(seen.at(-1)).toBe("");
    await view.unmount();
  });

  test("a supported effort is kept", async () => {
    const view = await mount(<Harness agent={agent("claude")} tier="smart" initial="high" />);
    expect(seen.at(-1)).toBe("high");
    await view.unmount();
  });

  test("while the model still loads, a seeded effort is not cleared on a guess", async () => {
    configsPending = true;
    configs = undefined;
    const view = await mount(<Harness agent={agent("claude")} tier="" initial="xhigh" />);
    expect(seen.at(-1)).toBe("xhigh");
    configsPending = false;
    configs = [{ key: "MODEL_OVERRIDE", value: "claude-opus-5-5" }];
    await view.rerender(<Harness agent={agent("claude")} tier="" initial="xhigh" />);
    expect(seen.at(-1)).toBe("xhigh");
    await view.unmount();
  });
});
