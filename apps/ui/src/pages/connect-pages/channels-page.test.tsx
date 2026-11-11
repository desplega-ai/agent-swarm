import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ChatSdkAdapterStatus, ChatSdkStatusResponse, SwarmConfig } from "../../api/types";

// `@/` does not resolve under bun test, and other files stub some of these
// modules process-wide: map each one the page imports to the real file.
for (const path of [
  "components/integrations/channel-status-chip",
  "components/integrations/integration-card",
  "components/shared/beta-tag",
  "components/shared/brand-logo",
  "components/shared/empty-state",
  "components/shared/provider-icon",
  "components/ui/alert",
  "components/ui/badge",
  "components/ui/button",
  "components/ui/card",
  "components/ui/dropdown-menu",
  "components/ui/input",
  "components/ui/skeleton",
  "components/ui/tooltip",
  "hooks/use-url-search-state",
  "lib/channel-cards",
  "lib/integrations-catalog",
  "lib/integrations-status",
  "lib/utils",
]) {
  mock.module(`@/${path}`, () => require(`../../${path}`));
}

let configs: SwarmConfig[] = [];
let chatStatus: ChatSdkStatusResponse | undefined;

mock.module("@/api/hooks/use-config-api", () => ({
  useConfigs: () => ({ data: configs, isLoading: false, error: null }),
  useUpsertConfigsBatch: () => ({ isPending: false, mutateAsync: async () => ({}) }),
}));
mock.module("@/api/hooks/use-integrations-meta", () => ({
  useEnvPresence: () => ({ data: {} }),
}));
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported: true }),
}));
mock.module("@/lib/use-can", () => ({ useCan: () => true }));
mock.module("@/api/hooks/use-chat-sdk", () => ({
  useChatSdkStatus: () => ({ data: chatStatus, isLoading: false, error: null }),
  useInvalidateChatSdkStatus: () => () => Promise.resolve(),
  useRegisterTelegramWebhook: () => ({ isPending: false, mutate: () => {} }),
}));

const { default: ChannelsPage } = await import("./channels-page");
const { TooltipProvider } = await import("../../components/ui/tooltip");
const { adapterChannelState, chatSdkPageChannel, matchChannels, slackChannelState, CHANNEL_DEFS } =
  await import("../../lib/channel-cards");

function adapter(
  name: ChatSdkAdapterStatus["name"],
  patch: Partial<ChatSdkAdapterStatus> = {},
): ChatSdkAdapterStatus {
  return {
    name,
    configured: false,
    enabled: true,
    health: "disabled",
    connected: false,
    webhookUrl: `https://swarm.example/api/integrations/chat/${name}/webhook`,
    ...patch,
  };
}

function status(
  adapters: ChatSdkAdapterStatus[],
  patch: Partial<ChatSdkStatusResponse> = {},
): ChatSdkStatusResponse {
  const byName = new Map(adapters.map((a) => [a.name, a]));
  return {
    enabled: true,
    slackClash: false,
    adapters: (["telegram", "slack", "discord", "teams"] as const).map(
      (name) => byName.get(name) ?? adapter(name),
    ),
    ...patch,
  };
}

function row(key: string, value: string): SwarmConfig {
  return { id: key, scope: "global", key, value, isSecret: false } as SwarmConfig;
}

describe("adapterChannelState", () => {
  test("not configured is Not connected", () => {
    expect(adapterChannelState(status([]), "telegram")).toEqual({ chip: "none" });
    expect(adapterChannelState(undefined, "telegram")).toEqual({ chip: "none" });
  });

  test("the server's connected flag makes it Connected", () => {
    const s = status([adapter("telegram", { configured: true, health: "ok", connected: true })]);
    expect(adapterChannelState(s, "telegram")).toEqual({ chip: "connected" });
  });

  test("an older API without the flag gets the same rule", () => {
    const ok = adapter("discord", { configured: true, health: "ok" });
    delete ok.connected;
    expect(adapterChannelState(status([ok]), "discord").chip).toBe("connected");
    const off = { ...ok, enabled: false };
    expect(adapterChannelState(status([off]), "discord").chip).toBe("configured");
  });

  test("saved but failing is Configured, with the health error as the detail", () => {
    const s = status([
      adapter("telegram", { configured: true, health: "error", error: "Unauthorized" }),
    ]);
    expect(adapterChannelState(s, "telegram")).toEqual({
      chip: "configured",
      detail: "Unauthorized",
    });
  });

  test("a channel that is off says so", () => {
    const s = status([adapter("telegram", { configured: true })], { enabled: false });
    expect(adapterChannelState(s, "telegram")).toEqual({
      chip: "configured",
      detail: "The Chat SDK channel is off.",
    });
  });
});

describe("slackChannelState", () => {
  test("socket mode configured is Connected in socket mode", () => {
    expect(slackChannelState("configured", status([]))).toEqual({
      chip: "connected",
      slackMode: "socket",
    });
  });

  test("the Chat SDK adapter connected is Connected in chat-sdk mode", () => {
    const s = status([adapter("slack", { configured: true, health: "ok", connected: true })]);
    expect(slackChannelState("none", s)).toEqual({ chip: "connected", slackMode: "chat-sdk" });
  });

  test("a saved adapter that does not run is Configured", () => {
    const s = status([adapter("slack", { configured: true, health: "error", error: "x" })]);
    expect(slackChannelState("none", s)).toMatchObject({
      chip: "configured",
      slackMode: "chat-sdk",
    });
  });

  test("nothing set is Not connected", () => {
    expect(slackChannelState("none", status([]))).toEqual({ chip: "none" });
  });
});

describe("matchChannels", () => {
  test("matches names, descriptions and keywords", () => {
    expect(matchChannels(CHANNEL_DEFS, "whatsapp").map((d) => d.id)).toEqual(["kapso"]);
    expect(matchChannels(CHANNEL_DEFS, "botfather").map((d) => d.id)).toEqual(["telegram"]);
    expect(matchChannels(CHANNEL_DEFS, "").length).toBe(CHANNEL_DEFS.length);
  });
});

function render(url = "/integrations/channels"): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <TooltipProvider>
        <ChannelsPage />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

/** `[channel id, chip]` in render order. */
function cards(html: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /data-channel-id="([^"]+)"[\s\S]*?data-channel-chip="([^"]+)"/g;
  for (const match of html.matchAll(re)) out.push([match[1] ?? "", match[2] ?? ""]);
  return out;
}

describe("ChannelsPage", () => {
  test("one grid of channel cards, all Not connected on a fresh swarm", () => {
    configs = [];
    chatStatus = status([]);
    const html = render();
    expect(cards(html)).toEqual([
      ["slack", "none"],
      ["telegram", "none"],
      ["discord", "none"],
      ["teams", "none"],
      ["rocketchat", "none"],
      ["kapso", "none"],
    ]);
    expect(html).not.toContain("More channels");
    expect(html).toContain('href="/integrations/chat-sdk?adapter=telegram"');
  });

  test("each card follows its own state", () => {
    configs = [row("SLACK_BOT_TOKEN", "x"), row("SLACK_APP_TOKEN", "y")];
    chatStatus = status([
      adapter("telegram", { configured: true, health: "ok", connected: true }),
      adapter("discord", { configured: true, health: "incomplete", error: "Missing publicKey" }),
    ]);
    const html = render();
    expect(cards(html)).toEqual([
      ["slack", "connected"],
      ["telegram", "connected"],
      ["discord", "configured"],
      ["teams", "none"],
      ["rocketchat", "none"],
      ["kapso", "none"],
    ]);
    expect(html).toContain("Missing publicKey");
    expect(html).toContain('aria-label="Manage Telegram"');
    expect(html).toContain('aria-label="Connect Microsoft Teams"');
  });

  test("the search row filters the cards", () => {
    configs = [];
    chatStatus = status([]);
    const html = render("/integrations/channels?search=disc");
    expect(cards(html).map(([id]) => id)).toEqual(["discord"]);
    expect(html).not.toContain("More channels");
  });
});

describe("chatSdkPageChannel (the breadcrumb of a channel page)", () => {
  test("names the channel of a Chat SDK adapter page", () => {
    expect(chatSdkPageChannel("/integrations/chat-sdk", "?adapter=telegram")?.name).toBe(
      "Telegram",
    );
    expect(chatSdkPageChannel("/integrations/chat-sdk/", "?adapter=teams")?.name).toBe(
      "Microsoft Teams",
    );
    expect(chatSdkPageChannel("/integrations/chat-sdk", "")).toBeUndefined();
    expect(chatSdkPageChannel("/integrations/chat-sdk", "?adapter=nope")).toBeUndefined();
    expect(chatSdkPageChannel("/integrations/slack", "?adapter=telegram")).toBeUndefined();
  });
});
