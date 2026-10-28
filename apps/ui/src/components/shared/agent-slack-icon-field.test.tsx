import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MotionGlobalConfig } from "motion/react";
import { act, useLayoutEffect } from "react";
import type { Agent, AgentSlackIcon } from "../../api/types";

// A DOM for the interaction tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists.
const { createRoot } = await import("react-dom/client");
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
// happy-dom rejects the status icon's cancelled Web Animations.
MotionGlobalConfig.skipAnimations = true;
afterAll(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await GlobalRegistrator.unregister();
});

let writes: (AgentSlackIcon | null | undefined)[] = [];
let writeGate: Promise<void> | null = null;
// Mocks of shared modules keep every export of the real module (see task-effort-field.test.tsx).
mock.module("@/lib/config", () => require("../../lib/config"));
mock.module("@/api/hooks/use-agents", () => ({
  ...require("../../api/hooks/use-agents"),
  useUpdateAgentProfile: () => ({
    mutateAsync: async ({ profile }: { profile: { slackIcon?: AgentSlackIcon | null } }) => {
      writes.push(profile.slackIcon);
      if (writeGate) await writeGate;
    },
  }),
}));
for (const [alias, path] of [
  ["@/lib/utils", "../../lib/utils"],
  ["@/lib/slack-icon", "../../lib/slack-icon"],
  ["@/hooks/use-autosave", "../../hooks/use-autosave"],
  ["@/components/shared/status-icon", "./status-icon"],
  ["@/components/ui/button", "../ui/button"],
  ["@/components/ui/input", "../ui/input"],
  ["@/components/ui/tooltip", "../ui/tooltip"],
] as const) {
  mock.module(alias, () => require(path));
}

const { AgentSlackIconField } = await import("./agent-slack-icon-field");
const { TooltipProvider } = await import("../ui/tooltip");

const agent = {
  id: "agent-1",
  name: "Owl",
  isLead: false,
  status: "idle",
  slackIcon: { type: "emoji", emoji: ":bee:" },
} as Agent;

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AgentSlackIconField agent={agent} />
      </TooltipProvider>,
    ),
  );
  const input = container.querySelector("input") as HTMLInputElement;
  const reset = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Reset to default",
  ) as HTMLButtonElement;
  return {
    input,
    type: (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    blur: () => act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))),
    reset: () => act(async () => reset.click()),
    unmount: () => act(async () => root.unmount()),
  };
}

describe("AgentSlackIconField saves", () => {
  beforeEach(() => {
    writes = [];
    writeGate = null;
  });

  test("Reset during a pending debounce stores only null", async () => {
    const field = await mount();
    await field.type(":owl:");
    await field.reset();
    await wait(1000);
    expect(writes).toEqual([null]);
    expect(field.input.value).toBe("");
    await field.unmount();
  });

  test("a newer edit and a Reset queued behind an in-flight save run in order", async () => {
    let release = () => {};
    writeGate = new Promise((resolve) => {
      release = resolve;
    });
    const field = await mount();
    await field.type(":owl:");
    await field.blur();
    await field.type(":fox:");
    await field.blur();
    await field.reset();
    // :fox: was replaced by the reset before it started, so it never reaches the server.
    expect(writes).toEqual([{ type: "emoji", emoji: ":owl:" }]);
    await act(async () => release());
    await wait(50);
    expect(writes).toEqual([{ type: "emoji", emoji: ":owl:" }, null]);
    await field.unmount();
  });

  test("a newer edit during an in-flight save is stored after it", async () => {
    let release = () => {};
    writeGate = new Promise((resolve) => {
      release = resolve;
    });
    const field = await mount();
    await field.type(":owl:");
    await field.blur();
    await field.type(":fox:");
    await field.blur();
    await act(async () => release());
    await wait(50);
    expect(writes).toEqual([
      { type: "emoji", emoji: ":owl:" },
      { type: "emoji", emoji: ":fox:" },
    ]);
    await field.unmount();
  });
});
