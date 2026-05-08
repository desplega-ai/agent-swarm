/**
 * Provider-agnostic credential check dispatcher.
 *
 * Used by:
 * - The worker boot loop (`src/commands/credential-wait.ts`) to decide
 *   whether the worker can claim tasks yet.
 * - The dashboard credential-status endpoint, which surfaces the per-provider
 *   `missing[]` list as a "blocked on …" hint.
 *
 * The predicate functions live alongside their adapters so they evolve
 * together; this module is a thin switch with documentation/UI hints
 * exported as a static map for the credential-status API.
 */

import { scrubSecrets } from "../utils/secret-scrubber";
import { checkClaudeCredentials } from "./claude-adapter";
import { checkClaudeManagedCredentials } from "./claude-managed-adapter";
import { checkCodexCredentials } from "./codex-adapter";
import { checkDevinCredentials } from "./devin-adapter";
import { checkOpencodeCredentials } from "./opencode-adapter";
import { checkPiMonoCredentials } from "./pi-mono-adapter";
import type { CredCheckOptions, CredStatus } from "./types";

export type SupportedProvider = "claude" | "claude-managed" | "codex" | "devin" | "opencode" | "pi";

/**
 * Static documentation of which env vars each provider considers when running
 * `checkCredentials`. Used by the dashboard to render hints before any worker
 * has reported its dynamic state. The arrays are illustrative — the real
 * authoritative answer always comes from the predicate function (which may
 * fold in `MODEL_OVERRIDE`-conditional logic for pi/opencode and file-based
 * fallbacks for codex/pi/opencode).
 */
export const REQUIRED_CRED_VARS_BY_PROVIDER: Record<SupportedProvider, readonly string[]> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  "claude-managed": [
    "ANTHROPIC_API_KEY",
    "MANAGED_AGENT_ID",
    "MANAGED_ENVIRONMENT_ID",
    "MCP_BASE_URL",
  ],
  codex: ["OPENAI_API_KEY", "CODEX_OAUTH"],
  devin: ["DEVIN_API_KEY", "DEVIN_ORG_ID"],
  opencode: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  pi: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"],
};

/**
 * Run the predicate for `provider`. Unknown providers throw — call sites
 * should treat that as a configuration bug, not a user-correctable state.
 */
export function checkProviderCredentials(
  provider: string,
  env: Record<string, string | undefined>,
  opts?: CredCheckOptions,
): CredStatus {
  switch (provider) {
    case "claude":
      return checkClaudeCredentials(env);
    case "claude-managed":
      return checkClaudeManagedCredentials(env);
    case "codex":
      return checkCodexCredentials(env, opts);
    case "devin":
      return checkDevinCredentials(env);
    case "opencode":
      return checkOpencodeCredentials(env, opts);
    case "pi":
      return checkPiMonoCredentials(env, opts);
    default:
      throw new Error(
        `checkProviderCredentials: unknown provider "${provider}". Supported: claude, claude-managed, codex, devin, opencode, pi.`,
      );
  }
}

// ─── Live "Test connection" dispatcher ───────────────────────────────────────
// Used by `POST /status/test-connection` on the home page setup checklist.
// Mirrors `checkProviderCredentials` but issues a real (cheapest possible)
// upstream call so the user can flip the `harness` milestone to `verified`.
//
// Pure function — no DB writes. Lives here (not on `ProviderAdapter`) because
// adapters are runtime-loaded by workers, while this dispatcher is API-server
// safe. All errors run through `scrubSecrets` so we never leak the user's
// own key shape back through the JSON response.

const LIVE_TEST_TIMEOUT_MS = 5_000;

export interface LiveValidationResult {
  ok: boolean;
  error?: string;
  latency_ms: number;
}

async function timedFetch(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; bodyText: string; latency_ms: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      // ignore body read errors — status alone is enough for ok/not-ok
    }
    return {
      ok: res.ok,
      status: res.status,
      bodyText,
      latency_ms: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

function asLiveError(err: unknown, latency_ms: number): LiveValidationResult {
  const raw = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: scrubSecrets(raw) || "Unknown error",
    latency_ms,
  };
}

// ─── Per-endpoint live-call helpers ──────────────────────────────────────────
// Each helper accepts the auth material it needs and returns a normalized
// `LiveValidationResult`. The harness-level dispatcher below picks which
// helper to call based on which credential is actually present, so OAuth
// users no longer see "ANTHROPIC_API_KEY is not set" when their adapter is
// happily running off `CLAUDE_CODE_OAUTH_TOKEN`.

async function checkAnthropicApiKey(apiKey: string): Promise<LiveValidationResult> {
  const r = await timedFetch("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (r.ok) return { ok: true, latency_ms: r.latency_ms };
  return {
    ok: false,
    error: scrubSecrets(`HTTP ${r.status}: ${r.bodyText.slice(0, 200)}`),
    latency_ms: r.latency_ms,
  };
}

/**
 * OAuth credentials (Claude Pro/Max via `claude` CLI login, ChatGPT via Codex
 * OAuth) are treated as a presence check — we don't issue a live upstream call.
 *
 * Why: OAuth flows include their own refresh logic (handled at adapter boot,
 * not here), the OAuth-bearer-with-/v1/models contract isn't a stable public
 * surface, and a "real" check that fails on a stale-but-refreshable token
 * would be a worse UX than a presence check that passes optimistically. The
 * runtime adapter remains the source of truth.
 */
function presenceCheckOk(): LiveValidationResult {
  return { ok: true, latency_ms: 0 };
}

async function checkOpenAiApiKey(apiKey: string): Promise<LiveValidationResult> {
  const r = await timedFetch("https://api.openai.com/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (r.ok) return { ok: true, latency_ms: r.latency_ms };
  return {
    ok: false,
    error: scrubSecrets(`HTTP ${r.status}: ${r.bodyText.slice(0, 200)}`),
    latency_ms: r.latency_ms,
  };
}

async function checkOpenRouter(apiKey: string): Promise<LiveValidationResult> {
  const r = await timedFetch("https://openrouter.ai/api/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (r.ok) return { ok: true, latency_ms: r.latency_ms };
  return {
    ok: false,
    error: scrubSecrets(`HTTP ${r.status}: ${r.bodyText.slice(0, 200)}`),
    latency_ms: r.latency_ms,
  };
}

/**
 * Extract the OAuth `access_token` from a `CODEX_OAUTH` env blob. The blob is
 * a JSON object shaped like `CodexOAuthCredentials` (`{access, refresh,
 * expires, accountId}`) — see `src/providers/codex-oauth/types.ts`. Returns
 * null on any parse / shape failure (caller falls back to API-key path).
 */
function parseCodexOAuthAccess(blob: string | undefined): string | null {
  if (!blob) return null;
  try {
    const parsed = JSON.parse(blob);
    if (typeof parsed?.access === "string" && parsed.access.length > 0) return parsed.access;
  } catch {
    // not JSON — caller falls back
  }
  return null;
}

/**
 * Issue the cheapest live call per provider to verify credentials work.
 *
 * Credential acceptance is kept in sync with `REQUIRED_CRED_VARS_BY_PROVIDER`
 * and each adapter's `checkCredentials` function:
 *
 * | Harness          | Accepted credentials (in resolution order)                              | Endpoint                       |
 * |------------------|-------------------------------------------------------------------------|--------------------------------|
 * | `claude`         | `CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max OAuth) → `ANTHROPIC_API_KEY`         | Anthropic `/v1/models`         |
 * | `claude-managed` | `ANTHROPIC_API_KEY` (managed agents always use API key + managed envs)  | Anthropic `/v1/models`         |
 * | `codex`          | `CODEX_OAUTH` (ChatGPT OAuth) → `OPENAI_API_KEY`                        | OpenAI `/v1/models`            |
 * | `opencode`       | `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` (pi-style) | matching provider's `/v1/models` |
 * | `pi`             | `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY`           | matching provider's `/v1/models` |
 * | `devin`          | `DEVIN_API_KEY` (+ `DEVIN_API_BASE_URL` override)                       | `${baseUrl}/v1/sessions?limit=1` |
 *
 * Returns `{ok: true, latency_ms}` on 2xx, `{ok: false, error, latency_ms}`
 * otherwise. Errors are scrubbed via `scrubSecrets` before being returned.
 */
export async function validateProviderCredentials(provider: string): Promise<LiveValidationResult> {
  const env = process.env;
  const startedAt = Date.now();

  try {
    switch (provider) {
      case "claude": {
        // OAuth (Claude Pro/Max via `claude` CLI login) wins over API key —
        // matches `claude-adapter.ts` and the docker entrypoint precedence.
        // OAuth tokens get a presence check only (see `presenceCheckOk`).
        if (env.CLAUDE_CODE_OAUTH_TOKEN) return presenceCheckOk();
        if (env.ANTHROPIC_API_KEY) return checkAnthropicApiKey(env.ANTHROPIC_API_KEY);
        return {
          ok: false,
          error: "Set either CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.",
          latency_ms: Date.now() - startedAt,
        };
      }
      case "claude-managed": {
        // Managed agents always run with an API key — OAuth not supported on
        // the managed-agents path today.
        if (env.ANTHROPIC_API_KEY) return checkAnthropicApiKey(env.ANTHROPIC_API_KEY);
        return {
          ok: false,
          error: "ANTHROPIC_API_KEY is not set.",
          latency_ms: Date.now() - startedAt,
        };
      }
      case "codex": {
        // ChatGPT OAuth wins over API key, matching `codex-adapter.ts`. OAuth
        // tokens (parseable blob with non-empty `access`) get a presence check
        // only — the adapter handles refresh at boot.
        if (parseCodexOAuthAccess(env.CODEX_OAUTH)) return presenceCheckOk();
        if (env.OPENAI_API_KEY) return checkOpenAiApiKey(env.OPENAI_API_KEY);
        return {
          ok: false,
          error: "Set either CODEX_OAUTH or OPENAI_API_KEY.",
          latency_ms: Date.now() - startedAt,
        };
      }
      case "pi":
      case "opencode": {
        // Both pi-mono and opencode resolve credentials in the same order:
        // OPENROUTER → ANTHROPIC → OPENAI. Live-test against the matching
        // provider's models endpoint.
        if (env.OPENROUTER_API_KEY) return checkOpenRouter(env.OPENROUTER_API_KEY);
        if (env.ANTHROPIC_API_KEY) return checkAnthropicApiKey(env.ANTHROPIC_API_KEY);
        if (env.OPENAI_API_KEY) return checkOpenAiApiKey(env.OPENAI_API_KEY);
        return {
          ok: false,
          error:
            "No usable credential found (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY).",
          latency_ms: Date.now() - startedAt,
        };
      }
      case "devin": {
        const apiKey = env.DEVIN_API_KEY;
        if (!apiKey) {
          return {
            ok: false,
            error: "DEVIN_API_KEY is not set.",
            latency_ms: Date.now() - startedAt,
          };
        }
        const baseUrl = env.DEVIN_API_BASE_URL ?? "https://api.devin.ai";
        const r = await timedFetch(`${baseUrl.replace(/\/+$/, "")}/v1/sessions?limit=1`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        });
        if (r.ok) return { ok: true, latency_ms: r.latency_ms };
        return {
          ok: false,
          error: scrubSecrets(`HTTP ${r.status}: ${r.bodyText.slice(0, 200)}`),
          latency_ms: r.latency_ms,
        };
      }
      default:
        return {
          ok: false,
          error: `Unknown provider "${provider}". Supported: claude, claude-managed, codex, devin, opencode, pi.`,
          latency_ms: Date.now() - startedAt,
        };
    }
  } catch (err) {
    return asLiveError(err, Date.now() - startedAt);
  }
}
