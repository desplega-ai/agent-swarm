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
let appIconUrl: string | null = null;
for (const [alias, path] of [
  ["@/api/client", "../../api/client"],
  ["@/api/hooks/status-query", "../../api/hooks/status-query"],
  ["@/lib/env-presence-batch", "../../lib/env-presence-batch"],
] as const) {
  mock.module(alias, () => require(path));
}
mock.module("@/api/hooks/use-integrations-meta", () => ({
  ...require("../../api/hooks/use-integrations-meta"),
  useSlackAppIcon: () => ({ data: { imageUrl: appIconUrl } }),
}));
for (const [alias, path] of [
  ["@/lib/utils", "../../lib/utils"],
  ["@/components/ui/badge", "../ui/badge"],
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

async function mount(subject: Agent = agent) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AgentSlackIconField agent={subject} />
      </TooltipProvider>,
    ),
  );
  const input = container.querySelector("input") as HTMLInputElement;
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  return {
    container,
    input,
    preview: () => container.querySelector('[role="img"], img, [data-slot="badge"], .font-mono'),
    type: (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    blur: () => act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))),
    reset: () => act(async () => button("Reset to default")?.click()),
    useApp: () => act(async () => button("Use Slack app icon")?.click()),
    hasAppButton: () => Boolean(button("Use Slack app icon")),
    unmount: () => act(async () => root.unmount()),
  };
}

describe("AgentSlackIconField saves", () => {
  beforeEach(() => {
    writes = [];
    writeGate = null;
    appIconUrl = null;
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

  test("Use Slack app icon stores { type: app }; typing replaces it and Reset clears it", async () => {
    const field = await mount();
    await field.useApp();
    await wait(50);
    expect(writes).toEqual([{ type: "app" }]);
    expect(field.input.value).toBe("");
    expect(field.input.placeholder).toBe("Slack app icon");
    expect(field.hasAppButton()).toBe(false);
    await field.type("owl");
    await field.blur();
    await wait(50);
    expect(field.input.value).toBe(":owl:");
    expect(writes.at(-1)).toEqual({ type: "emoji", emoji: ":owl:" });
    await field.useApp();
    await field.reset();
    await wait(50);
    expect(writes.at(-1)).toBeNull();
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

describe("AgentSlackIconField preview", () => {
  const withIcon = (slackIcon: AgentSlackIcon | null, extra: Partial<Agent> = {}) =>
    ({ ...agent, slackIcon, ...extra }) as Agent;

  test("default shows the agent's real default: crown for the lead, the hash pick for a worker", async () => {
    const lead = await mount(withIcon(null, { isLead: true, name: "Neo" }));
    expect(lead.preview()?.textContent).toBe("👑");
    expect(lead.container.textContent).toContain("Leave empty for the default: 👑 :crown:.");
    await lead.unmount();
    // "Owl" hashes to :zap: in getAgentEmoji.
    const worker = await mount(withIcon(null));
    expect(worker.preview()?.getAttribute("aria-label")).toBe(":zap:");
    expect(worker.container.textContent).toContain("default: ⚡ :zap:.");
    await worker.unmount();
  });

  test("a known emoji renders its glyph; an unknown one shows its code in a chip", async () => {
    const field = await mount(withIcon({ type: "emoji", emoji: ":owl:" }));
    expect(field.preview()?.textContent).toBe("🦉");
    await field.type(":party-parrot:");
    const chip = field.preview();
    expect(chip?.className).toContain("font-mono");
    expect(chip?.textContent).toBe(":party-parrot:");
    await field.unmount();
  });

  test("a URL shows the image, without a referrer", async () => {
    const field = await mount(withIcon({ type: "url", url: "https://example.com/owl.png" }));
    const img = field.preview() as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://example.com/owl.png");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    await field.unmount();
  });

  test("the app icon shows the app's avatar, or a Slack app badge when it is missing or fails", async () => {
    appIconUrl = "https://slack.example/app-72.png";
    const withAvatar = await mount(withIcon({ type: "app" }));
    expect(withAvatar.preview()?.getAttribute("src")).toBe(appIconUrl);
    await withAvatar.unmount();
    appIconUrl = "https://slack.example/gone.png";
    const broken = await mount(withIcon({ type: "app" }));
    await act(async () => broken.preview()?.dispatchEvent(new Event("error")));
    expect(broken.preview()?.textContent).toBe("Slack app");
    await broken.unmount();
    appIconUrl = null;
    const badge = await mount(withIcon({ type: "app" }));
    expect(badge.preview()?.textContent).toBe("Slack app");
    await badge.unmount();
  });

  test("the preview follows the input and shows nothing for invalid input", async () => {
    const field = await mount(withIcon(null));
    await field.type("rocket");
    expect(field.preview()?.textContent).toBe("🚀");
    await field.type("http://example.com/owl.png");
    expect(field.preview()).toBeNull();
    await field.unmount();
  });
});
