import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Image } from "lucide-react";
import { MotionGlobalConfig } from "motion/react";
import { act, useLayoutEffect } from "react";
import type { MediaIcon } from "../../api/types";

// A DOM for the interaction tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists.
const { createRoot } = await import("react-dom/client");
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
MotionGlobalConfig.skipAnimations = true;
afterAll(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await GlobalRegistrator.unregister();
});

const toasts: { kind: "success" | "error"; message: string }[] = [];
mock.module("sonner", () => ({
  toast: {
    success: (message: string) => toasts.push({ kind: "success", message }),
    error: (message: string) => toasts.push({ kind: "error", message }),
  },
}));
// agent-fs is not connected: no uploads, and no agent-fs media URLs.
mock.module("@/contexts/agent-fs-context", () => ({ useOptionalAgentFs: () => null }));
mock.module("@/api/hooks/use-agent-fs", () => ({
  useAgentFsMediaUrl: () => ({ data: undefined }),
}));
for (const [alias, path] of [
  ["@/lib/utils", "../../lib/utils"],
  ["@/lib/agent-color", "../../lib/agent-color"],
  ["@/lib/agent-icon", "../../lib/agent-icon"],
  ["@/lib/upload-media-icon", "../../lib/upload-media-icon"],
  ["@/components/shared/agent-appearance-picker", "./agent-appearance-picker"],
  ["@/components/shared/media-icon-glyph", "./media-icon-glyph"],
  ["@/components/shared/image-with-fallback", "./image-with-fallback"],
  ["@/components/ui/button", "../ui/button"],
  ["@/components/ui/input", "../ui/input"],
  ["@/components/ui/segmented-control", "../ui/segmented-control"],
  ["@/components/ui/tooltip", "../ui/tooltip"],
] as const) {
  mock.module(alias, () => require(path));
}

const { MediaIconField } = await import("./media-icon-field");
const { TooltipProvider } = await import("../ui/tooltip");

const LINK = "https://example.com/icon.png";
let saves: (MediaIcon | null)[] = [];
let failNext = 0;

async function onSave(icon: MediaIcon | null) {
  saves.push(icon);
  if (failNext > 0) {
    failNext--;
    throw new Error("save failed");
  }
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

async function mount(value: MediaIcon | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <MediaIconField
          value={value}
          onSave={onSave}
          uploadPrefix="/apps/a/icon"
          fallback={Image}
        />
      </TooltipProvider>,
    ),
  );
  const input = () =>
    container.querySelector('[data-testid="media-icon-link-input"]') as HTMLInputElement;
  return {
    container,
    input,
    type: (text: string) =>
      act(async () => {
        const el = input();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    enter: () =>
      act(async () => {
        input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }),
    blur: () =>
      act(async () => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true }))),
    alert: () => container.querySelector('[role="alert"]')?.textContent ?? null,
    unmount: () => act(async () => root.unmount()),
  };
}

// Opens on the Link tab: the stored icon is a link.
const STORED: MediaIcon = { type: "url", url: "https://example.com/old.png" };

describe("MediaIconField link", () => {
  beforeEach(() => {
    saves = [];
    failNext = 0;
    toasts.length = 0;
  });

  test("a failed link save can be retried with Enter on the same link", async () => {
    const field = await mount(STORED);
    failNext = 1;
    await field.type(LINK);
    await field.enter();
    await settle();
    expect(saves).toEqual([{ type: "url", url: LINK }]);
    expect(toasts).toEqual([{ kind: "error", message: "save failed" }]);

    await field.enter();
    await settle();
    expect(saves).toEqual([
      { type: "url", url: LINK },
      { type: "url", url: LINK },
    ]);
    expect(toasts.at(-1)).toEqual({ kind: "success", message: "Icon saved" });
    await field.unmount();
  });

  test("Enter then blur on the same new link saves once", async () => {
    const field = await mount(STORED);
    await field.type(LINK);
    await field.enter();
    await settle();
    await field.blur();
    await settle();
    expect(saves).toEqual([{ type: "url", url: LINK }]);
    expect(toasts).toEqual([{ kind: "success", message: "Icon saved" }]);
    await field.unmount();
  });

  test("an http link shows the https error and never saves", async () => {
    const field = await mount(STORED);
    await field.type("http://example.com/icon.png");
    await field.enter();
    await field.blur();
    await settle();
    expect(field.alert()).toMatch(/https/i);
    expect(saves).toEqual([]);
    expect(toasts).toEqual([]);
    await field.unmount();
  });
});
