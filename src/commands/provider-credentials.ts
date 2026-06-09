/**
 * Provider-agnostic credential check dispatcher (WORKER-ONLY).
 *
 * Lives in `src/commands/` because the predicates value-import worker-harness
 * SDKs (e.g. `@earendil-works/pi-coding-agent` via `pi-mono-adapter.ts`) that
 * have module-load side effects. Importing this file from any module
 * reachable from `src/http.ts` would drag those SDKs into the bun-compiled
 * API binary — which is exactly the bug PR #452 hit at `/usr/local/bin/`.
 *
 * Used by:
 * - The worker boot loop (`src/commands/credential-wait.ts`) to decide
 *   whether the worker can claim tasks yet.
 * - The worker post-task hook (`src/commands/runner.ts`) to refresh on
 *   harness_provider changes.
 *
 * Reports flow worker → API as JSON via the existing PATCH /agents/:id
 * endpoint (see `AgentCredStatusSchema` in `src/types.ts`). The API never
 * runs the predicate itself — it just reads the agent row.
 */

import { existsSync } from "node:fs";
import { checkClaudeCredentials } from "../providers/claude-adapter";
import { checkClaudeManagedCredentials } from "../providers/claude-managed-adapter";
import { checkCodexCredentials } from "../providers/codex-adapter";
import { checkDevinCredentials } from "../providers/devin-adapter";
import { checkOpencodeCredentials } from "../providers/opencode-adapter";
import type { CredCheckOptions, CredStatus } from "../providers/types";
import type { AgentCredStatus, AgentLatestModel, ProviderName } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";

export type SupportedProvider =
  | "claude"
  | "claude-managed"
  | "codex"
  | "devin"
  | "opencode"
  | "pi"
  | "acp";

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
  acp: ["target-specific; gemini-cli accepts GEMINI_API_KEY or Vertex AI credentials"],
};

/**
 * Run the predicate for `provider`. Unknown providers throw — call sites
 * should treat that as a configuration bug, not a user-correctable state.
 *
 * The `pi` case uses a dynamic import so `@earendil-works/pi-coding-agent`
 * (which has module-level side effects that crash in the Bun compiled
 * binary) is only loaded when the pi provider is actually selected.
 */
export async function checkProviderCredentials(
  provider: string,
  env: Record<string, string | undefined>,
  opts?: CredCheckOptions,
): Promise<CredStatus> {
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
    case "pi": {
      const { checkPiMonoCredentials } = await import("../providers/pi-mono-adapter");
      return checkPiMonoCredentials(env, opts);
    }
    case "acp":
      return checkAcpCredentials(env, opts);
    default:
      throw new Error(
        `checkProviderCredentials: unknown provider "${provider}". Supported: claude, claude-managed, codex, devin, opencode, pi, acp.`,
      );
  }
}

function checkAcpCredentials(
  env: Record<string, string | undefined>,
  opts: CredCheckOptions = {},
): CredStatus {
  const target = env.ACP_TARGET ?? "custom";

  if (target === "claude-agent-acp") {
    if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY) {
      return { ready: true, missing: [], satisfiedBy: "env" };
    }
    return {
      ready: false,
      missing: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
      hint: "ACP target claude-agent-acp requires Claude credentials.",
    };
  }

  if (target === "codex-acp") {
    return checkCodexCredentials(env, opts);
  }

  if (target === "custom") {
    const command = env.ACP_COMMAND;
    if (!command) {
      return {
        ready: false,
        missing: ["ACP_COMMAND"],
        hint: "ACP target 'custom' requires ACP_COMMAND to be set to the path or command of the ACP-compatible agent binary.",
      };
    }
    return { ready: true, missing: [], satisfiedBy: "env" };
  }

  const KNOWN_ACP_TARGETS = ["custom", "gemini-cli", "claude-agent-acp", "codex-acp"] as const;
  if (!(KNOWN_ACP_TARGETS as readonly string[]).includes(target)) {
    return {
      ready: false,
      missing: [],
      hint: `Unknown ACP_TARGET "${target}". Supported targets: ${KNOWN_ACP_TARGETS.join(", ")}.`,
    };
  }

  if (env.GEMINI_API_KEY) return { ready: true, missing: [], satisfiedBy: "env" };
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true" && env.GOOGLE_API_KEY) {
    return { ready: true, missing: [], satisfiedBy: "env" };
  }
  if (
    env.GOOGLE_GENAI_USE_VERTEXAI === "true" &&
    env.GOOGLE_APPLICATION_CREDENTIALS &&
    env.GOOGLE_CLOUD_PROJECT &&
    env.GOOGLE_CLOUD_LOCATION
  ) {
    return { ready: true, missing: [], satisfiedBy: "env" };
  }
  if (geminiOAuthFileExists(env, opts)) {
    return { ready: true, missing: [], satisfiedBy: "file" };
  }

  return {
    ready: false,
    missing: [
      "GEMINI_API_KEY",
      "GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_API_KEY",
      "GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION",
      "~/.gemini/oauth_creds.json",
    ],
    hint: "ACP target gemini-cli needs Gemini CLI auth before startup. Set GEMINI_API_KEY, configure Vertex AI credentials, or run `gemini` login so ~/.gemini/oauth_creds.json exists.",
  };
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
 * Mirror of the disk check in `checkCodexCredentials` — true when the worker
 * has a materialised `~/.codex/auth.json`, which is the canonical "logged in"
 * state for codex (whether the entrypoint wrote it from `CODEX_OAUTH`, from
 * `OPENAI_API_KEY` via `codex login --with-api-key`, or it was baked into the
 * image). The codex adapter handles refresh internally, so this is treated as
 * a presence check at live-test time (no upstream call).
 */
function codexAuthFileExists(env: Record<string, string | undefined>): boolean {
  // Delegate to the adapter's own check so the auth.json path stays in one
  // place. `satisfiedBy === "file"` is set iff the file exists on disk.
  return checkCodexCredentials(env).satisfiedBy === "file";
}

function geminiOAuthFileExists(
  env: Record<string, string | undefined>,
  opts: CredCheckOptions,
): boolean {
  const homeDir = opts.homeDir ?? env.HOME;
  if (!homeDir) return false;
  return (opts.fs ?? { existsSync }).existsSync(`${homeDir}/.gemini/oauth_creds.json`);
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
 * | `codex`          | `~/.codex/auth.json` (file) → `CODEX_OAUTH` (env OAuth) → `OPENAI_API_KEY` | OpenAI `/v1/models` (api-key path only) |
 * | `opencode`       | `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` (pi-style) | matching provider's `/v1/models` |
 * | `pi`             | `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY`           | matching provider's `/v1/models` |
 * | `pi` (bedrock)   | `MODEL_OVERRIDE=amazon-bedrock/*` → AWS SDK default credential chain    | presence-only (validated at first inference call) |
 * | `acp`            | target-specific                                                         | presence-only (validated by target process) |
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
        // Resolution order matches `checkCodexCredentials`:
        //   1) `~/.codex/auth.json` on disk (canonical state once `codex login`
        //      has run, or when the entrypoint pre-materialised it from
        //      CODEX_OAUTH / OPENAI_API_KEY). This is the OAuth-equivalent path
        //      for codex — refresh logic lives in the adapter, so we only do a
        //      presence check (no upstream call).
        //   2) `CODEX_OAUTH` env blob — same OAuth treatment.
        //   3) `OPENAI_API_KEY` env var — live-test against OpenAI `/v1/models`.
        //
        // Without (1), an agent that boots fresh from a credential pool whose
        // entrypoint already wrote auth.json would falsely fail the live test
        // with "Set either CODEX_OAUTH or OPENAI_API_KEY" (observed in prod).
        if (codexAuthFileExists(env)) return presenceCheckOk();
        if (parseCodexOAuthAccess(env.CODEX_OAUTH)) return presenceCheckOk();
        if (env.OPENAI_API_KEY) return checkOpenAiApiKey(env.OPENAI_API_KEY);
        return {
          ok: false,
          error:
            "No codex credential found (no ~/.codex/auth.json, CODEX_OAUTH, or OPENAI_API_KEY).",
          latency_ms: Date.now() - startedAt,
        };
      }
      case "pi":
      case "opencode": {
        // pi-mono with MODEL_OVERRIDE=amazon-bedrock/* delegates credential
        // resolution to the AWS SDK default chain (env, ~/.aws/*, SSO, IMDS,
        // assume-role, …). pi-ai exposes no Bedrock-specific check we could
        // call here, and the SDK chain may issue slow IMDS network calls on
        // non-EC2 hosts — so the live test is a presence check, mirroring the
        // codex-OAuth pattern above. Real validation happens at the first
        // Bedrock inference call.
        if (provider === "pi" && env.MODEL_OVERRIDE?.toLowerCase().startsWith("amazon-bedrock/")) {
          return presenceCheckOk();
        }
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
      case "acp": {
        const acpTarget = env.ACP_TARGET;
        if (acpTarget === "claude-agent-acp") {
          if (env.CLAUDE_CODE_OAUTH_TOKEN) return presenceCheckOk();
          if (env.ANTHROPIC_API_KEY) return checkAnthropicApiKey(env.ANTHROPIC_API_KEY);
          if (env.CLAUDE_API_KEY) return presenceCheckOk();
          return {
            ok: false,
            error:
              "ACP target claude-agent-acp requires Claude credentials (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, or CLAUDE_API_KEY).",
            latency_ms: Date.now() - startedAt,
          };
        }
        if (acpTarget === "codex-acp") {
          return validateProviderCredentials("codex");
        }
        return presenceCheckOk();
      }
      default:
        return {
          ok: false,
          error: `Unknown provider "${provider}". Supported: claude, claude-managed, codex, devin, opencode, pi, acp.`,
          latency_ms: Date.now() - startedAt,
        };
    }
  } catch (err) {
    return asLiveError(err, Date.now() - startedAt);
  }
}

// ─── Worker-side report composition ──────────────────────────────────────────
// Composes the JSON the worker POSTs to `PATCH /agents/:id` so the API can
// expose per-worker credential status without running any provider-specific
// code itself. See `AgentCredStatusSchema` in `src/types.ts` for the contract.

/**
 * Single switch for the opt-out env var. Both `credential-wait.ts` (boot) and
 * `runner.ts` (post-task) honor this; when set, the worker performs no
 * checks and POSTs nothing — the agent row's `cred_status` stays NULL and
 * the dashboard surfaces "unreported".
 */
export function isCredCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.CRED_CHECK_DISABLE === "1";
}

/**
 * Run the presence check + (when ready) live test, and shape the result into
 * the JSON contract the API stores. `kind` records the trigger — useful for
 * ops debugging and for the dashboard to surface "last verified Xs ago."
 *
 * Both "boot" and "post_task" run the live test today. The cache-hit
 * post-task path skips this function entirely (caller decides), so when this
 * function is called we always do the full check.
 */
export async function buildCredStatusReport(
  provider: string,
  env: Record<string, string | undefined>,
  opts: CredCheckOptions = {},
  kind: AgentCredStatus["reportKind"],
): Promise<AgentCredStatus> {
  const presence = await checkProviderCredentials(provider, env, opts);
  let liveTest: AgentCredStatus["liveTest"] = null;
  if (presence.ready) {
    const live = await validateProviderCredentials(provider);
    liveTest = {
      ok: live.ok,
      error: live.error ?? null,
      latency_ms: live.latency_ms,
      testedAt: Date.now(),
    };
  }
  return {
    ready: presence.ready,
    missing: presence.missing ?? [],
    satisfiedBy: presence.satisfiedBy ?? null,
    hint: presence.hint ?? null,
    liveTest,
    latestModel: null,
    reportedAt: Date.now(),
    reportKind: kind,
  };
}

/**
 * Fire-and-forget POST of a `cred_status` snapshot to the API. Used by the
 * worker boot path (`runner.ts` after `awaitCredentials`) and the post-task
 * cache-miss path (also in `runner.ts`). Failures are logged, not thrown —
 * a stale dashboard is acceptable; blocking the worker is not.
 *
 * Posts to the existing `PUT /api/agents/:id/credential-status` endpoint
 * which (per migration 055) now accepts an optional `cred_status` field.
 * `ready` and `missing` are also included so legacy `agents.credentialMissing`
 * and `agents.status='waiting_for_credentials'` keep tracking.
 */
export async function reportCredStatus(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  credStatus: AgentCredStatus,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/api/agents/${encodeURIComponent(agentId)}/credential-status`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ready: credStatus.ready,
        missing: credStatus.missing,
        cred_status: credStatus,
      }),
    });
  } catch (err) {
    console.warn(`[cred-status] POST failed (non-fatal): ${err}`);
  }
}

export async function reportLatestModel(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  latestModel: AgentLatestModel,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/api/agents/${encodeURIComponent(agentId)}/credential-status`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        latest_model: latestModel,
      }),
    });
  } catch (err) {
    console.warn(`[latest-model] POST failed (non-fatal): ${err}`);
  }
}

export function buildLatestModelReport(opts: {
  model: string;
  taskModel?: string;
  configModel?: string;
  taskId?: string;
  harnessProvider: ProviderName;
}): AgentLatestModel | null {
  const model = opts.model.trim();
  if (!model) return null;
  const taskModel = opts.taskModel?.trim();
  const configModel = opts.configModel?.trim();
  return {
    model,
    source:
      taskModel && model === taskModel
        ? "task"
        : configModel && model === configModel
          ? "agent_config"
          : taskModel || configModel
            ? "custom"
            : "adapter_default",
    taskId: opts.taskId ?? null,
    harnessProvider: opts.harnessProvider,
    reportedAt: Date.now(),
  };
}
