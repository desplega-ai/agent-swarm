/*
 * The System One hosts as Connect › AI providers shows them. A mirror of
 * `SYSTEM_ONE_HOSTS` in `src/workflows/executors/system-one-providers.ts`
 * (the dashboard never imports `src/`). Pure data: no imports, so
 * `src/tests/system-one-hosts-ui-mirror.test.ts` can read it next to the
 * server registry and fail on drift (ids, capabilities, key names, models).
 */

export type SystemOneCapability = "decide" | "extract";

export interface SystemOneServiceView {
  /** Model used when a node sets none. Absent: the host picks. */
  readonly defaultModel?: string;
  /** The only model ids the host accepts, when it has a list. */
  readonly allowedModels?: readonly string[];
}

export interface SystemOneHostView {
  /** The server's host id, the value of a node's `provider`. */
  readonly id: string;
  /** The model family people know it by ("Jev"), or the host name when it has none. */
  readonly family: string;
  /** The host after "via", or null when `family` already names it. */
  readonly via: string | null;
  /** One short line under the name. */
  readonly detail: string;
  /** The secret the host reads. */
  readonly keyName: string;
  /** Read in order when `keyName` is unset. */
  readonly fallbackKeyNames?: readonly string[];
  /** A global config value the endpoint is built from (a server URL, an account id). */
  readonly configKey?: string;
  /**
   * The key is the LLMs tab's OpenRouter pool: the server reads it from its
   * environment, and the LLMs panel adds it.
   */
  readonly sharedWithLlms?: boolean;
  readonly decide?: SystemOneServiceView;
  readonly extract?: SystemOneServiceView;
}

export const SYSTEM_ONE_HOST_VIEWS: readonly SystemOneHostView[] = [
  {
    id: "typesafe",
    family: "Jev",
    via: "TypeSafe",
    detail: "api.typesafe.ai",
    keyName: "TYPESAFE_API_KEY",
    decide: { defaultModel: "jev-latest" },
  },
  {
    id: "openrouter",
    family: "Jev",
    via: "OpenRouter",
    detail: "openrouter.ai, with no gateway",
    keyName: "OPENROUTER_API_KEY",
    sharedWithLlms: true,
    decide: { defaultModel: "~typesafe/jev-latest" },
  },
  {
    id: "cloudflare",
    family: "Clef",
    via: "Cloudflare",
    detail: "Workers AI, also Clairic for extraction",
    keyName: "CLOUDFLARE_API_TOKEN",
    fallbackKeyNames: ["CLOUDFLARE_API_KEY"],
    configKey: "CLOUDFLARE_ACCOUNT_ID",
    decide: { defaultModel: "clef", allowedModels: ["clef", "clef-flash"] },
    extract: { defaultModel: "clairic", allowedModels: ["clairic"] },
  },
  {
    id: "laya",
    family: "laya",
    via: null,
    detail: "Your own laya server",
    keyName: "LAYA_API_KEY",
    configKey: "LAYA_URL",
    decide: {},
  },
  {
    id: "openai",
    family: "OpenAI",
    via: null,
    detail: "api.openai.com decisions",
    keyName: "OPENAI_DECISIONS_API_KEY",
    decide: { defaultModel: "gpt-6-luna" },
  },
];

/** Global config keys of the two defaults (server: `SYSTEM_ONE_*_DEFAULT_PROVIDER_CONFIG_KEY`). */
export const SYSTEM_ONE_DECIDE_DEFAULT_KEY = "SYSTEM_ONE_DEFAULT_PROVIDER";
export const SYSTEM_ONE_EXTRACT_DEFAULT_KEY = "SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER";

/** The host a node uses when neither it nor the config names one. */
export const SYSTEM_ONE_FALLBACK: Record<SystemOneCapability, string> = {
  decide: "typesafe",
  extract: "cloudflare",
};

export function systemOneHostsServing(capability: SystemOneCapability): SystemOneHostView[] {
  return SYSTEM_ONE_HOST_VIEWS.filter((host) => host[capability] !== undefined);
}

/** "Jev via TypeSafe", or "laya". */
export function systemOneHostName(host: SystemOneHostView): string {
  return host.via ? `${host.family} via ${host.via}` : host.family;
}

/** The extraction model of a host that also decides, as the selector names it. */
export function systemOneHostLabel(host: SystemOneHostView, capability: SystemOneCapability) {
  if (capability === "extract" && host.extract?.defaultModel) {
    const model = host.extract.defaultModel;
    return `${model.charAt(0).toUpperCase()}${model.slice(1)} via ${host.via ?? host.family}`;
  }
  return systemOneHostName(host);
}

/** The models of one service: its list, else its default. */
export function systemOneServiceModels(service?: SystemOneServiceView): string[] {
  if (!service) return [];
  return [...(service.allowedModels ?? (service.defaultModel ? [service.defaultModel] : []))];
}

/** The models a host serves, decide first, for search. */
export function systemOneModels(host: SystemOneHostView): string[] {
  return [...systemOneServiceModels(host.decide), ...systemOneServiceModels(host.extract)];
}

/** Every key the host needs set: its secret (or a fallback) and its config value. */
export function systemOneRequiredKeys(host: SystemOneHostView): string[][] {
  const secret = [host.keyName, ...(host.fallbackKeyNames ?? [])];
  return host.configKey ? [secret, [host.configKey]] : [secret];
}
