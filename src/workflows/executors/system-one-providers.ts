import { DEFAULT_OPENROUTER_BASE_URL, getOpenRouterBaseUrl } from "../../utils/openrouter-base-url";
import type { ExecutorDependencies } from "./base";
import { resolveWorkflowLlmConfig } from "./workflow-llm";

/**
 * Hosts that serve typed decisions (Jev, laya). A `system-one-decision` node names one by id
 * (`config.provider`); the endpoint, header shape, and key name live here, never
 * in a workflow definition. Every host takes the same `{ state, model, questions }`
 * request and returns the same `{ model, answers, usage }` body, so the answer
 * contract in `system-one-decision.ts` is shared. Adding a host is one entry in `SYSTEM_ONE_PROVIDERS`.
 *
 * Do not add a chat-completions route. OpenRouter's `typesafe/jev-router` is a
 * router that forwards a chat request to another model, and `~typesafe/jev-latest`
 * refuses chat/completions ("is a decisions model"). Only the decisions endpoint
 * runs Jev itself.
 */

export interface SystemOneProviderContext {
  db: ExecutorDependencies["db"];
  env: NodeJS.ProcessEnv;
}

/**
 * A host with no fixed address: the base URL is a global config value, and the
 * route lives under it. The workflow still carries no URL.
 */
export interface SystemOneConfiguredEndpoint {
  /** Global config key holding the server's base URL, e.g. `LAYA_URL`. */
  readonly configKey: string;
  /** Route under the base URL, starting with `/`. */
  readonly path: string;
}

export interface SystemOneProvider {
  /** Name used in messages, e.g. "TypeSafe". */
  readonly label: string;
  /** The single credential this host needs: a global secret name. */
  readonly keyName: string;
  /** A fixed URL, or the global config key that names the server. */
  readonly endpoint: string | SystemOneConfiguredEndpoint;
  /**
   * Model used when the node sets none. Absent means no `model` is sent and the
   * host picks, for a host that ignores a model id it does not know.
   */
  readonly defaultModel?: string;
  /**
   * The field of a `choice` or `score` answer that is the answer's confidence: what
   * the output reports and what a `humanReview` band is tested against.
   */
  readonly confidenceField: "confidence" | "answer_confidence";
  /** A deployment setting that makes this host unusable, or null. */
  readonly deploymentProblem?: (env: NodeJS.ProcessEnv) => string | null;
  /** The credential value, or null/blank when absent. May throw; callers never relay the cause. */
  readonly readKey: (ctx: SystemOneProviderContext) => Promise<string | null | undefined>;
}

const TYPESAFE_KEY = "TYPESAFE_API_KEY";
const OPENROUTER_KEY = "OPENROUTER_API_KEY";
const LAYA_KEY = "LAYA_API_KEY";
const LAYA_URL_KEY = "LAYA_URL";

/** Filter by key and scope in SQL so no other config row is read or decrypted. */
async function readGlobalConfig(
  db: ExecutorDependencies["db"],
  key: string,
): Promise<string | undefined> {
  const rows = await db.getSwarmConfigs({ scope: "global", key });
  return rows.find((row) => row.scope === "global" && row.key === key)?.value;
}

export const SYSTEM_ONE_PROVIDERS = {
  typesafe: {
    label: "TypeSafe",
    keyName: TYPESAFE_KEY,
    endpoint: "https://api.typesafe.ai/v1/systemone",
    defaultModel: "jev-latest",
    confidenceField: "confidence",
    readKey: ({ db }) => readGlobalConfig(db, TYPESAFE_KEY),
  },
  openrouter: {
    label: "OpenRouter",
    keyName: OPENROUTER_KEY,
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    defaultModel: "~typesafe/jev-latest",
    confidenceField: "confidence",
    deploymentProblem(env) {
      // A gateway URL means OPENROUTER_API_KEY may be a gateway token, and the
      // decisions API is a sibling of /v1 that a chat gateway need not forward.
      // Refuse rather than send a credential to a host it was not issued for.
      return getOpenRouterBaseUrl(env) === DEFAULT_OPENROUTER_BASE_URL
        ? null
        : 'OPENROUTER_BASE_URL points at a gateway. SystemOne provider "openrouter" calls openrouter.ai directly and is not supported through a gateway; unset OPENROUTER_BASE_URL or use provider "typesafe".';
    },
    async readKey({ env }) {
      try {
        // Same resolver raw-llm uses. requireKind stops it falling through to OPENAI_API_KEY.
        return (await resolveWorkflowLlmConfig(undefined, env, { requireKind: "openrouter" }))
          .apiKey;
      } catch {
        return null;
      }
    },
  },
  laya: {
    label: "laya",
    keyName: LAYA_KEY,
    endpoint: { configKey: LAYA_URL_KEY, path: "/v1/systemone" },
    // No default model. laya answers an id it does not know (`jev-latest` included) by
    // routing on the text instead, with HTTP 200, so a default would be sent as if it meant something.
    // `confidence` on a choice or score is entropy-based (0.47 top probability reads
    // ~0.15). `answer_confidence` is the top probability, the number a `noul` band
    // already uses, so one band means the same thing on every question type.
    confidenceField: "answer_confidence",
    readKey: ({ db }) => readGlobalConfig(db, LAYA_KEY),
  },
} as const satisfies Record<string, SystemOneProvider>;

export type SystemOneProviderId = keyof typeof SYSTEM_ONE_PROVIDERS;

export const SYSTEM_ONE_PROVIDER_IDS = Object.keys(SYSTEM_ONE_PROVIDERS) as [
  SystemOneProviderId,
  ...SystemOneProviderId[],
];

export const SYSTEM_ONE_DEFAULT_PROVIDER: SystemOneProviderId = "typesafe";

export function isSystemOneProviderId(value: unknown): value is SystemOneProviderId {
  return typeof value === "string" && Object.hasOwn(SYSTEM_ONE_PROVIDERS, value);
}

/** Provider a raw node config selects. Undefined when the field is present but not a known id. */
export function systemOneProviderOf(
  config: Record<string, unknown>,
): SystemOneProviderId | undefined {
  if (config.provider === undefined) return SYSTEM_ONE_DEFAULT_PROVIDER;
  return isSystemOneProviderId(config.provider) ? config.provider : undefined;
}

// ─── Messages ───────────────────────────────────────────────
//
// Every message names the exact credential and where to set it. They are shared by
// the save-time warning, the run-start stop, and the step itself, so an author
// sees the same sentence wherever the problem surfaces.

const SET_IT = (keyName: string) =>
  `Set ${keyName} as a global secret on the Secrets page (Settings > Secrets).`;

const SET_URL = (configKey: string) =>
  `Set ${configKey} as a global config value (set-config with scope global).`;

export function systemOneKeyMissingMessage(id: SystemOneProviderId): string {
  const { label, keyName } = SYSTEM_ONE_PROVIDERS[id];
  return `${keyName} is not configured. SystemOne provider "${id}" needs a working ${label} API key. ${SET_IT(keyName)}`;
}

export function systemOneKeyUnreadableMessage(id: SystemOneProviderId): string {
  // The underlying error can name a config row id; keep the message generic.
  return `Could not read ${SYSTEM_ONE_PROVIDERS[id].keyName} from swarm config`;
}

export function systemOneKeyMalformedMessage(id: SystemOneProviderId): string {
  return `${SYSTEM_ONE_PROVIDERS[id].keyName} is not a valid bearer token value. ${SET_IT(SYSTEM_ONE_PROVIDERS[id].keyName)}`;
}

/** A 401 or 403 from the host: the key exists but the host does not accept it. */
export function systemOneKeyRejectedMessage(
  id: SystemOneProviderId,
  status: number,
  code?: string,
): string {
  const { label, keyName } = SYSTEM_ONE_PROVIDERS[id];
  const detail = code ? ` (${code})` : "";
  return (
    `${keyName} was rejected by ${label} (HTTP ${status}${detail}). ` +
    `The key is invalid, revoked, or lacks access to the model. Replace it on the Secrets page (Settings > Secrets). No decision was made.`
  );
}

function urlKeyOf(provider: SystemOneProvider): string | null {
  return typeof provider.endpoint === "string" ? null : provider.endpoint.configKey;
}

export function systemOneUrlMissingMessage(id: SystemOneProviderId): string {
  const provider: SystemOneProvider = SYSTEM_ONE_PROVIDERS[id];
  const configKey = urlKeyOf(provider) ?? "";
  return `${configKey} is not configured. SystemOne provider "${id}" needs the URL of a ${provider.label} server. ${SET_URL(configKey)}`;
}

export function systemOneUrlUnreadableMessage(id: SystemOneProviderId): string {
  return `Could not read ${urlKeyOf(SYSTEM_ONE_PROVIDERS[id]) ?? ""} from swarm config`;
}

export function systemOneUrlInvalidMessage(id: SystemOneProviderId): string {
  const provider: SystemOneProvider = SYSTEM_ONE_PROVIDERS[id];
  const configKey = urlKeyOf(provider) ?? "";
  // The value is not echoed: a URL can carry a credential.
  return `${configKey} is not a usable ${provider.label} server URL. It must be an https URL (http only for localhost) with no credentials, query, or fragment. ${SET_URL(configKey)}`;
}

// ─── Credential and endpoint ────────────────────────────────

/** A bearer token is one visible token; anything else would break or split the header. */
function hasWhitespaceOrControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The full request URL for a configured server, or null when the value is not
 * usable. The credential is sent to this URL, so it must be https (http only for
 * loopback, for local development) and carry no userinfo, query, or fragment.
 */
export function systemOneEndpointFromBase(base: string, path: string): string | null {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !loopback) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}${path}`;
}

export type SystemOneTarget =
  | { ok: true; apiKey: string; endpoint: string }
  | { ok: false; error: string };

export interface SystemOneTargetOverrides {
  /** Replaces the credential lookup. */
  apiKey?: (id: SystemOneProviderId) => Promise<string | null | undefined>;
  /** Replaces the lookup of a configured server's base URL. */
  serverUrl?: (id: SystemOneProviderId) => Promise<string | null | undefined>;
}

/**
 * Resolve where a provider is reached and the credential it needs, or the message
 * to show when it cannot be used. When both a server URL and a key are missing,
 * both are named in one message. The overrides replace the lookups (tests inject
 * fakes); the deployment check and the blank / malformed / URL checks still apply.
 */
export async function resolveSystemOneTarget(
  id: SystemOneProviderId,
  ctx: SystemOneProviderContext,
  overrides: SystemOneTargetOverrides = {},
): Promise<SystemOneTarget> {
  const provider: SystemOneProvider = SYSTEM_ONE_PROVIDERS[id];
  const deploymentProblem = provider.deploymentProblem?.(ctx.env);
  if (deploymentProblem) return { ok: false, error: deploymentProblem };

  const errors: string[] = [];

  let endpoint: string | undefined;
  if (typeof provider.endpoint === "string") {
    endpoint = provider.endpoint;
  } else {
    const { configKey, path } = provider.endpoint;
    let base: string | null | undefined;
    let readable = true;
    try {
      base = await (overrides.serverUrl
        ? overrides.serverUrl(id)
        : readGlobalConfig(ctx.db, configKey));
    } catch {
      readable = false;
      errors.push(systemOneUrlUnreadableMessage(id));
    }
    if (readable) {
      if (!base || base.trim() === "") {
        errors.push(systemOneUrlMissingMessage(id));
      } else {
        const resolved = systemOneEndpointFromBase(base, path);
        if (resolved) endpoint = resolved;
        else errors.push(systemOneUrlInvalidMessage(id));
      }
    }
  }

  let apiKey: string | null | undefined;
  let keyProblem: string | undefined;
  try {
    apiKey = await (overrides.apiKey ? overrides.apiKey(id) : provider.readKey(ctx));
  } catch {
    keyProblem = systemOneKeyUnreadableMessage(id);
  }
  if (!keyProblem) {
    if (!apiKey || apiKey.trim() === "") keyProblem = systemOneKeyMissingMessage(id);
    else if (hasWhitespaceOrControl(apiKey)) keyProblem = systemOneKeyMalformedMessage(id);
  }
  if (keyProblem) errors.push(keyProblem);

  if (errors.length > 0 || !endpoint || !apiKey) return { ok: false, error: errors.join(" ") };
  return { ok: true, apiKey, endpoint };
}
