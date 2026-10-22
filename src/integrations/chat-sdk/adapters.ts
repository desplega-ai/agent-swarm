import type { TelegramMessage } from "@chat-adapter/telegram";
import type { Adapter, Logger } from "chat";
import { type ChatSdkAdapterName, type ResolvedAdapterConfig, readApiUrlOverrides } from "./config";
import { isTelegramReplyToBot, type TelegramRawMessage } from "./facts";
import { withInfoFilter } from "./logger";
import { getChatSdkTestHooks } from "./test-hooks";

/**
 * Platform API bases passed explicitly so the adapters never fall back to
 * `TELEGRAM_API_BASE_URL` / `SLACK_API_URL` / `DISCORD_API_URL` /
 * `TEAMS_API_URL` from `process.env`. Global swarm_config rows are injected
 * into `process.env`, so an env fallback would let a config row redirect bot
 * tokens to another host. Teams gets "" which blocks only `TEAMS_API_URL`.
 * The other Teams SDK env fallbacks (`SERVICE_URL`, `TENANT_ID`, `CLIENT_ID`,
 * `CLIENT_SECRET`, `MANAGED_IDENTITY_CLIENT_ID`, `CLOUD`) are closed by the
 * injection denylist in `getInjectableGlobalConfigs` (`src/be/db.ts`).
 * Deployment env can still set them on purpose.
 */
const DEFAULT_API_URLS: Record<ChatSdkAdapterName, string> = {
  telegram: "https://api.telegram.org",
  slack: "https://slack.com/api/",
  discord: "https://discord.com/api/v10",
  teams: "",
};

/**
 * Discord adapter info lines dropped from the logs. They fire per event and
 * carry guild message content (first 100 chars), or the public key and
 * signature prefix of every interaction. Warn and error lines are kept.
 */
const DISCORD_NOISY_INFO_PREFIXES = [
  "Discord Gateway message received",
  "Discord webhook received",
  "Discord signature verification",
  "Discord interaction parsed",
  "Discord PING received",
];

export function keepDiscordInfoLine(message: string): boolean {
  return !DISCORD_NOISY_INFO_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/**
 * Platform API base for one adapter: the env-only `CHAT_SDK_API_URL_OVERRIDES`
 * entry, else the platform default. The adapters and the Telegram
 * register-webhook route use the same base.
 */
export function resolveAdapterApiUrl(name: ChatSdkAdapterName): string {
  return readApiUrlOverrides()[name] ?? DEFAULT_API_URLS[name];
}

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
  const apiUrl = resolveAdapterApiUrl(name);
  const base = { ...config, apiUrl, logger };
  switch (name) {
    case "telegram": {
      const { TelegramAdapter } = await import("@chat-adapter/telegram");
      // The adapter's `mentionOnReply` skips a reply whose target id equals
      // `message_thread_id`, meant for forum topic roots. A plain supergroup
      // reply to a bot message that starts a reply chain has that same shape,
      // so it was never a mention and never reached a handler. Core decides
      // with `is_topic_message`, as the task header facts do.
      class SwarmTelegramAdapter extends TelegramAdapter {
        protected override isBotMentioned(message: TelegramMessage, text: string): boolean {
          return (
            super.isBotMentioned(message, text) ||
            (String(message.from?.id) !== this.botUserId &&
              isTelegramReplyToBot(message as TelegramRawMessage, this.botUserId))
          );
        }
      }
      // Explicit `false` blocks the TELEGRAM_ALLOW_UNVERIFIED_WEBHOOKS env fallback.
      // Explicit `true` makes a reply to the bot a mention whatever
      // TELEGRAM_MENTION_ON_REPLY says.
      return new SwarmTelegramAdapter({
        ...base,
        allowUnverifiedWebhooks: false,
        mentionOnReply: true,
      } as ConstructorParameters<typeof TelegramAdapter>[0]);
    }
    case "slack": {
      const { createSlackAdapter } = await import("@chat-adapter/slack");
      // "" (not undefined) blocks each `?? process.env.SLACK_*` fallback, which
      // would pick up the built-in Slack app's secrets. Socket forwarding and
      // the installation encryption key are multi-workspace features we do not
      // use; "" turns both off.
      return createSlackAdapter({
        ...base,
        signingSecret: config.signingSecret ?? "",
        appToken: config.appToken ?? "",
        socketForwardingSecret: "",
        encryptionKey: "",
      } as Parameters<typeof createSlackAdapter>[0]);
    }
    case "discord": {
      const { createDiscordAdapter } = await import("@chat-adapter/discord");
      // `[]` (not undefined) blocks the DISCORD_RESPOND_TO_CHANNEL_IDS and
      // DISCORD_MENTION_ROLE_IDS env fallbacks.
      return createDiscordAdapter({
        ...base,
        logger: withInfoFilter(logger, keepDiscordInfoLine),
        respondToChannelIds: config.respondToChannelIds ?? [],
        mentionRoleIds: config.mentionRoleIds ?? [],
      } as Parameters<typeof createDiscordAdapter>[0]);
    }
    case "teams": {
      const { createTeamsAdapter } = await import("@chat-adapter/teams");
      // `webhookVerifier` replaces the Bot Framework JWT check and `token` the
      // bot token call. Only tests set them (test-hooks.ts); the operator
      // schema rejects `webhookVerifier`, and `token` is a function.
      const { teamsWebhookVerifier, teamsToken } = getChatSdkTestHooks();
      return createTeamsAdapter({
        ...base,
        ...(teamsWebhookVerifier ? { webhookVerifier: teamsWebhookVerifier } : {}),
        ...(teamsToken ? { token: teamsToken } : {}),
      } as Parameters<typeof createTeamsAdapter>[0]);
    }
  }
}

type SocketClientLike = { on(event: string, listener: () => void): unknown };

/**
 * Slack socket mode reconnects on its own and logs through its own logger,
 * not ours. Surface hard failures through the scrubbing logger so adapter
 * health (`lastWarning`) shows them. A failed first connect rejects
 * `initialize()` for auth errors. Network failures go through the WebClient
 * retry policy and can take long before they surface here.
 * `reconnecting` also fires on Slack's routine connection refresh, so it is
 * logged at info only and never reaches health.
 */
export function watchSocketConnection(adapter: Adapter, logger: Logger): void {
  const client = (adapter as { socketClient?: SocketClientLike }).socketClient;
  if (!client) return;
  client.on("reconnecting", () => logger.info("Slack socket mode reconnecting"));
  client.on("unable_to_socket_mode_start", () =>
    logger.warn("Slack socket mode unable to start, retrying"),
  );
  client.on("error", () => logger.warn("Slack socket mode error"));
}
