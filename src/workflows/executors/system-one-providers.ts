import { DEFAULT_OPENROUTER_BASE_URL, getOpenRouterBaseUrl } from "../../utils/openrouter-base-url";
import type { ExecutorDependencies } from "./base";
import { resolveWorkflowLlmConfig } from "./workflow-llm";

/**
 * Hosts that serve Jev's typed decisions API. A `system-one-decision` node names one by id
 * (`config.provider`); the endpoint, header shape, and key name live here, never
 * in a workflow definition. Both hosts take the same `{ state, model, questions }`
 * request and return the same `{ model, answers, usage }` body, so the answer
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

export interface SystemOneProvider {
  /** Name used in messages, e.g. "TypeSafe". */
  readonly label: string;
  /** The single credential this host needs: a global secret name. */
  readonly keyName: string;
  readonly endpoint: string;
  /** Model used when the node sets none. */
  readonly defaultModel: string;
  /** A deployment setting that makes this host unusable, or null. */
  readonly deploymentProblem?: (env: NodeJS.ProcessEnv) => string | null;
  /** The credential value, or null/blank when absent. May throw; callers never relay the cause. */
  readonly readKey: (ctx: SystemOneProviderContext) => Promise<string | null | undefined>;
}

const TYPESAFE_KEY = "TYPESAFE_API_KEY";
const OPENROUTER_KEY = "OPENROUTER_API_KEY";

export const SYSTEM_ONE_PROVIDERS = {
  typesafe: {
    label: "TypeSafe",
    keyName: TYPESAFE_KEY,
    endpoint: "https://api.typesafe.ai/v1/systemone",
    defaultModel: "jev-latest",
    async readKey({ db }) {
      // Filter by key and scope in SQL so no other config row is read or decrypted.
      const rows = await db.getSwarmConfigs({ scope: "global", key: TYPESAFE_KEY });
      return rows.find((row) => row.scope === "global" && row.key === TYPESAFE_KEY)?.value;
    },
  },
  openrouter: {
    label: "OpenRouter",
    keyName: OPENROUTER_KEY,
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    defaultModel: "~typesafe/jev-latest",
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
} as const satisfies Record<string, SystemOneProvider>;

export type SystemOneProviderId = keyof typeof SYSTEM_ONE_PROVIDERS;

export const SYSTEM_ONE_PROVIDER_IDS = Object.keys(SYSTEM_ONE_PROVIDERS) as [SystemOneProviderId, ...SystemOneProviderId[]];

export const SYSTEM_ONE_DEFAULT_PROVIDER: SystemOneProviderId = "typesafe";

export function isSystemOneProviderId(value: unknown): value is SystemOneProviderId {
  return typeof value === "string" && Object.hasOwn(SYSTEM_ONE_PROVIDERS, value);
}

/** Provider a raw node config selects. Undefined when the field is present but not a known id. */
export function systemOneProviderOf(config: Record<string, unknown>): SystemOneProviderId | undefined {
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
export function systemOneKeyRejectedMessage(id: SystemOneProviderId, status: number, code?: string): string {
  const { label, keyName } = SYSTEM_ONE_PROVIDERS[id];
  const detail = code ? ` (${code})` : "";
  return (
    `${keyName} was rejected by ${label} (HTTP ${status}${detail}). ` +
    `The key is invalid, revoked, or lacks access to the model. Replace it on the Secrets page (Settings > Secrets). No decision was made.`
  );
}

// ─── Credential ─────────────────────────────────────────────

/** A bearer token is one visible token; anything else would break or split the header. */
function hasWhitespaceOrControl(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type SystemOneCredential = { ok: true; apiKey: string } | { ok: false; error: string };

/**
 * Resolve the credential a provider needs, or the message to show when it cannot
 * be used. `override` replaces the lookup (tests inject a fake); the deployment
 * check and the blank / malformed checks still apply.
 */
export async function resolveSystemOneCredential(
  id: SystemOneProviderId,
  ctx: SystemOneProviderContext,
  override?: (id: SystemOneProviderId) => Promise<string | null | undefined>,
): Promise<SystemOneCredential> {
  const provider: SystemOneProvider = SYSTEM_ONE_PROVIDERS[id];
  const deploymentProblem = provider.deploymentProblem?.(ctx.env);
  if (deploymentProblem) return { ok: false, error: deploymentProblem };

  let apiKey: string | null | undefined;
  try {
    apiKey = await (override ? override(id) : provider.readKey(ctx));
  } catch {
    return { ok: false, error: systemOneKeyUnreadableMessage(id) };
  }
  if (!apiKey || apiKey.trim() === "") return { ok: false, error: systemOneKeyMissingMessage(id) };
  if (hasWhitespaceOrControl(apiKey)) return { ok: false, error: systemOneKeyMalformedMessage(id) };
  return { ok: true, apiKey };
}
