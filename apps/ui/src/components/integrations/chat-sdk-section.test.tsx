import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useLayoutEffect } from "react";
import type { ChatSdkStatusResponse, SwarmConfig } from "../../api/types";

// A DOM for the switch click; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// `@/` does not resolve under bun test, and other files stub some of these
// modules process-wide: map each one the section imports to the real file.
for (const path of [
  "components/integrations/chat-sdk-adapter-form",
  "components/integrations/chat-sdk-setup",
  "components/shared/beta-tag",
  "components/shared/oauth-section",
  "components/shared/secret-input",
  "components/ui/alert-callout",
  "components/ui/badge",
  "components/ui/button",
  "components/ui/input",
  "components/ui/label",
  "components/ui/select",
  "components/ui/settings-row",
  "components/ui/switch",
  "components/ui/tooltip",
  "hooks/use-copy-to-clipboard",
  "lib/chat-sdk-fields",
  "lib/chat-sdk-form",
  "lib/integrations-status",
  "lib/utils",
]) {
  mock.module(`@/${path}`, () => require(`../../${path}`));
}
mock.module("@/components/shared/animated-reveal", () => ({
  AnimatedReveal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));
mock.module("@/api/client", () => ({ api: {} }));
// Both test files stub these hooks with the same exports: a stub is shared process-wide.
mock.module("@/api/hooks/use-config-api", () => ({
  useConfigs: () => ({ data: [], isLoading: false, error: null }),
  useUpsertConfigsBatch: () => ({ isPending: false, mutateAsync: async () => ({}) }),
}));

const STATUS: ChatSdkStatusResponse = {
  enabled: false,
  slackClash: false,
  adapters: (["telegram", "slack", "discord", "teams"] as const).map((name) => ({
    name,
    configured: name === "discord",
    enabled: true,
    health: "disabled",
    connected: false,
    webhookUrl: `https://swarm.example/api/integrations/chat/${name}/webhook`,
  })),
};
mock.module("@/api/hooks/use-chat-sdk", () => ({
  useChatSdkStatus: () => ({ data: STATUS, isLoading: false, isError: false, error: null }),
  useInvalidateChatSdkStatus: () => () => Promise.resolve(),
  useRegisterTelegramWebhook: () => ({ isPending: false, mutate: () => {} }),
}));

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { TooltipProvider } = await import("../ui/tooltip");
const { ChatSdkSection } = await import("./chat-sdk-section");
const { INTEGRATIONS } = await import("../../lib/integrations-catalog");
const { CHAT_SDK_ADAPTER_DEFS } = await import("../../lib/chat-sdk-fields");

const def = INTEGRATIONS.find((d) => d.id === "chat-sdk");
if (!def) throw new Error("chat-sdk def missing from catalog");

function row(key: string, value: string): SwarmConfig {
  return { id: key, scope: "global", key, value, isSecret: false } as SwarmConfig;
}

/** Discord is saved (with a public key, so its fields render); the channel is off. */
const CONFIGS: SwarmConfig[] = [
  row(
    "CHAT_SDK_ADAPTERS",
    JSON.stringify({
      discord: {
        botToken: { $config: "CHAT_SDK_DISCORD_BOT_TOKEN" },
        publicKey: "0".repeat(64),
        applicationId: "123456789012345678",
        enabled: false,
      },
    }),
  ),
  row("CHAT_SDK_DISCORD_BOT_TOKEN", "x"),
];

async function mount(adapter?: "discord") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <TooltipProvider>
          <ChatSdkSection def={def!} configs={CONFIGS} envPresence={{}} adapter={adapter} />
        </TooltipProvider>
      </MemoryRouter>,
    );
  });
  const switchFor = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
  return {
    host,
    switchFor,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("ChatSdkSection adapter prop", () => {
  test("without it, every adapter panel and the JSON preview render", async () => {
    const view = await mount();
    for (const adapterDef of CHAT_SDK_ADAPTER_DEFS) {
      expect(view.switchFor(`Use ${adapterDef.label}`)).not.toBeNull();
    }
    expect(view.host.textContent).toContain("CHAT_SDK_ADAPTERS preview");
    expect(view.host.textContent).toContain("Save Chat SDK settings");
    await view.cleanup();
  });

  test("with adapter=discord, only the Discord panel and its fields render", async () => {
    const view = await mount("discord");
    expect(view.switchFor("Use Discord")).not.toBeNull();
    for (const other of ["Telegram", "Slack", "Microsoft Teams"]) {
      expect(view.switchFor(`Use ${other}`)).toBeNull();
    }
    expect(view.host.querySelector("#chat-sdk-discord-applicationId")).not.toBeNull();
    expect(view.host.querySelector('[id^="chat-sdk-telegram-"]')).toBeNull();
    expect(view.host.textContent).not.toContain("CHAT_SDK_ADAPTERS preview");
    expect(view.host.textContent).toContain("Save Discord settings");
    await view.cleanup();
  });

  test("switching the adapter on switches the shared channel on", async () => {
    const view = await mount("discord");
    const channel = view.switchFor("Enable the Chat SDK channel");
    expect(channel?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      view.switchFor("Use Discord")?.click();
    });
    expect(view.switchFor("Use Discord")?.getAttribute("aria-checked")).toBe("true");
    expect(channel?.getAttribute("aria-checked")).toBe("true");
    await view.cleanup();
  });
});
