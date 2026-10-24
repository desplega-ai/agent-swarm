import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useLayoutEffect } from "react";

// A DOM for the copy button; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/chat-sdk-fields", () => require("../../lib/chat-sdk-fields"));
mock.module("@/lib/chat-sdk-form", () => require("../../lib/chat-sdk-form"));
mock.module("@/hooks/use-copy-to-clipboard", () => require("../../hooks/use-copy-to-clipboard"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));
// Like the real reveal, children unmount when closed; no motion in happy-dom.
mock.module("@/components/shared/animated-reveal", () => ({
  AnimatedReveal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

const { createRoot } = await import("react-dom/client");
const { TooltipProvider } = await import("../ui/tooltip");
const { ChatSdkSetup, stepText } = await import("./chat-sdk-setup");

const DOCS_URL = "https://docs.agent-swarm.dev/docs/integrations/chat-sdk";
const ADAPTERS = ["telegram", "slack", "discord", "teams"] as const;

const written: string[] = [];
beforeEach(() => {
  written.length = 0;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  });
});

async function mount(adapter: (typeof ADAPTERS)[number], defaultOpen: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ChatSdkSetup
          adapter={adapter}
          docsUrl={DOCS_URL}
          defaultOpen={defaultOpen}
          webhookUrl="https://swarm.example.com/api/chat/webhook"
        />
      </TooltipProvider>,
    );
  });
  const click = async (target: "copy" | "toggle") => {
    const button = host.querySelector<HTMLButtonElement>(
      target === "copy" ? "button[aria-label^='Cop']" : "button[aria-expanded]",
    );
    if (!button) throw new Error(`No ${target} button`);
    await act(async () => {
      button.click();
    });
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, click, unmount };
}

describe("stepText", () => {
  test("keeps chip and bold text and spells out links", () => {
    const text = stepText(
      <>
        Open <a href="https://t.me/BotFather">BotFather</a> and send <code>/newbot</code>. Copy the
        token into <b>Bot token</b>.
      </>,
    );
    expect(text).toBe(
      "Open BotFather (https://t.me/BotFather) and send /newbot. Copy the token into Bot token.",
    );
  });
});

describe("Copy for your agent", () => {
  for (const adapter of ADAPTERS) {
    test(`${adapter}: the brief is the same collapsed, expanded and collapsed again`, async () => {
      const view = await mount(adapter, false);
      expect(view.host.querySelector("ol")).toBeNull();

      await view.click("copy");
      await view.click("toggle");
      const items = Array.from(view.host.querySelectorAll("ol > li"));
      expect(items.length).toBeGreaterThan(1);
      await view.click("copy");
      await view.click("toggle");
      await view.click("copy");
      await view.unmount();

      expect(written).toHaveLength(3);
      const [collapsed, expanded, recollapsed] = written;
      expect(expanded).toBe(collapsed);
      expect(recollapsed).toBe(collapsed);
      // Every rendered step is numbered in the brief, as rendered.
      items.forEach((item, index) => {
        const rendered = item.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const line = collapsed
          ?.split("\n")
          .find((candidate) => candidate.startsWith(`${index + 1}. `));
        expect(line).toBeDefined();
        expect(line?.length).toBeGreaterThanOrEqual(rendered.length);
      });
      // Every link target survives the copy.
      for (const anchor of Array.from(items.flatMap((item) => [...item.querySelectorAll("a")]))) {
        expect(collapsed).toContain(`(${anchor.getAttribute("href")})`);
      }
    });
  }

  test("telegram brief names the BotFather link and the last step", async () => {
    const view = await mount("telegram", false);
    await view.click("copy");
    await view.unmount();
    expect(written[0]).toContain("1. In Telegram, open BotFather (https://t.me/BotFather)");
    expect(written[0]).toContain("8. The bot answers /help, /status, /cancel and /reset.");
    expect(written[0]).toContain("Webhook URL of this swarm");
  });
});
