/**
 * Credential resolver for the internal-ai abstraction.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 0 § "credentials.ts"
 *
 * Context-agnostic: tries env vars first, then optionally probes codex OAuth
 * via HTTP if `apiUrl + apiKey` are provided. Workers pass through
 * `config.apiUrl` / `config.apiKey`; API-server callers pass `MCP_BASE_URL` /
 * `API_KEY` (loopback). Callers that don't want codex-OAuth probing omit both.
 *
 * NO HARNESS CHECK — this resolver is harness-agnostic. The codex-OAuth probe
 * costs one localhost HTTP call, which is fine to attempt on any worker.
 *
 * Worker-safe: uses fetch() only, no bun:sqlite import.
 */

import { isFirstPartyAnthropicUrl } from "@desplega/model-routing";
import {
  InMemoryCredentialStore,
  type OAuthCredential,
  type OAuthCredentials,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getValidCodexOAuth, persistCodexOAuth } from "../../providers/codex-oauth/storage.js";
import { selectCredential } from "../credentials.js";
import { type CredentialKind, DEFAULT_MODEL, resolveRaterModelString } from "./models.js";

registerBunOAuthFlows();

interface OAuthApiKeyResult {
  apiKey: string;
  newCredentials?: OAuthCredentials;
}

type OAuthApiKeyResolver = (
  providerId: string,
  credentials: Record<string, OAuthCredentials>,
) => Promise<OAuthApiKeyResult | null>;

/**
 * Resolve provider-owned OAuth request auth through pi-ai's 0.81 Models API.
 * The in-memory store lets Models perform its locked refresh and exposes any
 * rotated credential so the swarm config store can persist it.
 */
const resolveOAuthApiKey: OAuthApiKeyResolver = async (providerId, credentials) => {
  const input = credentials[providerId];
  if (!input) return null;

  const store = new InMemoryCredentialStore();
  const initial: OAuthCredential = { ...input, type: "oauth" };
  await store.modify(providerId, async () => initial);

  const models = builtinModels({ credentials: store });
  const resolved = await models.getAuth(providerId);
  const apiKey = resolved?.auth.apiKey;
  if (!apiKey) return null;

  const current = await store.read(providerId);
  const changed =
    current?.type === "oauth" &&
    (current.access !== initial.access ||
      current.refresh !== initial.refresh ||
      current.expires !== initial.expires);

  return {
    apiKey,
    newCredentials: changed && current?.type === "oauth" ? current : undefined,
  };
};

/**
 * `modelDefault` is the session-summary / `llm` memory-rater model for the
 * credential kind (`resolveRaterModelString`: `MEMORY_RATER_MODEL` env, else
 * the pinned `MEMORY_RATER_DEFAULT_MODEL`). It is not the general
 * `DEFAULT_MODEL`; callers that want that (workflow LLM nodes) read it directly.
 */
export type ResolvedCredential =
  | {
      kind: "openrouter" | "anthropic" | "openai" | "openai-codex";
      apiKey: string;
      modelDefault: string;
    }
  | {
      kind: "claude-cli";
      modelDefault: string;
      // No apiKey — the `claude` CLI uses CLAUDE_CODE_OAUTH_TOKEN from env directly.
    };

export interface ResolveCredentialOptions {
  /** Defaulted to `process.env`; injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Optional: enables codex-OAuth lookup over HTTP. */
  apiUrl?: string;
  /** Optional: paired with apiUrl. */
  apiKey?: string;
  /** Optional log tag — purely for diagnostics, not load-bearing. */
  callerTag?: string;
  /** Test injection: override the codex OAuth lookup. */
  _getValidCodexOAuth?: typeof getValidCodexOAuth;
  /** Test injection: override pi-ai's provider-owned OAuth auth resolution. */
  _getOAuthApiKey?: OAuthApiKeyResolver;
  /** Test injection: override pi-ai's env API key lookup. */
  _getEnvApiKey?: typeof getEnvApiKey;
  /** Test injection: override the persistCodexOAuth call. */
  _persistCodexOAuth?: typeof persistCodexOAuth;
}

/**
 * Credential kinds in precedence order. `resolveCredentials` walks this list;
 * `resolveCredential` returns the first hit.
 */
export const CREDENTIAL_KIND_PRECEDENCE: readonly CredentialKind[] = [
  "openrouter",
  "anthropic",
  "openai",
  "openai-codex",
  "claude-cli",
];

export interface ResolveCredentialsOptions extends ResolveCredentialOptions {
  /**
   * Only resolve these kinds (in precedence order). Lets a caller probe one
   * provider at a time, so the codex OAuth lookup (an HTTP call that can
   * rotate a refresh token) runs only when that kind is actually needed.
   * Default: every kind.
   */
  kinds?: readonly CredentialKind[];
  /** Stop after this many credentials. Default: no limit. */
  limit?: number;
}

/**
 * Resolve a credential according to the documented precedence. Returns `null`
 * if no credential could be resolved — callers MUST treat null as a graceful
 * no-op (do NOT throw; structured-output completion is a best-effort path).
 *
 * Precedence (top wins):
 *   1. `env.OPENROUTER_API_KEY` (via pi-ai `getEnvApiKey("openrouter")`)
 *   2. `env.ANTHROPIC_API_KEY`  (via pi-ai `getEnvApiKey("anthropic")`), unless
 *      `ANTHROPIC_BASE_URL` points at a gateway (the key is the gateway's)
 *   3. `env.OPENAI_API_KEY`     (via pi-ai `getEnvApiKey("openai")`)
 *   4. codex OAuth (only when `apiUrl && apiKey` are provided)
 *   5. `env.CLAUDE_CODE_OAUTH_TOKEN` → claude-cli fallback
 *   6. null
 */
export async function resolveCredential(
  opts: ResolveCredentialOptions = {},
): Promise<ResolvedCredential | null> {
  const [first] = await resolveCredentials({ ...opts, limit: 1 });
  return first ?? null;
}

/**
 * Every credential the environment offers, in the precedence order documented
 * on {@link resolveCredential}. Callers that can fall back across providers
 * (task titles) walk the list; `resolveCredential` is the `limit: 1` case.
 * The codex OAuth probe runs only when `openai-codex` is reached, so an env
 * key ahead of it (or `kinds` that exclude it) never triggers the HTTP call.
 */
export async function resolveCredentials(
  opts: ResolveCredentialsOptions = {},
): Promise<ResolvedCredential[]> {
  const env = opts.env ?? process.env;
  const getEnvKey = opts._getEnvApiKey ?? getEnvApiKey;
  const wanted = opts.kinds ?? CREDENTIAL_KIND_PRECEDENCE;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const found: ResolvedCredential[] = [];

  for (const kind of CREDENTIAL_KIND_PRECEDENCE) {
    if (found.length >= limit) break;
    if (!wanted.includes(kind)) continue;
    const cred = await resolveKind(kind, opts, env, getEnvKey);
    if (cred) found.push(cred);
  }
  return found;
}

async function resolveKind(
  kind: CredentialKind,
  opts: ResolveCredentialOptions,
  env: NodeJS.ProcessEnv,
  getEnvKey: typeof getEnvApiKey,
): Promise<ResolvedCredential | null> {
  switch (kind) {
    case "openrouter": {
      const key = env.OPENROUTER_API_KEY ?? getEnvKey("openrouter");
      if (!key) return null;
      return {
        kind,
        apiKey: selectCredential(key, undefined, "OPENROUTER_API_KEY").selected,
        modelDefault: resolveRaterModelString(kind),
      };
    }
    case "anthropic": {
      // pi-ai sends this key to api.anthropic.com, so skip it when
      // ANTHROPIC_BASE_URL names a gateway: the key belongs to the gateway (#1800).
      const anthropicBaseUrl = env.ANTHROPIC_BASE_URL?.trim();
      const keyIsForGateway =
        Boolean(anthropicBaseUrl) && !isFirstPartyAnthropicUrl(anthropicBaseUrl ?? "");
      const key = keyIsForGateway ? undefined : (env.ANTHROPIC_API_KEY ?? getEnvKey("anthropic"));
      if (!key) return null;
      return {
        kind,
        apiKey: selectCredential(key, undefined, "ANTHROPIC_API_KEY").selected,
        modelDefault: resolveRaterModelString(kind),
      };
    }
    case "openai": {
      const key = env.OPENAI_API_KEY ?? getEnvKey("openai");
      if (!key) return null;
      return {
        kind,
        apiKey: selectCredential(key, undefined, "OPENAI_API_KEY").selected,
        modelDefault: resolveRaterModelString(kind),
      };
    }
    case "openai-codex":
      // Only if we have apiUrl + apiKey to probe the config store.
      if (!opts.apiUrl || !opts.apiKey) return null;
      return resolveCodexOAuthCredential(opts, opts.apiUrl, opts.apiKey);
    case "claude-cli":
      // `AGENT_SWARM_CLAUDE_OAUTH_TOKEN` is the mirror set by claude-adapter.ts
      // before spawning `claude` — the CLI strips `CLAUDE_CODE_OAUTH_TOKEN` from
      // hook subprocesses (security), so the hook reads the mirror instead.
      if (!env.AGENT_SWARM_CLAUDE_OAUTH_TOKEN && !env.CLAUDE_CODE_OAUTH_TOKEN) return null;
      return { kind, modelDefault: resolveRaterModelString(kind) };
  }
}

async function resolveCodexOAuthCredential(
  opts: ResolveCredentialOptions,
  apiUrl: string,
  apiKey: string,
): Promise<ResolvedCredential | null> {
  const getCodex = opts._getValidCodexOAuth ?? getValidCodexOAuth;
  const getOAuth = opts._getOAuthApiKey ?? resolveOAuthApiKey;
  const persistCodex = opts._persistCodexOAuth ?? persistCodexOAuth;
  try {
    const codexCreds = await getCodex(apiUrl, apiKey);
    if (!codexCreds) return null;
    // pi-ai expects a Record<providerID, OAuthCredentials>.
    const credMap: Record<string, OAuthCredentials> = {
      "openai-codex": {
        access: codexCreds.access,
        refresh: codexCreds.refresh,
        expires: codexCreds.expires,
      },
    };
    const oauthResult = await getOAuth("openai-codex", credMap);
    if (!oauthResult) return null;
    // Persist any rotated refresh token — best-effort, must not block.
    // Wrap defensively here even though the production helper already
    // swallows; tests may inject a throwing hook, and persistence
    // failure must never prevent the current call from succeeding.
    if (oauthResult.newCredentials) {
      const updated = oauthResult.newCredentials;
      try {
        await persistCodex(apiUrl, apiKey, {
          access: String(updated.access),
          refresh: String(updated.refresh),
          expires: Number(updated.expires),
          accountId: codexCreds.accountId,
        });
      } catch (err) {
        console.error(
          `internal-ai: persistCodexOAuth failed (callerTag=${opts.callerTag ?? "<unset>"}):`,
          err,
        );
      }
    }
    return {
      kind: "openai-codex",
      apiKey: oauthResult.apiKey,
      modelDefault: resolveRaterModelString("openai-codex"),
    };
  } catch (err) {
    console.error(
      `internal-ai: codex OAuth probe failed (callerTag=${opts.callerTag ?? "<unset>"}):`,
      err,
    );
    // The caller falls through to the claude-cli fallback.
    return null;
  }
}

// Re-export for convenience to keep imports flat.
export { DEFAULT_MODEL };
export type { CredentialKind };
