import { ConfigRefError, resolveConfigRefs } from "@/be/config-refs";
import { getSwarmConfigs } from "@/be/db";
import { isReservedConfigKey } from "@/be/swarm-config-guard";
import { isEnvFlagEnabled } from "@/utils/env-flag";
import {
  CHAT_SDK_ADAPTER_NAMES,
  CHAT_SDK_ADAPTER_SCHEMAS,
  type ChatSdkAdapterName,
  type ChatSdkAdapters,
  ChatSdkAdaptersDraftSchema,
  firstIssueText,
  isAdapterEntryEnabled,
} from "./schema";

export {
  CHAT_SDK_ADAPTER_NAMES,
  type ChatSdkAdapterName,
  type ChatSdkAdapters,
  ChatSdkAdaptersSchema,
} from "./schema";

class ChatSdkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatSdkConfigError";
  }
}

/**
 * Adapter config after `$config` resolution. Resolver-capable fields
 * (`botToken`, `appId`, `applicationId`) are functions, every other field is
 * the plain value. Passed to the adapter factory as-is.
 */
export type ResolvedAdapterConfig = Record<string, unknown>;

export interface ChatSdkConfig {
  enabled: boolean;
  /** Adapters that are complete and resolved. Only these start. */
  adapters: Partial<Record<ChatSdkAdapterName, ResolvedAdapterConfig>>;
  /**
   * Adapters present in `CHAT_SDK_ADAPTERS` that cannot start: a required
   * field is missing (a partial dashboard save) or a `$config` reference does
   * not resolve. The text names the field. The other adapters still start.
   */
  incomplete?: Partial<Record<ChatSdkAdapterName, string>>;
  /** Adapters present with `enabled: false`: configured, kept, not started. */
  disabled?: ChatSdkAdapterName[];
  /** A problem with the whole value (bad JSON, unknown adapter, forbidden key): nothing starts. */
  error?: string;
}

const RESOLVER_FIELDS = new Set(["botToken", "appId", "applicationId"]);

/**
 * Raw `CHAT_SDK_ENABLED` / `CHAT_SDK_ADAPTERS` from `process.env`. Boot runs
 * `loadGlobalConfigsIntoEnv(true)` first, so stored swarm_config rows win over
 * the deployment env (same mechanism as `SLACK_DISABLE`).
 */
function readChatSdkEnv(): { enabled: boolean; adaptersJson: string | undefined } {
  const adaptersJson = process.env.CHAT_SDK_ADAPTERS?.trim();
  return {
    enabled: isEnvFlagEnabled("CHAT_SDK_ENABLED", false),
    adaptersJson: adaptersJson ? adaptersJson : undefined,
  };
}

/** True when `CHAT_SDK_ENABLED` resolves true. Drives the `chat-sdk` capability. */
export function isChatSdkEnabled(): boolean {
  return readChatSdkEnv().enabled;
}

/**
 * Build the `$config` lookup over decrypted global swarm_config rows. Never
 * reads `process.env`: leads can write ordinary global config, and an
 * env-backed lookup would let `{"$config":"API_KEY"}` leave the host.
 */
async function buildSwarmConfigLookup(): Promise<(key: string) => string | undefined> {
  const values = new Map<string, string>();
  for (const row of await getSwarmConfigs({ scope: "global" })) {
    if (typeof row.value === "string" && row.value.length > 0) values.set(row.key, row.value);
  }
  return (key) => {
    if (isReservedConfigKey(key)) {
      throw new ChatSdkConfigError(
        `CHAT_SDK_ADAPTERS references reserved key '${key}', which is never resolvable`,
      );
    }
    return values.get(key);
  };
}

function toResolvedAdapterConfig(raw: Record<string, unknown>): ResolvedAdapterConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    // The card's switch, not an adapter option.
    if (key === "enabled") continue;
    out[key] = RESOLVER_FIELDS.has(key) && typeof value === "string" ? async () => value : value;
  }
  return out;
}

/**
 * Parse, validate and resolve the Chat SDK config. A problem with the whole
 * value is returned in `error` with no adapters, so boot can log it and
 * continue. A problem with one adapter (missing field, unresolvable `$config`)
 * lands in `incomplete[name]` and the other adapters still resolve. Other
 * errors (for example DB errors) propagate.
 */
export async function getChatSdkConfig(): Promise<ChatSdkConfig> {
  const { enabled, adaptersJson } = readChatSdkEnv();
  if (!enabled) return { enabled, adapters: {} };
  if (!adaptersJson) {
    return {
      enabled,
      adapters: {},
      error: "CHAT_SDK_ENABLED is true but CHAT_SDK_ADAPTERS is empty",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(adaptersJson);
  } catch {
    // Fixed text: the parser message can quote the input, which may hold an inline token.
    return { enabled, adapters: {}, error: "CHAT_SDK_ADAPTERS is not valid JSON" };
  }
  // The draft shape guards the whole value: unknown adapters and forbidden
  // keys stop everything. Required fields are checked per adapter below.
  const draft = ChatSdkAdaptersDraftSchema.safeParse(parsed);
  if (!draft.success) return { enabled, adapters: {}, error: firstIssueText(draft.error) };

  const lookup = await buildSwarmConfigLookup();
  const adapters: ChatSdkConfig["adapters"] = {};
  const incomplete: NonNullable<ChatSdkConfig["incomplete"]> = {};
  const disabled: ChatSdkAdapterName[] = [];
  for (const name of CHAT_SDK_ADAPTER_NAMES) {
    const entry = draft.data[name];
    if (entry === undefined) continue;
    if (!isAdapterEntryEnabled(entry)) {
      disabled.push(name);
      continue;
    }
    const validated = CHAT_SDK_ADAPTER_SCHEMAS[name].safeParse(entry);
    if (!validated.success) {
      incomplete[name] = firstIssueText(validated.error, `CHAT_SDK_ADAPTERS.${name}`, entry);
      continue;
    }
    try {
      const resolved = resolveConfigRefs<ChatSdkAdapters[typeof name]>(
        validated.data as ChatSdkAdapters[typeof name],
        lookup,
      );
      adapters[name] = toResolvedAdapterConfig(resolved as Record<string, unknown>);
    } catch (error) {
      if (!(error instanceof ChatSdkConfigError || error instanceof ConfigRefError)) throw error;
      incomplete[name] = error.message;
    }
  }
  return {
    enabled,
    adapters,
    ...(Object.keys(incomplete).length > 0 ? { incomplete } : {}),
    ...(disabled.length > 0 ? { disabled } : {}),
  };
}

/**
 * One Slack path per deployment: the Chat SDK Slack adapter requires the
 * built-in Slack integration to be off. Evaluated on resolved config.
 */
export function assertNoSlackClash(config: ChatSdkConfig): void {
  if (config.adapters.slack && !isEnvFlagEnabled("SLACK_DISABLE", false)) {
    throw new ChatSdkConfigError(
      "CHAT_SDK_ADAPTERS.slack conflicts with the built-in Slack integration; set SLACK_DISABLE=true to use the Chat SDK Slack adapter",
    );
  }
}

/**
 * Env-only test/QA base URL overrides, keyed by adapter name
 * (`CHAT_SDK_API_URL_OVERRIDES`, a RESERVED_KEYS entry, so never injected from
 * a config row). Invalid JSON is ignored with an empty result.
 */
export function readApiUrlOverrides(): Partial<Record<ChatSdkAdapterName, string>> {
  const raw = process.env.CHAT_SDK_API_URL_OVERRIDES?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Partial<Record<ChatSdkAdapterName, string>> = {};
    for (const name of CHAT_SDK_ADAPTER_NAMES) {
      const value = (parsed as Record<string, unknown>)[name];
      if (typeof value === "string" && value.length > 0) out[name] = value;
    }
    return out;
  } catch {
    return {};
  }
}
