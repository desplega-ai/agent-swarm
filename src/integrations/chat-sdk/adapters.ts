import type { Adapter, Logger } from "chat";
import { type ChatSdkAdapterName, type ResolvedAdapterConfig, readApiUrlOverrides } from "./config";

/**
 * Platform API bases passed explicitly so the adapters never fall back to
 * `TELEGRAM_API_BASE_URL` / `SLACK_API_URL` / `DISCORD_API_URL` /
 * `TEAMS_API_URL` from `process.env`. Global swarm_config rows are injected
 * into `process.env`, so an env fallback would let a config row redirect bot
 * tokens to another host. Teams gets "" (no service URL override; the empty
 * string still blocks the `??` env fallback).
 */
const DEFAULT_API_URLS: Record<ChatSdkAdapterName, string> = {
  telegram: "https://api.telegram.org",
  slack: "https://slack.com/api/",
  discord: "https://discord.com/api/v10",
  teams: "",
};

/**
 * Construct one adapter. Each branch is a literal-path dynamic import so
 * `bun build --compile` bundles it (a computed specifier is not bundled).
 * `apiUrl` comes only from the env-only `CHAT_SDK_API_URL_OVERRIDES`.
 */
export async function loadAdapter(
  name: ChatSdkAdapterName,
  config: ResolvedAdapterConfig,
  logger: Logger,
): Promise<Adapter> {
  const apiUrl = readApiUrlOverrides()[name] ?? DEFAULT_API_URLS[name];
  const base = { ...config, apiUrl, logger };
  switch (name) {
    case "telegram": {
      const { createTelegramAdapter } = await import("@chat-adapter/telegram");
      // Explicit `false` blocks the TELEGRAM_ALLOW_UNVERIFIED_WEBHOOKS env fallback.
      return createTelegramAdapter({ ...base, allowUnverifiedWebhooks: false } as Parameters<
        typeof createTelegramAdapter
      >[0]);
    }
    case "slack": {
      const { createSlackAdapter } = await import("@chat-adapter/slack");
      return createSlackAdapter(base as Parameters<typeof createSlackAdapter>[0]);
    }
    case "discord": {
      const { createDiscordAdapter } = await import("@chat-adapter/discord");
      return createDiscordAdapter(base as Parameters<typeof createDiscordAdapter>[0]);
    }
    case "teams": {
      const { createTeamsAdapter } = await import("@chat-adapter/teams");
      return createTeamsAdapter(base as Parameters<typeof createTeamsAdapter>[0]);
    }
  }
}
