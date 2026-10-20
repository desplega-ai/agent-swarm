import { DEFAULT_OPENROUTER_BASE_URL, getOpenRouterBaseUrl } from "../../utils/openrouter-base-url";
import type { ExecutorDependencies } from "./base";
import { CLOUDFLARE_EXTRACT_WIRE, type SystemOneExtractWire } from "./system-one-extract-wire";
import { OPENAI_DECISIONS_WIRE } from "./system-one-openai-wire";
import { CLOUDFLARE_WIRE, type SystemOneWire } from "./system-one-wire";
import { resolveWorkflowLlmConfig } from "./workflow-llm";

/**
 * Hosts of System One models. One registry serves every capability: a host
 * declares what it serves (`decide` for typed decisions: Jev, laya, OpenAI
 * Decisions, Cloudflare Clef; `extract` for typed extraction: Cloudflare Clairic)
 * and, per capability, its endpoint, models, limits, and wire. The credential, the
 * deployment check, and every message are the host's, so a decision node and an
 * extraction node on the same host fail with the same sentence.
 *
 * A node names a host by id (`config.provider`); the endpoint, header shape, and
 * key name live here, never in a workflow definition. Adding a host, or a
 * capability to one, is one entry in `SYSTEM_ONE_HOSTS`.
 *
 * Do not add a chat-completions route. OpenRouter's `typesafe/jev-router` is a
 * router that forwards a chat request to another model, and `~typesafe/jev-latest`
 * refuses chat/completions ("is a decisions model"). Only the decisions endpoint
 * runs Jev itself.
 */

export type SystemOneCapability = "decide" | "extract";

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

/**
 * A host whose URL is built from a global config value and the model, e.g. an
 * account id in the path. The value is checked before it reaches the URL.
 */
export interface SystemOneBuiltEndpoint {
  /** Global config key holding the value, e.g. `CLOUDFLARE_ACCOUNT_ID`. */
  readonly configKey: string;
  /** What the value is, for messages: "the account id of a Cloudflare account". */
  readonly describe: string;
  /** Request URL, or null when the value is not usable. `model` is already allowlisted. */
  readonly build: (value: string, model: string) => string | null;
}

export type SystemOneEndpoint = string | SystemOneConfiguredEndpoint | SystemOneBuiltEndpoint;

/** A credential read from config, with the name it was read under. */
export interface SystemOneCredential {
  value: string;
  keyName: string;
}

/** What every capability of a host declares. */
interface SystemOneServiceBase {
  /** A fixed URL, the global config key that names the server, or a URL built from config and model. */
  readonly endpoint: SystemOneEndpoint;
  /**
   * Model used when the node sets none. Absent means no `model` is sent and the
   * host picks, for a host that ignores a model id it does not know.
   */
  readonly defaultModel?: string;
  /** When set, the only model ids the node may use (checked at save and at run). */
  readonly allowedModels?: readonly string[];
}

export interface SystemOneDecideService extends SystemOneServiceBase {
  /** Host limits stricter than the node's own. */
  readonly limits?: { readonly maxQuestions?: number };
  /** Request and response translation. Absent means the SystemOne wire as is. */
  readonly wire?: SystemOneWire;
  /**
   * The field of a `choice` or `score` answer that is the answer's confidence: what
   * the output reports and what a `humanReview` band is tested against.
   */
  readonly confidenceField: "confidence" | "answer_confidence";
}

export interface SystemOneExtractService extends SystemOneServiceBase {
  /** Host limits stricter than the node's own. */
  readonly limits?: { readonly maxFields?: number; readonly maxImages?: number };
  /** Request and response translation. */
  readonly wire: SystemOneExtractWire;
}

export interface SystemOneHost {
  /** Name used in messages, e.g. "TypeSafe". */
  readonly label: string;
  /** The credential this host needs: a global secret name, the one messages tell an author to set. */
  readonly keyName: string;
  /** Other secret names read, in order, when `keyName` is unset. Messages mention them. */
  readonly fallbackKeyNames?: readonly string[];
  /** A deployment setting that makes this host unusable, or null. */
  readonly deploymentProblem?: (env: NodeJS.ProcessEnv) => string | null;
  /**
   * The credential value (a string is read under `keyName`), or null/blank when
   * absent. May throw; callers never relay the cause.
   */
  readonly readKey: (
    ctx: SystemOneProviderContext,
  ) => Promise<SystemOneCredential | string | null | undefined>;
  readonly decide?: SystemOneDecideService;
  readonly extract?: SystemOneExtractService;
}

/**
 * A decision host as one flat record: the host's credential and messages plus its
 * `decide` service. `system-one-decision` reads this shape.
 */
export type SystemOneProvider = Omit<SystemOneHost, "decide" | "extract"> & SystemOneDecideService;

const TYPESAFE_KEY = "TYPESAFE_API_KEY";
const OPENROUTER_KEY = "OPENROUTER_API_KEY";
const LAYA_KEY = "LAYA_API_KEY";
const LAYA_URL_KEY = "LAYA_URL";
const OPENAI_DECISIONS_KEY = "OPENAI_DECISIONS_API_KEY";
const CLOUDFLARE_TOKEN_KEY = "CLOUDFLARE_API_TOKEN";
const CLOUDFLARE_KEY_FALLBACK = "CLOUDFLARE_API_KEY";
const CLOUDFLARE_ACCOUNT_KEY = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_ACCOUNT_RE = /^[0-9a-f]{32}$/;

/** Filter by key and scope in SQL so no other config row is read or decrypted. */
async function readGlobalConfig(
  db: ExecutorDependencies["db"],
  key: string,
): Promise<string | undefined> {
  const rows = await db.getSwarmConfigs({ scope: "global", key });
  return rows.find((row) => row.scope === "global" && row.key === key)?.value;
}

/** The first of `keys` with a non-blank global value, with the key it came from. */
async function readFirstGlobalConfig(
  db: ExecutorDependencies["db"],
  keys: readonly string[],
): Promise<SystemOneCredential | undefined> {
  for (const keyName of keys) {
    const value = await readGlobalConfig(db, keyName);
    if (value && value.trim() !== "") return { value, keyName };
  }
  return undefined;
}

/** Every Workers AI model is reached at the same account-scoped route; only the model differs. */
const CLOUDFLARE_ENDPOINT: SystemOneBuiltEndpoint = {
  configKey: CLOUDFLARE_ACCOUNT_KEY,
  describe: "the 32-character id of a Cloudflare account",
  build: (accountId, model) => {
    const id = accountId.trim();
    return CLOUDFLARE_ACCOUNT_RE.test(id)
      ? `https://api.cloudflare.com/client/v4/accounts/${id}/ai/run/@cf/cloudflare/${model}`
      : null;
  },
};

export const SYSTEM_ONE_HOSTS = {
  typesafe: {
    label: "TypeSafe",
    keyName: TYPESAFE_KEY,
    readKey: ({ db }) => readGlobalConfig(db, TYPESAFE_KEY),
    decide: {
      endpoint: "https://api.typesafe.ai/v1/systemone",
      defaultModel: "jev-latest",
      confidenceField: "confidence",
    },
  },
  openrouter: {
    label: "OpenRouter",
    keyName: OPENROUTER_KEY,
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
    decide: {
      endpoint: "https://openrouter.ai/api/alpha/decisions",
      defaultModel: "~typesafe/jev-latest",
      confidenceField: "confidence",
    },
  },
  laya: {
    label: "laya",
    keyName: LAYA_KEY,
    readKey: ({ db }) => readGlobalConfig(db, LAYA_KEY),
    decide: {
      endpoint: { configKey: LAYA_URL_KEY, path: "/v1/systemone" },
      // No default model. laya answers an id it does not know (`jev-latest` included) by
      // routing on the text instead, with HTTP 200, so a default would be sent as if it meant something.
      // `confidence` on a choice or score is entropy-based (0.47 top probability reads
      // ~0.15). `answer_confidence` is the top probability, the number a `noul` band
      // already uses, so one band means the same thing on every question type.
      confidenceField: "answer_confidence",
    },
  },
  openai: {
    label: "OpenAI",
    // Not OPENAI_API_KEY: a global row of that name reaches every worker's env and
    // can change harness auth. This key serves this node only, and needs Decisions access.
    keyName: OPENAI_DECISIONS_KEY,
    readKey: ({ db }) => readGlobalConfig(db, OPENAI_DECISIONS_KEY),
    decide: {
      endpoint: "https://api.openai.com/v1/decisions",
      defaultModel: "gpt-6-luna",
      // OpenAI's own field; it is not the top probability.
      confidenceField: "confidence",
      wire: OPENAI_DECISIONS_WIRE,
    },
  },
  cloudflare: {
    label: "Cloudflare Workers AI",
    keyName: CLOUDFLARE_TOKEN_KEY,
    // A Workers AI API token is a bearer token whatever the secret is called; a
    // deployment that stored it as CLOUDFLARE_API_KEY works without a rename.
    fallbackKeyNames: [CLOUDFLARE_KEY_FALLBACK],
    readKey: ({ db }) => readFirstGlobalConfig(db, [CLOUDFLARE_TOKEN_KEY, CLOUDFLARE_KEY_FALLBACK]),
    decide: {
      endpoint: CLOUDFLARE_ENDPOINT,
      defaultModel: "clef",
      // The model is part of the URL, so only these ids are accepted.
      allowedModels: ["clef", "clef-flash"],
      limits: { maxQuestions: 64 },
      confidenceField: "confidence",
      wire: CLOUDFLARE_WIRE,
    },
    extract: {
      endpoint: CLOUDFLARE_ENDPOINT,
      defaultModel: "clairic",
      allowedModels: ["clairic"],
      limits: { maxFields: 64, maxImages: 4 },
      wire: CLOUDFLARE_EXTRACT_WIRE,
    },
  },
} as const satisfies Record<string, SystemOneHost>;

export type SystemOneHostId = keyof typeof SYSTEM_ONE_HOSTS;

type HostsServing<C extends SystemOneCapability> = {
  [K in SystemOneHostId]: (typeof SYSTEM_ONE_HOSTS)[K] extends Record<C, object> ? K : never;
}[SystemOneHostId];

/** A host that serves typed decisions. */
export type SystemOneProviderId = HostsServing<"decide">;
/** A host that serves typed extraction. */
export type SystemOneExtractProviderId = HostsServing<"extract">;

function hostsServing<C extends SystemOneCapability>(
  capability: C,
): [HostsServing<C>, ...HostsServing<C>[]] {
  const ids = (Object.keys(SYSTEM_ONE_HOSTS) as SystemOneHostId[]).filter(
    (id) => (SYSTEM_ONE_HOSTS[id] as SystemOneHost)[capability] !== undefined,
  );
  return ids as [HostsServing<C>, ...HostsServing<C>[]];
}

/** The decision view of every host that decides: the host's shared fields plus its `decide` service. */
export const SYSTEM_ONE_PROVIDERS = Object.fromEntries(
  hostsServing("decide").map((id) => {
    const { decide, extract: _extract, ...host } = SYSTEM_ONE_HOSTS[id] as SystemOneHost;
    return [id, { ...host, ...decide }];
  }),
) as {
  [K in SystemOneProviderId]: Omit<(typeof SYSTEM_ONE_HOSTS)[K], "decide" | "extract"> &
    (typeof SYSTEM_ONE_HOSTS)[K]["decide"];
};

export const SYSTEM_ONE_PROVIDER_IDS = hostsServing("decide");
export const SYSTEM_ONE_EXTRACT_PROVIDER_IDS = hostsServing("extract");

export const SYSTEM_ONE_DEFAULT_PROVIDER: SystemOneProviderId = "typesafe";
export const SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER: SystemOneExtractProviderId = "cloudflare";

export function isSystemOneProviderId(value: unknown): value is SystemOneProviderId {
  return (
    typeof value === "string" && (SYSTEM_ONE_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export function isSystemOneExtractProviderId(value: unknown): value is SystemOneExtractProviderId {
  return (
    typeof value === "string" &&
    (SYSTEM_ONE_EXTRACT_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

/** Provider a raw node config selects. Undefined when the field is present but not a known id. */
export function systemOneProviderOf(
  config: Record<string, unknown>,
): SystemOneProviderId | undefined {
  if (config.provider === undefined) return SYSTEM_ONE_DEFAULT_PROVIDER;
  return isSystemOneProviderId(config.provider) ? config.provider : undefined;
}

/** Extraction provider a raw node config selects. Undefined when present but not a known id. */
export function systemOneExtractProviderOf(
  config: Record<string, unknown>,
): SystemOneExtractProviderId | undefined {
  if (config.provider === undefined) return SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER;
  return isSystemOneExtractProviderId(config.provider) ? config.provider : undefined;
}

/** The service a host runs for one capability. Callers pass an id that serves it. */
function serviceOf(id: SystemOneHostId, capability: SystemOneCapability): SystemOneServiceBase {
  const service = (SYSTEM_ONE_HOSTS[id] as SystemOneHost)[capability];
  if (!service) throw new Error(`SystemOne provider "${id}" does not serve ${capability}`);
  return service;
}

// ─── Messages ───────────────────────────────────────────────
//
// Every message names the exact credential and where to set it. They are shared by
// the save-time warning, the run-start stop, and the step itself, so an author
// sees the same sentence wherever the problem surfaces.

/** What a call that failed did not produce, for the end of a message. */
const NOTHING_PRODUCED: Record<SystemOneCapability, string> = {
  decide: "No decision was made.",
  extract: "Nothing was extracted.",
};

export function systemOneNothingProduced(capability: SystemOneCapability): string {
  return NOTHING_PRODUCED[capability];
}

const SET_IT = (keyName: string) =>
  `Set ${keyName} as a global secret on the Secrets page (Settings > Secrets).`;

const SET_URL = (configKey: string) =>
  `Set ${configKey} as a global config value (set-config with scope global).`;

export function systemOneKeyMissingMessage(id: SystemOneHostId): string {
  const { label, keyName, fallbackKeyNames }: SystemOneHost = SYSTEM_ONE_HOSTS[id];
  const also = fallbackKeyNames?.length
    ? ` (${fallbackKeyNames.join(", ")} is read when it is unset, and is not configured either)`
    : "";
  return `${keyName} is not configured${also}. SystemOne provider "${id}" needs a working ${label} API key. ${SET_IT(keyName)}`;
}

export function systemOneKeyUnreadableMessage(id: SystemOneHostId): string {
  // The underlying error can name a config row id; keep the message generic.
  return `Could not read ${SYSTEM_ONE_HOSTS[id].keyName} from swarm config`;
}

export function systemOneKeyMalformedMessage(id: SystemOneHostId, keyName?: string): string {
  const name = keyName ?? SYSTEM_ONE_HOSTS[id].keyName;
  return `${name} is not a valid bearer token value. ${SET_IT(name)}`;
}

/** A 401 or 403 from the host: the key exists but the host does not accept it. */
export function systemOneKeyRejectedMessage(
  id: SystemOneHostId,
  status: number,
  code?: string,
  options: { keyName?: string; capability?: SystemOneCapability } = {},
): string {
  const { label }: SystemOneHost = SYSTEM_ONE_HOSTS[id];
  const keyName = options.keyName ?? SYSTEM_ONE_HOSTS[id].keyName;
  const detail = code ? ` (${code})` : "";
  return (
    `${keyName} was rejected by ${label} (HTTP ${status}${detail}). ` +
    `The key is invalid, revoked, or lacks access to the model. Replace it on the Secrets page (Settings > Secrets). ${NOTHING_PRODUCED[options.capability ?? "decide"]}`
  );
}

function urlKeyOf(endpoint: SystemOneEndpoint): string | null {
  return typeof endpoint === "string" ? null : endpoint.configKey;
}

function isBuiltEndpoint(endpoint: SystemOneEndpoint): endpoint is SystemOneBuiltEndpoint {
  return typeof endpoint !== "string" && "build" in endpoint;
}

/** What a provider's config value names, for messages. */
function urlDescriptionOf(id: SystemOneHostId, endpoint: SystemOneEndpoint): string {
  return isBuiltEndpoint(endpoint)
    ? endpoint.describe
    : `the URL of a ${SYSTEM_ONE_HOSTS[id].label} server`;
}

export function systemOneUrlMissingMessage(
  id: SystemOneHostId,
  capability: SystemOneCapability = "decide",
): string {
  const { endpoint } = serviceOf(id, capability);
  const configKey = urlKeyOf(endpoint) ?? "";
  return `${configKey} is not configured. SystemOne provider "${id}" needs ${urlDescriptionOf(id, endpoint)}. ${SET_URL(configKey)}`;
}

export function systemOneUrlUnreadableMessage(
  id: SystemOneHostId,
  capability: SystemOneCapability = "decide",
): string {
  return `Could not read ${urlKeyOf(serviceOf(id, capability).endpoint) ?? ""} from swarm config`;
}

export function systemOneUrlInvalidMessage(
  id: SystemOneHostId,
  capability: SystemOneCapability = "decide",
): string {
  const { endpoint } = serviceOf(id, capability);
  const configKey = urlKeyOf(endpoint) ?? "";
  // The value is not echoed: a URL can carry a credential.
  if (isBuiltEndpoint(endpoint)) {
    return `${configKey} is not ${endpoint.describe}. ${SET_URL(configKey)}`;
  }
  return `${configKey} is not a usable ${SYSTEM_ONE_HOSTS[id].label} server URL. It must be an https URL (http only for localhost) with no credentials, query, or fragment. ${SET_URL(configKey)}`;
}

/** Why a provider cannot use this model, or null. The value is not echoed: it may come from run input. */
export function systemOneModelProblem(
  id: SystemOneHostId,
  model: string | undefined,
  capability: SystemOneCapability = "decide",
): string | null {
  const { allowedModels } = serviceOf(id, capability);
  if (!allowedModels || (model !== undefined && allowedModels.includes(model))) return null;
  return `SystemOne provider "${id}" serves only the models ${allowedModels.join(", ")}; set model to one of them or leave it unset.`;
}

/** Why a provider cannot take this many questions, or null. */
export function systemOneQuestionLimitProblem(
  id: SystemOneProviderId,
  count: number,
): string | null {
  const max = (SYSTEM_ONE_PROVIDERS[id] as SystemOneProvider).limits?.maxQuestions;
  return max !== undefined && count > max
    ? `SystemOne provider "${id}" takes at most ${max} questions per node; this node has ${count}.`
    : null;
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
  | {
      ok: true;
      apiKey: string;
      endpoint: string;
      /** The secret name the key was read under, for a rejection message. */
      keyName: string;
    }
  | { ok: false; error: string };

export interface SystemOneTargetOverrides {
  /** Replaces the credential lookup. */
  apiKey?: (id: SystemOneHostId) => Promise<string | null | undefined>;
  /** Replaces the lookup of a configured server's base URL (or account id). */
  serverUrl?: (id: SystemOneHostId) => Promise<string | null | undefined>;
  /** The model the call uses, for a host whose URL names it. Defaults to the service's default. */
  model?: string;
  /** Which of the host's services is reached. Defaults to `decide`. */
  capability?: SystemOneCapability;
}

/**
 * Resolve where a provider is reached and the credential it needs, or the message
 * to show when it cannot be used. When both a server URL and a key are missing,
 * both are named in one message. The overrides replace the lookups (tests inject
 * fakes); the deployment check and the blank / malformed / URL checks still apply.
 */
export async function resolveSystemOneTarget(
  id: SystemOneHostId,
  ctx: SystemOneProviderContext,
  overrides: SystemOneTargetOverrides = {},
): Promise<SystemOneTarget> {
  const host: SystemOneHost = SYSTEM_ONE_HOSTS[id];
  const capability = overrides.capability ?? "decide";
  const service = serviceOf(id, capability);
  const deploymentProblem = host.deploymentProblem?.(ctx.env);
  if (deploymentProblem) return { ok: false, error: deploymentProblem };

  const errors: string[] = [];

  let endpoint: string | undefined;
  if (typeof service.endpoint === "string") {
    endpoint = service.endpoint;
  } else {
    const { configKey } = service.endpoint;
    let base: string | null | undefined;
    let readable = true;
    try {
      base = await (overrides.serverUrl
        ? overrides.serverUrl(id)
        : readGlobalConfig(ctx.db, configKey));
    } catch {
      readable = false;
      errors.push(systemOneUrlUnreadableMessage(id, capability));
    }
    if (readable) {
      if (!base || base.trim() === "") {
        errors.push(systemOneUrlMissingMessage(id, capability));
      } else {
        const resolved = isBuiltEndpoint(service.endpoint)
          ? service.endpoint.build(base, overrides.model ?? service.defaultModel ?? "")
          : systemOneEndpointFromBase(base, service.endpoint.path);
        if (resolved) endpoint = resolved;
        else errors.push(systemOneUrlInvalidMessage(id, capability));
      }
    }
  }

  let read: SystemOneCredential | string | null | undefined;
  let keyProblem: string | undefined;
  try {
    read = await (overrides.apiKey ? overrides.apiKey(id) : host.readKey(ctx));
  } catch {
    keyProblem = systemOneKeyUnreadableMessage(id);
  }
  const apiKey = typeof read === "string" ? read : read?.value;
  const keyName = (typeof read === "object" && read?.keyName) || host.keyName;
  if (!keyProblem) {
    if (!apiKey || apiKey.trim() === "") keyProblem = systemOneKeyMissingMessage(id);
    else if (hasWhitespaceOrControl(apiKey)) keyProblem = systemOneKeyMalformedMessage(id, keyName);
  }
  if (keyProblem) errors.push(keyProblem);

  if (errors.length > 0 || !endpoint || !apiKey) return { ok: false, error: errors.join(" ") };
  return { ok: true, apiKey, endpoint, keyName };
}
