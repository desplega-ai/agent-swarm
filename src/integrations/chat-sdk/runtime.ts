import { createHash } from "node:crypto";
import type { Chat } from "chat";
import { isEnvFlagEnabled } from "@/utils/env-flag";
import { registerVolatileSecret, scrubSecrets } from "@/utils/secret-scrubber";
import { loadAdapter, watchSocketConnection } from "./adapters";
import { drainBackground } from "./background";
import { registerTelegramCommands } from "./commands";
import {
  assertNoSlackClash,
  CHAT_SDK_ADAPTER_NAMES,
  type ChatSdkAdapterName,
  type ChatSdkConfig,
  getChatSdkConfig,
  type ResolvedAdapterConfig,
} from "./config";
import {
  type DiscordGatewayHealth,
  getDiscordGatewayHealth,
  isDiscordGatewayListener,
  resetDiscordGatewayHealth,
  startDiscordGateway,
  stopDiscordGateway,
} from "./discord-gateway";
import { registerChatHandlers } from "./handlers";
import { createScrubbingLogger, errorMessage } from "./logger";
import { startChatRelayWatcher, stopChatRelayWatcher } from "./relay";
import { SqliteChatState } from "./state";
import { getChatSdkTestHooks } from "./test-hooks";
import { flushAllChatBuffers } from "./thread-buffer";
import { stopAllTypingKeepalives } from "./typing";

export interface ChatAdapterHealth {
  status: "ok" | "error";
  error?: string;
  /** Last warn/error line the adapter logged, scrubbed. */
  lastWarning?: string;
  since: string;
  /** Discord only: the supervised Gateway listener loop. */
  gateway?: DiscordGatewayHealth;
}

/**
 * One `Chat` per adapter. `Chat.initialize()` runs every adapter under one
 * `Promise.all` and caches a failure forever, so a shared instance would let one
 * broken adapter take every other adapter down. Health lives here, outside
 * `Chat`, for the same reason.
 */
const instances = new Map<ChatSdkAdapterName, Chat>();
const health = new Map<ChatSdkAdapterName, ChatAdapterHealth>();
let stopping = false;
/** Fingerprint of the config the last `startChatSdk` applied. */
let appliedFingerprint: string | undefined;

/** True while shutdown drains; the webhook path refuses new work. */
export function isChatSdkStopping(): boolean {
  return stopping;
}

const DEFAULT_CHAT_USER_NAME = "swarm";

/** Total wait for every step of `stopChatSdk`, inside the 15 s SIGTERM budget. */
const SHUTDOWN_BUDGET_MS = 10_000;
/** A config reload waits this long for the adapters to come back before it answers. */
const RELOAD_START_BUDGET_MS = 15_000;

/** Fields whose string value is a credential, registered with the scrubber. */
const SECRET_FIELDS = ["botToken", "secretToken", "signingSecret", "appToken", "appPassword"];

function setHealth(
  name: ChatSdkAdapterName,
  status: "ok" | "error",
  error: string | undefined,
  lastWarning: string | undefined,
): void {
  health.set(name, { status, error, lastWarning, since: new Date().toISOString() });
}

/**
 * Raw values in `CHAT_SDK_ADAPTERS` (env-only deployments) are not named by a
 * sensitive env key, so the scrubber would not know them. `$config`-resolved
 * secret rows are already registered by `loadGlobalConfigsIntoEnv`.
 */
async function registerAdapterSecrets(
  name: ChatSdkAdapterName,
  config: ResolvedAdapterConfig,
): Promise<void> {
  for (const field of SECRET_FIELDS) {
    const raw = config[field];
    const value = typeof raw === "function" ? await (raw as () => Promise<string>)() : raw;
    if (typeof value === "string") {
      registerVolatileSecret(value, `chat-sdk:${name}:${field}`);
    }
  }
}

async function startAdapter(
  name: ChatSdkAdapterName,
  config: ResolvedAdapterConfig,
  state: SqliteChatState,
  ChatClass: typeof Chat,
): Promise<void> {
  let lastWarning: string | undefined;
  // No level prefix on the stored line: the message already says what failed,
  // and the status payload carries the tone separately.
  const logger = createScrubbingLogger(name, (_level, message) => {
    lastWarning = message;
    const current = health.get(name);
    if (current) health.set(name, { ...current, lastWarning });
  });
  try {
    await registerAdapterSecrets(name, config);
    const adapter = await loadAdapter(name, config, logger);
    const chat = new ChatClass({
      adapters: { [name]: adapter },
      state,
      // Chat requires a userName. The adapter only gets one when the operator
      // set it, so Telegram can still take the real bot name from getMe.
      userName: typeof config.userName === "string" ? config.userName : DEFAULT_CHAT_USER_NAME,
      logger,
      // The swarm buffers bursts itself (Phase 2). The SDK "queue" strategy
      // would keep only the latest queued message and skip the rest.
      concurrency: "concurrent",
    });
    registerChatHandlers(chat);
    instances.set(name, chat);
    await chat.initialize();
    // Shutdown began while this adapter initialized: do not mark it ready or
    // start the Gateway after `stopChatSdk` already stopped it.
    if (stopping) {
      console.log(`[chat-sdk] ${name} initialized during shutdown, not started`);
      return;
    }
    watchSocketConnection(adapter, logger);
    if (name === "telegram") {
      // The `/` menu in Telegram clients. The commands work without it.
      try {
        await registerTelegramCommands(config);
      } catch (error) {
        logger.warn(`Could not register the Telegram commands: ${errorMessage(error)}`);
      }
    }
    setHealth(name, "ok", undefined, lastWarning);
    console.log(`[chat-sdk] ${name} ready`);
    // Discord messages arrive only over the Gateway, never the webhook.
    if (
      name === "discord" &&
      isDiscordGatewayListener(adapter) &&
      !getChatSdkTestHooks().disableDiscordGateway
    ) {
      startDiscordGateway(adapter);
    }
  } catch (error) {
    setHealth(name, "error", errorMessage(error), lastWarning);
    console.error(`[chat-sdk] ${name} failed to start: ${errorMessage(error)}`);
  }
}

/**
 * Boot the Chat SDK channel. Never throws for config or adapter problems: they
 * are logged and recorded in health, and the API keeps booting.
 */
export async function startChatSdk(): Promise<void> {
  stopping = false;
  const config = await getChatSdkConfig();
  appliedFingerprint = await configFingerprint(config);
  if (!config.enabled) {
    console.log("[chat-sdk] Disabled (CHAT_SDK_ENABLED is not true)");
    return;
  }
  if (config.error) {
    console.error(`[chat-sdk] Not started: ${scrubSecrets(config.error)}`);
    return;
  }
  try {
    assertNoSlackClash(config);
  } catch (error) {
    console.error(`[chat-sdk] Not started: ${errorMessage(error)}`);
    return;
  }
  for (const [name, reason] of Object.entries(config.incomplete ?? {})) {
    console.warn(`[chat-sdk] ${name} not started, incomplete: ${scrubSecrets(reason)}`);
  }
  const { Chat: ChatClass } = await import("chat");
  const state = new SqliteChatState();
  // In parallel: one slow adapter (Slack's WebClient retries auth.test for
  // up to ~30 min on errors) must not delay the others.
  // Before the adapters: rows for an adapter still initializing are skipped
  // without counting an attempt, and pending rows from before a restart drain
  // as soon as their adapter is up.
  startChatRelayWatcher();
  await Promise.all(
    CHAT_SDK_ADAPTER_NAMES.map(async (name) => {
      const adapterConfig = config.adapters[name];
      if (adapterConfig) await startAdapter(name, adapterConfig, state, ChatClass);
    }),
  );
}

/** Only adapters whose `initialize()` succeeded serve webhooks. */
export function getChatInstance(name: string): Chat | undefined {
  const adapterName = name as ChatSdkAdapterName;
  return health.get(adapterName)?.status === "ok" ? instances.get(adapterName) : undefined;
}

/** True when the adapter is configured (started, even if it failed). */
export function isChatAdapterConfigured(name: string): boolean {
  return health.has(name as ChatSdkAdapterName);
}

export function getChatSdkHealth(): Partial<Record<ChatSdkAdapterName, ChatAdapterHealth>> {
  const out: Partial<Record<ChatSdkAdapterName, ChatAdapterHealth>> = Object.fromEntries(health);
  const gateway = getDiscordGatewayHealth();
  if (out.discord && gateway) out.discord = { ...out.discord, gateway };
  return out;
}

/**
 * Wait for `work`, at most `ms`. Never rejects: a rejection is logged, and a
 * timeout logs the abandoned step. Returns true when `work` settled in time.
 */
async function withTimeout(work: Promise<unknown>, ms: number, step: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = work.then(
    () => true as const,
    (error: unknown) => {
      console.error(`[chat-sdk] ${step} failed: ${errorMessage(error)}`);
      return true as const;
    },
  );
  try {
    const done = await Promise.race([settled, timeout]);
    if (!done) console.warn(`[chat-sdk] Shutdown budget spent, abandoned: ${step}`);
    return done;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop the channel inside one deadline (`budgetMs`, injectable for tests). Every
 * wait below uses the time that is left, so a stuck platform call cannot hold
 * the API shutdown.
 */
export async function stopChatSdk(budgetMs: number = SHUTDOWN_BUDGET_MS): Promise<void> {
  // Ingress first: webhooks answer 503 and refuse new work from here.
  stopping = true;
  stopAllTypingKeepalives();
  const deadline = Date.now() + budgetMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  // No new relay tick or claim from here. The wait for an in-flight send comes
  // after the inbound flush, so a stuck send cannot use the flush's budget.
  const relayStopped = stopChatRelayWatcher();
  // Discord has no `disconnect()`, so `chat.shutdown()` would leave the
  // Gateway open. Abort it before the drain: the open window is tracked
  // background work, so the drain bounds the wait for it to close.
  stopDiscordGateway();
  // Let in-flight handlers finish buffering, then turn waiting threads into
  // tasks while adapters and the DB are still up. Buffered messages exist only
  // in memory: threads not flushed in time are lost (logged).
  let drained = await drainBackground(remaining());
  drained =
    (await withTimeout(
      flushAllChatBuffers(),
      remaining(),
      "inbound buffer flush (threads not yet turned into tasks are lost)",
    )) && drained;
  drained = (await drainBackground(remaining())) && drained;
  // The relay posts through the adapters, so it must end before they shut
  // down. An abandoned send keeps its claimed row: it retries after restart.
  await withTimeout(
    relayStopped,
    remaining(),
    "in-flight relay send (its obligation stays pending and retries after restart)",
  );
  await withTimeout(
    Promise.all(
      [...instances].map(async ([name, chat]) => {
        try {
          await chat.shutdown();
        } catch (error) {
          console.error(`[chat-sdk] ${name} shutdown failed: ${errorMessage(error)}`);
        }
      }),
    ),
    remaining(),
    "adapter shutdown",
  );
  instances.clear();
  health.clear();
  resetDiscordGatewayHealth();
  if (!drained) {
    console.warn(
      `[chat-sdk] Background handlers still running after the ${budgetMs / 1000}s shutdown budget`,
    );
  }
}

/**
 * Hash of the resolved config plus `SLACK_DISABLE` (the Slack clash input).
 * Resolver fields are functions, so their values are read first: a rotated
 * `$config` secret changes the hash. The hashed JSON holds secrets: never log it.
 */
async function configFingerprint(config: ChatSdkConfig): Promise<string> {
  const adapters: Record<string, Record<string, unknown>> = {};
  for (const [name, adapterConfig] of Object.entries(config.adapters)) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(adapterConfig ?? {})) {
      fields[key] = typeof value === "function" ? await (value as () => Promise<unknown>)() : value;
    }
    adapters[name] = fields;
  }
  const slackDisabled = isEnvFlagEnabled("SLACK_DISABLE", false);
  // Incomplete adapters are not part of the running state, so editing one
  // does not restart the adapters that run.
  const { incomplete: _incomplete, disabled: _disabled, ...rest } = config;
  return createHash("sha256")
    .update(JSON.stringify({ ...rest, adapters, slackDisabled }))
    .digest("hex");
}

/**
 * Config reload hook: restart the adapters when the config differs from the
 * one the last `startChatSdk` applied, so a dashboard save applies without an
 * API restart. Compared against the applied config, not the pre-reload one:
 * `$config` secrets resolve from the DB, which already holds the new row. An
 * equal config leaves Telegram polling and the Discord Gateway alone. Never
 * throws. Returns true when the restart left at least one adapter configured.
 */
export async function restartChatSdkIfConfigChanged(): Promise<boolean> {
  try {
    if ((await configFingerprint(await getChatSdkConfig())) === appliedFingerprint) return false;
    console.log("[chat-sdk] Configuration changed, restarting adapters");
    await stopChatSdk();
    // Bounded: a Slack adapter can retry auth.test for a long time, and the
    // reload must not hold every later config save behind it. The start
    // continues in the background after the budget.
    const started = await withTimeout(startChatSdk(), RELOAD_START_BUDGET_MS, "start after reload");
    console.log(
      started
        ? `[chat-sdk] Restart done, adapters configured: ${health.size}`
        : "[chat-sdk] Restart still in progress after the reload budget; check the card status",
    );
    return health.size > 0;
  } catch (error) {
    console.error(`[chat-sdk] Restart after configuration change failed: ${errorMessage(error)}`);
    return false;
  }
}
