/**
 * Opencode-specific credential resolver for the swarm session-summary path.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 * → Phase 2 § "Opencode `auth.json` resolver"
 *
 * Lives next to `agent-swarm.ts` because the opencode plugin loader runs the
 * file inside opencode's bundled Bun runtime, which does NOT have the
 * agent-swarm package or `@mariozechner/pi-ai` available. So the credential
 * helper is vendored here as a self-contained module — it depends only on
 * `Bun.file` for the auth.json read and on `fetch` for the optional OAuth
 * refresh.
 *
 * Mirrors the precedence order Phase 0 set for `resolveCredential`, then
 * appends opencode's `~/.local/share/opencode/auth.json` store on top. The
 * harness-agnostic resolver (in `src/utils/internal-ai/credentials.ts`) stays
 * dual-use; this module is the opencode-only layer the plugin calls FIRST.
 *
 * Limitations (intentional for Phase 2):
 *   - Only the anthropic OAuth refresh is implemented inline. Other OAuth
 *     providers (openai-codex, etc.) fall through to null — opencode users
 *     with OAuth-only auth will get a graceful no-op summary instead of a
 *     refresh. Documented in the plan's Phase-2 hard-gate notes.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type CredentialKind = "openrouter" | "anthropic" | "openai" | "openai-codex" | "claude-cli";

export type ResolvedCredential =
  | {
      kind: "openrouter" | "anthropic" | "openai" | "openai-codex";
      apiKey: string;
      modelDefault: string;
    }
  | {
      kind: "claude-cli";
      modelDefault: string;
    };

/**
 * Mirrors `src/utils/internal-ai/models.ts:DEFAULT_MODEL`. Kept in lockstep
 * with that source manually since the opencode plugin cannot import it.
 */
const DEFAULT_MODEL: Record<CredentialKind, string> = {
  openrouter: "openrouter/google/gemini-3-flash-preview",
  anthropic: "anthropic/claude-haiku-4-5",
  openai: "openai/gpt-5.4-mini",
  "openai-codex": "openai-codex/gpt-5.4-mini",
  "claude-cli": "haiku",
};

/** Auth-store entry types — mirrors `@opencode-ai/sdk` types.gen.d.ts:1458-1474. */
type OAuthEntry = { type: "oauth"; refresh: string; access: string; expires: number };
type ApiEntry = { type: "api"; key: string };
type WellKnownEntry = { type: "wellknown"; key: string; token: string };
type AuthEntry = OAuthEntry | ApiEntry | WellKnownEntry;

/** Provider IDs we know how to map. TODO: kimi, deepseek, groq, etc. */
type MappedProviderId = "anthropic" | "openrouter" | "openai";

const AUTH_FILE_PATH = `${process.env.HOME ?? ""}/.local/share/opencode/auth.json`;

// ── Public API ────────────────────────────────────────────────────────────────

export interface ResolveOpencodeAuthOptions {
  /** Override the auth.json path — used by tests. */
  authFilePath?: string;
  /** Override the auth.json reader — used by tests. */
  readAuthFile?: (path: string) => Promise<Record<string, AuthEntry> | null>;
  /** Override the auth.json writer — used by tests. */
  writeAuthFile?: (path: string, data: Record<string, AuthEntry>) => Promise<void>;
  /** Override the anthropic OAuth refresh call — used by tests. */
  refreshAnthropicOAuth?: (creds: OAuthEntry) => Promise<{
    access: string;
    refresh: string;
    expires: number;
  } | null>;
}

/**
 * Resolve a usable credential for the session-summary LLM call.
 *
 * Precedence (top wins):
 *   1. `OPENROUTER_API_KEY` env
 *   2. `ANTHROPIC_API_KEY` env
 *   3. `OPENAI_API_KEY` env
 *   4. `auth.json[openrouter]` (ApiAuth/WellKnownAuth/OAuth)
 *   5. `auth.json[anthropic]` (ApiAuth/WellKnownAuth/OAuth)
 *   6. `auth.json[openai]` (ApiAuth/WellKnownAuth/OAuth)
 *   7. null
 *
 * For OAuth entries we attempt an inline refresh (anthropic only). On success,
 * we persist the refreshed credentials back to auth.json before returning.
 * Persistence failure does NOT block the current call from returning a usable
 * apiKey — we log and continue.
 */
export async function resolveOpencodeAuth(
  opts: ResolveOpencodeAuthOptions = {},
): Promise<ResolvedCredential | null> {
  // 1-3: Env vars (matches resolveCredential's precedence).
  if (process.env.OPENROUTER_API_KEY) {
    return {
      kind: "openrouter",
      apiKey: process.env.OPENROUTER_API_KEY,
      modelDefault: DEFAULT_MODEL.openrouter,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      kind: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
      modelDefault: DEFAULT_MODEL.anthropic,
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      kind: "openai",
      apiKey: process.env.OPENAI_API_KEY,
      modelDefault: DEFAULT_MODEL.openai,
    };
  }

  // 4-6: auth.json — read once, scan providers in precedence order.
  const path = opts.authFilePath ?? AUTH_FILE_PATH;
  const reader = opts.readAuthFile ?? defaultReadAuthFile;
  const writer = opts.writeAuthFile ?? defaultWriteAuthFile;
  const refresh = opts.refreshAnthropicOAuth ?? defaultRefreshAnthropic;

  const authMap = await reader(path);
  if (!authMap) return null;

  // Precedence across providers — openrouter wins, then anthropic, then openai.
  const providerOrder: MappedProviderId[] = ["openrouter", "anthropic", "openai"];

  for (const providerID of providerOrder) {
    const entry = authMap[providerID];
    if (!entry) continue;

    if (entry.type === "api") {
      return {
        kind: providerID,
        apiKey: entry.key,
        modelDefault: DEFAULT_MODEL[providerID],
      };
    }
    if (entry.type === "wellknown") {
      return {
        kind: providerID,
        apiKey: entry.token,
        modelDefault: DEFAULT_MODEL[providerID],
      };
    }
    if (entry.type === "oauth") {
      if (providerID !== "anthropic") {
        // Only anthropic OAuth refresh is vendored for Phase 2. Other OAuth
        // providers fall through; the plugin will log "no creds" downstream.
        console.error(
          `[opencode-auth] ${providerID} OAuth not supported in vendored plugin; skipping`,
        );
        continue;
      }
      let refreshed: { access: string; refresh: string; expires: number } | null = null;
      try {
        // If the access token is still valid, use it directly.
        if (entry.expires > Date.now()) {
          refreshed = { access: entry.access, refresh: entry.refresh, expires: entry.expires };
        } else {
          refreshed = await refresh(entry);
        }
      } catch (err) {
        console.error("[opencode-auth] anthropic OAuth refresh failed:", err);
        continue;
      }
      if (!refreshed) continue;

      // Persist rotated tokens back to auth.json before returning. Best-effort
      // — persistence failure must NOT block returning a usable apiKey.
      try {
        const updated: Record<string, AuthEntry> = {
          ...authMap,
          [providerID]: {
            type: "oauth",
            access: refreshed.access,
            refresh: refreshed.refresh,
            expires: refreshed.expires,
          },
        };
        await writer(path, updated);
      } catch (err) {
        console.error("[opencode-auth] failed to persist refreshed auth.json:", err);
      }

      return {
        kind: providerID,
        apiKey: refreshed.access,
        modelDefault: DEFAULT_MODEL[providerID],
      };
    }
  }

  return null;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

async function defaultReadAuthFile(path: string): Promise<Record<string, AuthEntry> | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return (await file.json()) as Record<string, AuthEntry>;
  } catch {
    return null;
  }
}

async function defaultWriteAuthFile(path: string, data: Record<string, AuthEntry>): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 2));
}

/**
 * Minimal anthropic OAuth refresh — POSTs to the public token endpoint.
 * Replicates `pi-ai/dist/utils/oauth/anthropic.js:refreshAnthropicToken` so
 * we don't have to vendor the full pi-ai package.
 */
async function defaultRefreshAnthropic(
  creds: OAuthEntry,
): Promise<{ access: string; refresh: string; expires: number } | null> {
  const res = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refresh,
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", // anthropic public CLI client
    }),
  });
  if (!res.ok) {
    console.error("[opencode-auth] anthropic token endpoint returned", res.status);
    return null;
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!body.access_token || !body.refresh_token || !body.expires_in) {
    return null;
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000,
  };
}

// Re-export for adjacent files in the plugin bundle.
export type { AuthEntry, OAuthEntry, ApiEntry, WellKnownEntry };
