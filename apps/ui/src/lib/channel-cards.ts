// Connect › Channels: the channel cards and their state.
//
// Telegram, Discord and Teams are adapters of the `chat-sdk` integration;
// their state is the adapter's `connected` flag from
// `GET /api/integrations/chat/status`. Slack exists twice: the socket-mode
// `slack` integration and the Chat SDK `slack` adapter. One card covers both.

import type { ChatSdkAdapterStatus, ChatSdkStatusResponse, SwarmConfig } from "@/api/types";
import type { ChatSdkAdapterName } from "./chat-sdk-fields";
import { INTEGRATIONS } from "./integrations-catalog";
import { deriveIntegrationStatus, type EnvPresence } from "./integrations-status";

export type ChannelId = "slack" | "telegram" | "discord" | "teams" | "kapso";

/** `configured`: saved, but not running (the detail says why). */
export type ChannelChip = "connected" | "configured" | "none";

export interface ChannelState {
  chip: ChannelChip;
  /** One sentence: why a saved channel does not run, or what is missing. */
  detail?: string;
  /** Slack only: the mode the state comes from. */
  slackMode?: "socket" | "chat-sdk";
}

export interface ChannelDef {
  id: ChannelId;
  name: string;
  description: string;
  /** What connecting needs, in the card footer while not connected. */
  needs: string;
  logoSrc?: string;
  href: string;
  /** Extra search words. */
  keywords: string[];
  /** Shown in the compact "More channels" row. */
  more?: boolean;
  /** BETA tag text. */
  beta?: string;
  adapter?: ChatSdkAdapterName;
}

export function chatSdkAdapterHref(name: ChatSdkAdapterName): string {
  return `/integrations/chat-sdk?adapter=${name}`;
}

const BETA_NOTE = "Tested only against fixtures so far, not a real workspace.";

export const CHANNEL_DEFS: ChannelDef[] = [
  {
    id: "slack",
    name: "Slack",
    description: "The swarm answers in channels and threads.",
    needs: "Bot token and app token",
    logoSrc: "/integration-logos/slack.svg",
    href: "/integrations/slack",
    keywords: ["socket mode", "chat sdk"],
  },
  {
    id: "telegram",
    name: "Telegram",
    description: "Talk to the Lead from a Telegram bot.",
    needs: "Bot token from BotFather",
    logoSrc: "/integration-logos/telegram.svg",
    href: chatSdkAdapterHref("telegram"),
    keywords: ["chat sdk", "bot", "botfather"],
    adapter: "telegram",
  },
  {
    id: "discord",
    name: "Discord",
    description: "Mention the bot in a server channel.",
    needs: "Application ID and bot token",
    logoSrc: "/integration-logos/discord.svg",
    href: chatSdkAdapterHref("discord"),
    keywords: ["chat sdk", "bot", "server"],
    adapter: "discord",
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    description: "Chat with the swarm in Teams channels.",
    needs: "Azure bot registration",
    logoSrc: "/integration-logos/microsoft.svg",
    href: chatSdkAdapterHref("teams"),
    keywords: ["chat sdk", "teams", "azure"],
    more: true,
    beta: BETA_NOTE,
    adapter: "teams",
  },
  {
    id: "kapso",
    name: "WhatsApp",
    description: "Message the Lead through a Kapso number.",
    needs: "Kapso API key",
    href: "/integrations/kapso",
    keywords: ["kapso", "whatsapp"],
    more: true,
  },
];

/**
 * The channel a Chat SDK page shows: `/integrations/chat-sdk?adapter=<name>`
 * is one channel's page, so its breadcrumb names the channel, not "Chat SDK".
 */
export function chatSdkPageChannel(pathname: string, search: string): ChannelDef | undefined {
  if (pathname.replace(/\/+$/, "") !== "/integrations/chat-sdk") return undefined;
  const adapter = new URLSearchParams(search).get("adapter");
  return adapter ? CHANNEL_DEFS.find((def) => def.adapter === adapter) : undefined;
}

/** Cards whose name, description or keywords contain the query. */
export function matchChannels(defs: ChannelDef[], search: string): ChannelDef[] {
  const q = search.trim().toLowerCase();
  if (!q) return defs;
  return defs.filter((def) =>
    [def.name, def.description, def.id, ...def.keywords].some((text) =>
      text.toLowerCase().includes(q),
    ),
  );
}

/** The server's rule; an API without the field gets the same rule here. */
export function isAdapterConnected(adapter: ChatSdkAdapterStatus): boolean {
  return adapter.connected ?? (adapter.configured && adapter.enabled && adapter.health === "ok");
}

export function adapterChannelState(
  status: ChatSdkStatusResponse | undefined,
  name: ChatSdkAdapterName,
): ChannelState {
  const adapter = status?.adapters.find((candidate) => candidate.name === name);
  if (!status || !adapter?.configured) return { chip: "none" };
  if (isAdapterConnected(adapter)) return { chip: "connected" };
  if (!status.enabled) return { chip: "configured", detail: "The Chat SDK channel is off." };
  return { chip: "configured", detail: adapter.error ?? "Not running yet." };
}

/** Slack: socket mode configured, or the Chat SDK adapter connected. */
export function slackChannelState(
  socket: ReturnType<typeof deriveIntegrationStatus>,
  status: ChatSdkStatusResponse | undefined,
): ChannelState {
  const adapter = adapterChannelState(status, "slack");
  if (adapter.chip === "connected") return { ...adapter, slackMode: "chat-sdk" };
  if (socket === "configured") return { chip: "connected", slackMode: "socket" };
  if (socket === "partial") {
    return { chip: "configured", slackMode: "socket", detail: "Some values are missing." };
  }
  if (adapter.chip === "configured") return { ...adapter, slackMode: "chat-sdk" };
  if (socket === "disabled") return { chip: "none", detail: "Turned off with SLACK_DISABLE." };
  return { chip: "none" };
}

function integrationChannelState(status: ReturnType<typeof deriveIntegrationStatus>): ChannelState {
  if (status === "configured") return { chip: "connected" };
  if (status === "partial") return { chip: "configured", detail: "Some values are missing." };
  return { chip: "none" };
}

export function deriveChannelStates(input: {
  configs: SwarmConfig[];
  envPresence: EnvPresence;
  chatSdk: ChatSdkStatusResponse | undefined;
}): Record<ChannelId, ChannelState> {
  const { configs, envPresence, chatSdk } = input;
  const catalogStatus = (id: string) => {
    const def = INTEGRATIONS.find((candidate) => candidate.id === id);
    return def ? deriveIntegrationStatus(def, configs, envPresence) : "none";
  };
  return {
    slack: slackChannelState(catalogStatus("slack"), chatSdk),
    telegram: adapterChannelState(chatSdk, "telegram"),
    discord: adapterChannelState(chatSdk, "discord"),
    teams: adapterChannelState(chatSdk, "teams"),
    kapso: integrationChannelState(catalogStatus("kapso")),
  };
}
