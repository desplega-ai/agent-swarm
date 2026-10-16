import { z } from "zod";
import { getPublicMcpBaseUrl } from "@/utils/constants";
import { isEnvFlagEnabled } from "@/utils/env-flag";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { resolveAdapterApiUrl } from "./adapters";
import { CHAT_SDK_ADAPTER_NAMES, type ChatSdkAdapterName, getChatSdkConfig } from "./config";
import { fetchDiscordGuilds } from "./discord-api";
import { getChatSdkHealth } from "./runtime";
import { isAdapterEntryEnabled } from "./schema";
import { callTelegramBotApi, TelegramBotApiError } from "./telegram-api";

/**
 * Read-only Chat SDK status for the dashboard card, and the Telegram
 * register-webhook action. Never returns secret values: configured state comes
 * from adapter names and the non-secret `mode` field only.
 */

export const ChatSdkStatusSchema = z.object({
  enabled: z.boolean(),
  slackClash: z.boolean(),
  /** Config problem that stops every adapter from starting (bad JSON, missing `$config` row). */
  error: z.string().optional(),
  adapters: z.array(
    z.object({
      name: z.enum(CHAT_SDK_ADAPTER_NAMES),
      configured: z.boolean(),
      /** False when the entry carries `enabled: false`: configured and kept, not started. */
      enabled: z.boolean(),
      /** `incomplete`: present in `CHAT_SDK_ADAPTERS` with a missing field or an unresolvable `$config`; `error` names it. */
      health: z.enum(["ok", "error", "disabled", "incomplete"]),
      error: z.string().optional(),
      webhookUrl: z.string(),
      mode: z.string().optional(),
      gateway: z
        .object({
          state: z.enum(["running", "backoff", "stopped"]),
          since: z.string(),
          restarts: z.number(),
        })
        .optional(),
      /** Discord only, while the Gateway runs: the servers the bot was invited to. */
      guilds: z.object({ count: z.number(), names: z.array(z.string()) }).optional(),
    }),
  ),
});

export type ChatSdkStatus = z.infer<typeof ChatSdkStatusSchema>;
export type ChatSdkAdapterStatus = ChatSdkStatus["adapters"][number];

/** Schema defaults, repeated here because the raw JSON may omit `mode`. */
const DEFAULT_MODES: Partial<Record<ChatSdkAdapterName, string>> = {
  telegram: "webhook",
  slack: "webhook",
};

const NOT_RUNNING =
  "The adapter is starting, or the last configuration save is still applying. Refresh in a few seconds.";

const SLACK_CLASH_CAUSE =
  "the Slack adapter conflicts with the built-in Slack integration (set SLACK_DISABLE=true)";

/** Bound on error text in the status payload. Adapter and parser errors can be long. */
const MAX_STATUS_ERROR_CHARS = 300;

function statusError(message: string): string {
  return scrubSecrets(message).slice(0, MAX_STATUS_ERROR_CHARS);
}

/**
 * The raw `CHAT_SDK_ADAPTERS` object, without validation or `$config`
 * resolution. Lets the card show which adapters an operator configured even
 * while the config fails to resolve. Empty on invalid JSON.
 */
function readRawAdapters(): Partial<Record<ChatSdkAdapterName, Record<string, unknown>>> {
  const raw = process.env.CHAT_SDK_ADAPTERS?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Partial<Record<ChatSdkAdapterName, Record<string, unknown>>> = {};
    for (const name of CHAT_SDK_ADAPTER_NAMES) {
      const value = (parsed as Record<string, unknown>)[name];
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        out[name] = value as Record<string, unknown>;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function chatSdkWebhookUrl(name: ChatSdkAdapterName): string {
  return `${getPublicMcpBaseUrl()}/api/integrations/chat/${name}/webhook`;
}

/**
 * The Discord bot's servers, only while its Gateway runs (a bot that is in no
 * server is the usual "it does not answer" cause). The token comes from the
 * resolved config, never from the status payload.
 */
async function discordGuildsFor(
  config: Awaited<ReturnType<typeof getChatSdkConfig>>,
  health: ReturnType<typeof getChatSdkHealth>["discord"],
): Promise<ChatSdkAdapterStatus["guilds"]> {
  if (health?.status !== "ok" || health.gateway?.state !== "running") return undefined;
  const raw = config.adapters.discord?.botToken;
  const token = typeof raw === "function" ? await (raw as () => Promise<unknown>)() : raw;
  if (typeof token !== "string" || token.length === 0) return undefined;
  return fetchDiscordGuilds(token);
}

export async function getChatSdkStatus(): Promise<ChatSdkStatus> {
  const config = await getChatSdkConfig();
  const raw = readRawAdapters();
  const runtimeHealth = getChatSdkHealth();
  const slackClash = raw.slack !== undefined && !isEnvFlagEnabled("SLACK_DISABLE", false);
  // A config error or a Slack clash stops `startChatSdk` before any adapter.
  const blockedCause =
    config.error ?? (config.enabled && slackClash ? SLACK_CLASH_CAUSE : undefined);
  const discordGuilds = await discordGuildsFor(config, runtimeHealth.discord);
  const adapters = CHAT_SDK_ADAPTER_NAMES.map((name): ChatSdkAdapterStatus => {
    const configured = raw[name] !== undefined;
    const enabled = isAdapterEntryEnabled(raw[name]);
    const current = runtimeHealth[name];
    const incomplete = config.incomplete?.[name];
    const rawMode = raw[name]?.mode;
    const mode =
      typeof rawMode === "string" ? rawMode : configured ? DEFAULT_MODES[name] : undefined;
    let health: ChatSdkAdapterStatus["health"] = "disabled";
    let error: string | undefined;
    if (current) {
      health = current.status;
      // A Discord Gateway in backoff keeps health `ok` (the webhook still
      // works); its last warning says why the listener keeps failing.
      const showWarning = current.status === "error" || current.gateway?.state === "backoff";
      error = current.error ?? (showWarning ? current.lastWarning : undefined);
    } else if (incomplete) {
      // Saved with a missing field, or a `$config` row that does not exist.
      health = "incomplete";
      error = incomplete;
    } else if (configured && !enabled) {
      error = "Turned off on the card. The configuration is kept.";
    } else if (config.enabled && configured) {
      error = blockedCause ? `Not started: ${blockedCause}` : NOT_RUNNING;
    }
    return {
      name,
      configured,
      enabled,
      health,
      ...(error ? { error: statusError(error) } : {}),
      webhookUrl: chatSdkWebhookUrl(name),
      ...(mode ? { mode } : {}),
      ...(current?.gateway ? { gateway: current.gateway } : {}),
      ...(name === "discord" && discordGuilds ? { guilds: discordGuilds } : {}),
    };
  });
  return {
    enabled: config.enabled,
    slackClash,
    ...(config.error ? { error: statusError(config.error) } : {}),
    adapters,
  };
}

/** `getWebhookInfo` result as Telegram returns it (subset; unknown keys pass through). */
export type TelegramWebhookInfo = Record<string, unknown> & { url: string };

export class ChatSdkActionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 502,
  ) {
    super(message);
    this.name = "ChatSdkActionError";
  }
}

async function callBotApi(
  baseUrl: string,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await callTelegramBotApi(baseUrl, token, method, body);
  } catch (error) {
    if (error instanceof TelegramBotApiError) throw new ChatSdkActionError(error.message, 502);
    throw error;
  }
}

/**
 * Point the Telegram bot at this swarm's public webhook URL with the
 * configured secret token, then return `getWebhookInfo`. The Bot API base is
 * the one the adapter uses (`resolveAdapterApiUrl`), so tests and local QA hit
 * the fake Bot API.
 */
export async function registerTelegramWebhook(): Promise<{
  webhookUrl: string;
  webhookInfo: TelegramWebhookInfo;
}> {
  const config = await getChatSdkConfig();
  if (!config.enabled) {
    throw new ChatSdkActionError(
      "The Chat SDK channel is disabled (CHAT_SDK_ENABLED is not true). Enable it and restart the API first",
      400,
    );
  }
  if (config.error) throw new ChatSdkActionError(statusError(config.error), 400);
  const telegram = config.adapters.telegram;
  if (!telegram) {
    throw new ChatSdkActionError("Telegram is not configured in CHAT_SDK_ADAPTERS", 400);
  }
  if (telegram.mode !== "webhook") {
    throw new ChatSdkActionError(
      "Telegram runs in polling mode; a registered webhook would stop polling",
      400,
    );
  }
  const secretToken = telegram.secretToken;
  if (typeof secretToken !== "string" || secretToken.length === 0) {
    throw new ChatSdkActionError("Telegram webhook mode needs a secretToken", 400);
  }
  const rawToken = telegram.botToken;
  const token =
    typeof rawToken === "function" ? await (rawToken as () => Promise<string>)() : rawToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new ChatSdkActionError("Telegram botToken is empty", 400);
  }
  const baseUrl = resolveAdapterApiUrl("telegram");
  const webhookUrl = chatSdkWebhookUrl("telegram");
  await callBotApi(baseUrl, token, "setWebhook", { url: webhookUrl, secret_token: secretToken });
  const info = await callBotApi(baseUrl, token, "getWebhookInfo", {});
  if (
    info === null ||
    typeof info !== "object" ||
    typeof (info as { url?: unknown }).url !== "string"
  ) {
    throw new ChatSdkActionError("Telegram getWebhookInfo returned an unexpected result", 502);
  }
  return { webhookUrl, webhookInfo: info as TelegramWebhookInfo };
}
