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

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { getOAuthApiKey } from "@earendil-works/pi-ai/oauth";
import { getValidCodexOAuth, persistCodexOAuth } from "@swarm/credentials";
import { type CredentialKind, DEFAULT_MODEL, resolveModelString } from "./models.js";

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
  /** Test injection: override pi-ai's OAuth-to-API-key resolution. */
  _getOAuthApiKey?: typeof getOAuthApiKey;
  /** Test injection: override pi-ai's env API key lookup. */
  _getEnvApiKey?: typeof getEnvApiKey;
  /** Test injection: override the persistCodexOAuth call. */
  _persistCodexOAuth?: typeof persistCodexOAuth;
}

/**
 * Resolve a credential according to the documented precedence. Returns `null`
 * if no credential could be resolved — callers MUST treat null as a graceful
 * no-op (do NOT throw; structured-output completion is a best-effort path).
 *
 * Precedence (top wins):
 *   1. `env.OPENROUTER_API_KEY` (via pi-ai `getEnvApiKey("openrouter")`)
 *   2. `env.ANTHROPIC_API_KEY`  (via pi-ai `getEnvApiKey("anthropic")`)
 *   3. `env.OPENAI_API_KEY`     (via pi-ai `getEnvApiKey("openai")`)
 *   4. codex OAuth (only when `apiUrl && apiKey` are provided)
 *   5. `env.CLAUDE_CODE_OAUTH_TOKEN` → claude-cli fallback
 *   6. null
 */
export async function resolveCredential(
  opts: ResolveCredentialOptions = {},
): Promise<ResolvedCredential | null> {
  const env = opts.env ?? process.env;
  const getEnvKey = opts._getEnvApiKey ?? getEnvApiKey;
  const getCodex = opts._getValidCodexOAuth ?? getValidCodexOAuth;
  const getOAuth = opts._getOAuthApiKey ?? getOAuthApiKey;
  const persistCodex = opts._persistCodexOAuth ?? persistCodexOAuth;

  // 1. OpenRouter.
  const openrouterKey = env.OPENROUTER_API_KEY ?? getEnvKey("openrouter");
  if (openrouterKey) {
    return {
      kind: "openrouter",
      apiKey: openrouterKey,
      modelDefault: resolveModelString("openrouter"),
    };
  }

  // 2. Anthropic.
  const anthropicKey = env.ANTHROPIC_API_KEY ?? getEnvKey("anthropic");
  if (anthropicKey) {
    return {
      kind: "anthropic",
      apiKey: anthropicKey,
      modelDefault: resolveModelString("anthropic"),
    };
  }

  // 3. OpenAI.
  const openaiKey = env.OPENAI_API_KEY ?? getEnvKey("openai");
  if (openaiKey) {
    return {
      kind: "openai",
      apiKey: openaiKey,
      modelDefault: resolveModelString("openai"),
    };
  }

  // 4. Codex OAuth — only if we have apiUrl + apiKey to probe the config store.
  if (opts.apiUrl && opts.apiKey) {
    try {
      const codexCreds = await getCodex(opts.apiUrl, opts.apiKey);
      if (codexCreds) {
        // pi-ai expects a Record<providerID, OAuthCredentials>.
        const credMap: Record<string, OAuthCredentials> = {
          "openai-codex": {
            access: codexCreds.access,
            refresh: codexCreds.refresh,
            expires: codexCreds.expires,
          },
        };
        const oauthResult = await getOAuth("openai-codex", credMap);
        if (oauthResult) {
          // Persist any rotated refresh token — best-effort, must not block.
          // Wrap defensively here even though the production helper already
          // swallows; tests may inject a throwing hook, and persistence
          // failure must never prevent the current call from succeeding.
          if (oauthResult.newCredentials) {
            const updated = oauthResult.newCredentials;
            try {
              await persistCodex(opts.apiUrl, opts.apiKey, {
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
            modelDefault: resolveModelString("openai-codex"),
          };
        }
      }
    } catch (err) {
      console.error(
        `internal-ai: codex OAuth probe failed (callerTag=${opts.callerTag ?? "<unset>"}):`,
        err,
      );
      // Fall through to claude-cli fallback below.
    }
  }

  // 5. CLAUDE_CODE_OAUTH_TOKEN → claude-cli fallback.
  // `AGENT_SWARM_CLAUDE_OAUTH_TOKEN` is the mirror set by claude-adapter.ts
  // before spawning `claude` — the CLI strips `CLAUDE_CODE_OAUTH_TOKEN` from
  // hook subprocesses (security), so the hook reads the mirror instead.
  if (env.AGENT_SWARM_CLAUDE_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      kind: "claude-cli",
      modelDefault: resolveModelString("claude-cli"),
    };
  }

  // 6. No creds.
  return null;
}

// Re-export for convenience to keep imports flat.
export { DEFAULT_MODEL };
export type { CredentialKind };
