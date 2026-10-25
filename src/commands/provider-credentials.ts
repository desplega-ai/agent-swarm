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
 * - The worker steady-state refresh (`src/commands/credential-refresh.ts`)
 *   to check provider changes and recover blocked credentials.
 *
 * Reports flow worker → API as JSON via the existing PATCH /agents/:id
 * endpoint (see `AgentCredStatusSchema` in `src/types.ts`). The API never
 * runs the predicate itself — it just reads the agent row.
 */

import {
  openAICompatibleKeyVars,
  openAICompatibleProviders,
  providerBaseUrl,
  providerKeyFromEnv,
} from "@desplega/model-catalog";
import { deriveDefaultRoute, validateRoute } from "@desplega/model-routing";
import { ACP_TARGET_IDS, isAcpTarget } from "../providers/acp-target-catalog";
import { checkAmpCredentials, liveTestAmpCredentials } from "../providers/amp-adapter";
import { checkClaudeCredentials } from "../providers/claude-adapter";
import { checkClaudeManagedCredentials } from "../providers/claude-managed-adapter";
import { checkCodexCredentials } from "../providers/codex-adapter";
import { hasCodexOAuthPoolSlots } from "../providers/codex-oauth/env-keys";
import { checkCursorCredentials } from "../providers/cursor-adapter";
import { checkDevinCredentials } from "../providers/devin-adapter";
import { checkDshCredentials } from "../providers/dsh-adapter";
import { checkGrokCredentials } from "../providers/grok-adapter";
import { checkOpencodeCredentials } from "../providers/opencode-adapter";
import type { CredCheckOptions, CredStatus } from "../providers/types";
import type {
  AgentAcpStatus,
  AgentCredStatus,
  AgentLatestModel,
  ProviderName,
  ReasoningEffort,
} from "../types";
import {
  CLAUDE_CREDENTIALS_HINT,
  CREDENTIAL_POOL_VARS,
  splitCredentialPool,
} from "../utils/credentials";
import {
  checkAnthropicApiKey,
  checkDeepSeekApiKey,
  checkOpenAICompatibleProvider,
  checkOpenAiApiKey,
  checkOpenRouter,
  checkXaiApiKey,
  type LiveKeyResult,
  type LiveValidationResult,
  timedFetch,
} from "../utils/provider-key-probes";
import { scrubSecrets } from "../utils/secret-scrubber";

export {
  checkAnthropicApiKey,
  checkDeepSeekApiKey,
  checkOpenAICompatibleProvider,
  checkOpenAiApiKey,
  checkOpenRouter,
  checkXaiApiKey,
  type LiveKeyResult,
  type LiveValidationResult,
} from "../utils/provider-key-probes";

export type SupportedProvider =
  | "claude"
  | "claude-managed"
  | "codex"
  | "devin"
  | "opencode"
  | "pi"
  | "acp"
  | "dsh"
  | "cursor"
  | "amp"
  | "grok";

/**
 * True when the pi harness authenticates against Bedrock rather than a provider
 * API key: an explicit `BEDROCK_AUTH_MODE=sdk` (AWS credential chain), an
 * explicit `BEDROCK_AUTH_MODE=bearer` (Bedrock API key in
 * `AWS_BEARER_TOKEN_BEDROCK`), or — preserving prefix-inference semantics —
 * `BEDROCK_AUTH_MODE` absent with a `MODEL_OVERRIDE=amazon-bedrock/*` selection.
 * Single source of truth for the gate so the live-test arm and the worker
 * reconcile loop agree with `checkPiMonoCredentials`, which owns the per-mode
 * readiness rules (what must be present, how readiness is reported).
 */
export function isBedrockMode(env: Record<string, string | undefined>): boolean {
  const mode = env.BEDROCK_AUTH_MODE?.toLowerCase();
  return (
    mode === "sdk" ||
    mode === "bearer" ||
    (mode === undefined && Boolean(env.MODEL_OVERRIDE?.toLowerCase().startsWith("amazon-bedrock/")))
  );
}

/**
 * Scheduling decision for the runner's post-task Bedrock enumeration refresh
 * (see the throttled branch in `runner.ts`). Kept pure so the gate can be
 * exercised without spinning the runner: it fires for the pi harness in any
 * Bedrock mode (`sdk`, `bearer`, or the `MODEL_OVERRIDE=amazon-bedrock/*`
 * inference) once `intervalMs` has elapsed since the last refresh.
 */
export function shouldRefreshBedrockStatus(opts: {
  harnessProvider: string | null | undefined;
  env: Record<string, string | undefined>;
  lastRefreshAt: number;
  now: number;
  intervalMs: number;
}): boolean {
  return (
    opts.harnessProvider === "pi" &&
    isBedrockMode(opts.env) &&
    opts.now - opts.lastRefreshAt > opts.intervalMs
  );
}

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
  opencode: [
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    ...openAICompatibleKeyVars(),
  ],
  pi: ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", ...openAICompatibleKeyVars()],
  // The ACP target owns its auth; custom targets still need a command.
  acp: [],
  dsh: ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"],
  amp: ["AMP_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  grok: ["XAI_API_KEY", "OPENROUTER_API_KEY"],
};

type CredentialChecker = (
  env: Record<string, string | undefined>,
  opts?: CredCheckOptions,
) => CredStatus | Promise<CredStatus>;

/** The handlers used by the credential-readiness dispatcher. */
export const CREDENTIAL_PROVIDER_CHECKERS: Record<SupportedProvider, CredentialChecker> = {
  dsh: (env) => checkDshCredentials(env),
  amp: (env) => checkAmpCredentials(env),
  cursor: (env) => checkCursorCredentials(env),
  grok: (env) => checkGrokCredentials(env),
  claude: (env) => checkClaudeCredentials(env),
  "claude-managed": (env) => checkClaudeManagedCredentials(env),
  codex: (env, opts) => checkCodexCredentials(env, opts),
  devin: (env) => checkDevinCredentials(env),
  opencode: (env, opts) => checkOpencodeCredentials(env, opts),
  pi: async (env, opts) => {
    const { checkPiMonoCredentials, listPiOpencodeGoModelIds } = await import(
      "../providers/pi-mono-adapter"
    );
    return {
      ...(await checkPiMonoCredentials(env, opts)),
      opencodeGoModels: listPiOpencodeGoModelIds(),
    };
  },
  acp: (env) => {
    const target = env.ACP_TARGET ?? "custom";
    if (!isAcpTarget(target)) {
      return {
        ready: false,
        missing: ["ACP_TARGET"],
        hint: `Set ACP_TARGET to one of: ${ACP_TARGET_IDS.join(", ")}.`,
      };
    }
    const command = env.ACP_TARGET_COMMAND ?? env.ACP_COMMAND;
    if (target === "custom" && !command?.trim()) {
      return {
        ready: false,
        missing: ["ACP_TARGET_COMMAND"],
        hint: "Set ACP_TARGET_COMMAND (or ACP_COMMAND) to an ACP-compatible executable, or select a preset with ACP_TARGET.",
      };
    }
    return { ready: true, missing: [], satisfiedBy: "sdk-delegated" };
  },
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
  const checker = (CREDENTIAL_PROVIDER_CHECKERS as Record<string, CredentialChecker | undefined>)[
    provider
  ];
  if (!checker) {
    throw new Error(
      `checkProviderCredentials: unknown provider "${provider}". Supported: ${Object.keys(
        CREDENTIAL_PROVIDER_CHECKERS,
      ).join(", ")}.`,
    );
  }
  return checker(env, opts);
}

// ─── Live "Test connection" dispatcher ───────────────────────────────────────
// Used by `POST /status/test-connection` on the home page setup checklist.
// Mirrors `checkProviderCredentials` but issues a real (cheapest possible)
// upstream call so the user can flip the `harness` milestone to `verified`.
//
// Worker-only dispatch uses the shared probes in `provider-key-probes.ts`.
// The API imports those probes directly to avoid loading worker harnesses.

function asLiveError(err: unknown, latency_ms: number): LiveValidationResult {
  const raw = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: scrubSecrets(raw) || "Unknown error",
    latency_ms,
  };
}

/**
 * Run `check` on every member of a comma pool in parallel. The pool passes
 * when one key works (the runner skips a rejected key); `warning` names the
 * keys that failed, and the check fails only when every key fails.
 */
export async function checkEachKey(
  keyType: string,
  value: string,
  check: (key: string) => Promise<LiveValidationResult>,
): Promise<LiveValidationResult> {
  const members = splitCredentialPool(value);
  if (members.length === 0) members.push(value.trim());
  const results = await Promise.all(
    members.map(async (member) => {
      const startedAt = Date.now();
      try {
        return await check(member);
      } catch (err) {
        return asLiveError(err, Date.now() - startedAt);
      }
    }),
  );
  const latency_ms = Math.max(...results.map((result) => result.latency_ms));
  if (results.every((result) => result.skipped)) return { ok: true, skipped: true, latency_ms };
  const keys = results.map(
    (result, index): LiveKeyResult => ({
      keyType,
      index,
      suffix: members[index]!.slice(-5),
      ok: result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
      latency_ms: result.latency_ms,
    }),
  );
  const failed = keys.filter((key) => !key.ok);
  if (failed.length === 0) return { ok: true, latency_ms, keys };
  const failures = failed
    .map(
      (key) =>
        `key ending ${key.suffix} (${key.httpStatus !== undefined ? `HTTP ${key.httpStatus}` : (key.error ?? "Unknown error")})`,
    )
    .join(", ");
  if (failed.length < keys.length) {
    return {
      ok: true,
      latency_ms,
      keys,
      warning: `${failed.length} of ${keys.length} keys failed: ${failures}.`,
    };
  }
  if (keys.length === 1) {
    return {
      ok: false,
      error: failed[0]!.error,
      httpStatus: failed[0]!.httpStatus,
      latency_ms,
      keys,
    };
  }
  return { ok: false, error: `All ${keys.length} keys failed: ${failures}.`, latency_ms, keys };
}

// ─── Per-endpoint live-call helpers ──────────────────────────────────────────
// Each helper accepts the auth material it needs and returns a normalized
// `LiveValidationResult`. The harness-level dispatcher below picks which
// helper to call based on which credential is actually present, so OAuth
// users no longer see "ANTHROPIC_API_KEY is not set" when their adapter is
// happily running off `CLAUDE_CODE_OAUTH_TOKEN`.

/**
 * Codex OAuth credentials (ChatGPT login) are treated as a presence check — we
 * don't issue a live upstream call. (Claude subscription tokens get a real
 * check through the route: see `claudeSubscriptionProvider`.)
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
 * | `claude`         | default route: Foundry / Bedrock / Vertex → gateway (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`) → `CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` | the route's own `/v1/models`; OAuth: `/api/oauth/profile` (403 scope = ok); cloud routes skipped |
 * | `claude-managed` | `ANTHROPIC_API_KEY` (managed agents always use API key + managed envs)  | Anthropic `/v1/models`         |
 * | `codex`          | `~/.codex/auth.json` (file) → `CODEX_OAUTH` (env OAuth) → `OPENAI_API_KEY` | OpenAI `/v1/models` (api-key path only) |
 * | `opencode`       | auth.json (file) → `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → each registry provider key (`NAN_API_KEY` or `HELMCODE_API_NAN`, `HELMCODE_API_KEY`) | file presence-only, otherwise OpenRouter `/key` or the provider's `/v1/models` |
 * | `pi`             | auth.json (file) → provider API keys, including model-specific keys   | file/model-specific key presence-only, otherwise provider's `/v1/models` |
 * | `acp`            | target-specific (the ACP target process owns its own auth)              | presence-only (validated by the target process) |
 * | `pi` (bedrock)   | `MODEL_OVERRIDE=amazon-bedrock/*` → AWS SDK default credential chain    | presence-only (real check is the worker-side Bedrock enumeration) |
 * | `devin`          | `DEVIN_API_KEY` (+ `DEVIN_API_BASE_URL` override)                       | `${baseUrl}/v3/self`            |
 * | `dsh`            | `DEEPSEEK_API_KEY` → `OPENROUTER_API_KEY`                               | DeepSeek `/models`, or OpenRouter `/key` |
 * | `amp`            | `AMP_API_KEY`                                                           | `amp usage` (credit balance, no inference; 5s timeout) |
 *
 * Returns `{ok: true, latency_ms}` on 2xx, `{ok: false, error, latency_ms}`
 * otherwise. Errors are scrubbed via `scrubSecrets` before being returned.
 * Reports pass their existing presence result so pi/opencode do not repeat
 * that check.
 */
export async function validateProviderCredentials(
  provider: string,
  env: Record<string, string | undefined> = process.env,
  presence?: CredStatus,
): Promise<LiveValidationResult> {
  const startedAt = Date.now();

  try {
    switch (provider) {
      case "claude": {
        // The default route decides where the check goes: a gateway key is
        // checked against the gateway only (scoped fetch), never against
        // api.anthropic.com. A subscription token is checked against
        // `/api/oauth/profile`; cloud routes have no free check and report
        // `configured` (no live test).
        const route = deriveDefaultRoute("claude", env);
        if (!route) {
          return {
            ok: false,
            error: CLAUDE_CREDENTIALS_HINT,
            latency_ms: Date.now() - startedAt,
          };
        }
        const checkRoute = async (
          routeEnv: Record<string, string | undefined>,
        ): Promise<LiveValidationResult> => {
          const start = Date.now();
          const result = await validateRoute(route, routeEnv);
          const latency_ms = Date.now() - start;
          if (result.status === "verified") return { ok: true, latency_ms };
          if (result.status === "configured") return { ok: true, skipped: true, latency_ms };
          return {
            ok: false,
            error: scrubSecrets(result.reason),
            httpStatus: result.httpStatus,
            latency_ms,
          };
        };
        const keyVar =
          route.auth.kind === "subscription"
            ? "CLAUDE_CODE_OAUTH_TOKEN"
            : "secretKey" in route.auth
              ? route.auth.secretKey
              : undefined;
        const value = keyVar ? env[keyVar] : undefined;
        // Only pool vars are split: the runner never splits a gateway token.
        if (keyVar && value && (CREDENTIAL_POOL_VARS as readonly string[]).includes(keyVar)) {
          return checkEachKey(keyVar, value, (member) => checkRoute({ ...env, [keyVar]: member }));
        }
        return checkRoute(env);
      }
      case "claude-managed": {
        // Managed agents always run with an API key — OAuth not supported on
        // the managed-agents path today.
        if (env.ANTHROPIC_API_KEY) {
          return checkEachKey("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY, checkAnthropicApiKey);
        }
        return {
          ok: false,
          error: "ANTHROPIC_API_KEY is not set.",
          latency_ms: Date.now() - startedAt,
        };
      }
      case "codex": {
        // A gateway route is checked against the gateway only (scoped fetch
        // to its own `/models`), never against api.openai.com, and wins over
        // every OAuth / auth.json / OPENAI_API_KEY check below.
        const gateway = deriveDefaultRoute("codex", env);
        if (gateway) {
          const result = await validateRoute(gateway, env);
          const latency_ms = Date.now() - startedAt;
          if (result.status === "verified") return { ok: true, latency_ms };
          if (result.status === "configured") return { ok: true, skipped: true, latency_ms };
          return {
            ok: false,
            error: scrubSecrets(result.reason),
            httpStatus: result.httpStatus,
            latency_ms,
          };
        }
        // Resolution order matches `checkCodexCredentials`:
        //   1) `~/.codex/auth.json` on disk (canonical state once `codex login`
        //      has run, or when the entrypoint pre-materialised it from
        //      CODEX_OAUTH / OPENAI_API_KEY). This is the OAuth-equivalent path
        //      for codex — refresh logic lives in the adapter, so we only do a
        //      presence check (no upstream call).
        //   2) `CODEX_OAUTH` env blob, or a usable `codex_oauth_<N>` pool slot
        //      (counted in `CODEX_OAUTH_POOL_SLOTS`; the slots themselves never
        //      reach env, the runner materialises auth.json per task) — same
        //      OAuth treatment.
        //   3) `OPENAI_API_KEY` env var — live-test against OpenAI `/v1/models`.
        //
        // Without (1), an agent that boots fresh from a credential pool whose
        // entrypoint already wrote auth.json would falsely fail the live test
        // with "Set either CODEX_OAUTH or OPENAI_API_KEY" (observed in prod).
        if (codexAuthFileExists(env)) return presenceCheckOk();
        if (parseCodexOAuthAccess(env.CODEX_OAUTH)) return presenceCheckOk();
        if (hasCodexOAuthPoolSlots(env)) return presenceCheckOk();
        if (env.OPENAI_API_KEY) {
          return checkEachKey("OPENAI_API_KEY", env.OPENAI_API_KEY, checkOpenAiApiKey);
        }
        return {
          ok: false,
          error:
            "No codex credential found (no ~/.codex/auth.json, CODEX_OAUTH, or OPENAI_API_KEY).",
          latency_ms: Date.now() - startedAt,
        };
      }
      case "pi":
      case "opencode": {
        // For the pi Bedrock path (sdk or bearer), the real credential check is the AWS SDK
        // enumeration (`ListFoundationModels` + `ListInferenceProfiles`) that
        // `checkProviderCredentials` (the `pi` dynamic-import arm) already ran.
        // That result is already in `buildCredStatusReport` — the live-test is a
        // pass-through / no-op so we never issue a second AWS SDK call here
        // (which would drag the SDK into the wrong binary or make slow IMDS
        // calls on non-EC2 hosts).
        if (provider === "pi" && isBedrockMode(env)) {
          return presenceCheckOk();
        }
        const status = presence ?? (await checkProviderCredentials(provider, env));
        // The adapters prefer their auth.json over env keys. Reuse that
        // decision, including any injected filesystem probe used by reports.
        if (status.ready && status.satisfiedBy === "file") return presenceCheckOk();
        // Preserve the live-probe order for supported env keys:
        // OPENROUTER → ANTHROPIC → OPENAI, then the OpenAI-compatible
        // registry providers in declaration order (NaN, canonical key or
        // alias → Helmcode) at their `<ID>_BASE_URL`, so existing env
        // combinations keep their probe.
        if (env.OPENROUTER_API_KEY) {
          return checkEachKey("OPENROUTER_API_KEY", env.OPENROUTER_API_KEY, checkOpenRouter);
        }
        if (env.ANTHROPIC_API_KEY) {
          return checkEachKey("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY, checkAnthropicApiKey);
        }
        if (env.OPENAI_API_KEY) {
          return checkEachKey("OPENAI_API_KEY", env.OPENAI_API_KEY, checkOpenAiApiKey);
        }
        for (const direct of openAICompatibleProviders()) {
          const key = providerKeyFromEnv(direct, env);
          if (key) {
            return checkEachKey(direct.envVar, key, (member) =>
              checkOpenAICompatibleProvider(direct, member, providerBaseUrl(direct, env)),
            );
          }
        }
        // Model-specific keys (e.g. GEMINI_API_KEY) can satisfy readiness
        // without a probeable endpoint. The harness validates them at inference.
        if (status.ready) return presenceCheckOk();
        return {
          ok: false,
          error: `No usable credential found (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, ${openAICompatibleProviders()
            .map((p) => p.envVar)
            .join(", ")
            .replace(/, (?=[^,]*$)/, ", or ")}).`,
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
        return checkEachKey("DEVIN_API_KEY", apiKey, async (member) => {
          const r = await timedFetch(`${baseUrl.replace(/\/+$/, "")}/v3/self`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${member}`,
              "Content-Type": "application/json",
            },
          });
          if (r.ok) return { ok: true, latency_ms: r.latency_ms };
          return {
            ok: false,
            error: scrubSecrets(`HTTP ${r.status}: ${r.bodyText.slice(0, 200)}`),
            httpStatus: r.status,
            latency_ms: r.latency_ms,
          };
        });
      }
      case "dsh": {
        // Same precedence as `checkDshCredentials`: the DeepSeek key, then OpenRouter.
        const deepseekKey = env.DEEPSEEK_API_KEY?.trim();
        if (deepseekKey) return checkEachKey("DEEPSEEK_API_KEY", deepseekKey, checkDeepSeekApiKey);
        const openRouterKey = env.OPENROUTER_API_KEY?.trim();
        if (openRouterKey)
          return checkEachKey("OPENROUTER_API_KEY", openRouterKey, checkOpenRouter);
        return {
          ok: false,
          error: "Set DEEPSEEK_API_KEY or OPENROUTER_API_KEY for dsh.",
          latency_ms: Date.now() - startedAt,
        };
      }
      case "amp": {
        if (!checkAmpCredentials(env).ready) {
          return {
            ok: false,
            error: "AMP_API_KEY is not set.",
            latency_ms: Date.now() - startedAt,
          };
        }
        // `amp usage` reads the credit balance and runs no inference.
        return checkEachKey("AMP_API_KEY", env.AMP_API_KEY!, async (member) => {
          const start = Date.now();
          const live = await liveTestAmpCredentials({ ...env, AMP_API_KEY: member });
          return live.ok
            ? { ok: true, latency_ms: Date.now() - start }
            : {
                ok: false,
                error: live.error ?? "amp usage failed",
                latency_ms: Date.now() - start,
              };
        });
      }
      case "cursor": {
        const apiKey = env.CURSOR_API_KEY?.trim();
        if (!apiKey) {
          return {
            ok: false,
            error: "CURSOR_API_KEY is not set.",
            latency_ms: Date.now() - startedAt,
          };
        }
        const { liveTestCursorKey } = await import("../providers/cursor-adapter");
        return checkEachKey("CURSOR_API_KEY", apiKey, async (member) => {
          const start = Date.now();
          const result = await liveTestCursorKey(member);
          return result.ok
            ? { ok: true, latency_ms: Date.now() - start }
            : { ok: false, error: result.error, latency_ms: Date.now() - start };
        });
      }
      case "grok": {
        const apiKey = env.XAI_API_KEY?.trim();
        if (apiKey) return checkEachKey("XAI_API_KEY", apiKey, checkXaiApiKey);
        const openRouterKey = env.OPENROUTER_API_KEY?.trim();
        if (openRouterKey) {
          return checkEachKey("OPENROUTER_API_KEY", openRouterKey, checkOpenRouter);
        }
        return {
          ok: false,
          error: "Set XAI_API_KEY or OPENROUTER_API_KEY for grok.",
          latency_ms: Date.now() - startedAt,
        };
      }
      case "acp":
        return presenceCheckOk();
      default:
        return {
          ok: false,
          error: `Unknown provider "${provider}". Supported: claude, claude-managed, codex, devin, opencode, pi, acp, dsh, cursor, amp, grok.`,
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
  const live = presence.ready ? await validateProviderCredentials(provider, env, presence) : null;
  if (live && !live.skipped) {
    liveTest = {
      ok: live.ok,
      error: live.error ?? null,
      latency_ms: live.latency_ms,
      testedAt: Date.now(),
      ...(live.warning !== undefined ? { warning: live.warning } : {}),
      ...(live.keys !== undefined ? { keys: live.keys } : {}),
    };
  }
  // Include the Bedrock enumeration block when the pi probe ran in Bedrock SDK
  // mode (bedrockRegion is only set by checkPiMonoCredentials in that branch).
  const bedrock: AgentCredStatus["bedrock"] =
    presence.bedrockRegion !== undefined
      ? {
          region: presence.bedrockRegion,
          probedAt: Date.now(),
          ready: presence.ready,
          models: presence.bedrockModels ?? [],
          error: presence.ready ? undefined : (presence.hint ?? undefined),
        }
      : null;
  const opencodeGo: AgentCredStatus["opencodeGo"] =
    presence.opencodeGoModels !== undefined
      ? { probedAt: Date.now(), models: presence.opencodeGoModels }
      : null;
  return {
    ready: presence.ready,
    missing: presence.missing ?? [],
    satisfiedBy: presence.satisfiedBy ?? null,
    hint: presence.hint ?? null,
    liveTest,
    latestModel: null,
    reportedAt: Date.now(),
    reportKind: kind,
    bedrock,
    opencodeGo,
    acp: null,
  };
}

/**
 * Strict PUT of credential readiness to the API: propagates network errors
 * and non-2xx responses. The post-credential-wait boot path uses this — after
 * a stale-runtime revival this write is the only transition out of
 * `waiting_for_credentials`, so the caller must be able to observe (and
 * retry) a failure instead of proceeding as though it landed.
 *
 * Posts to the existing `PUT /api/agents/:id/credential-status` endpoint
 * which (per migration 055) accepts an optional `cred_status` field. `ready`
 * and `missing` are always included so legacy `agents.credentialMissing` and
 * `agents.status='waiting_for_credentials'` keep tracking; the snapshot is
 * optional so a hiccup while building it cannot lose the transition.
 */
export async function sendCredStatusReport(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  runtimeInstanceId: string | undefined,
  report: { ready: boolean; missing: string[]; credStatus?: AgentCredStatus },
): Promise<void> {
  const res = await fetch(`${apiUrl}/api/agents/${encodeURIComponent(agentId)}/credential-status`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Agent-ID": agentId,
      ...(runtimeInstanceId ? { "X-Runtime-Instance-ID": runtimeInstanceId } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ready: report.ready,
      missing: report.missing,
      ...(report.credStatus ? { cred_status: report.credStatus } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`credential-status report failed: ${res.status} ${body}`.trim());
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

export async function reportAcpStatus(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  acp: AgentAcpStatus,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/api/agents/${encodeURIComponent(agentId)}/credential-status`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ acp }),
    });
  } catch (err) {
    console.warn(`[acp-status] POST failed (non-fatal): ${err}`);
  }
}

export function buildLatestModelReport(opts: {
  model: string;
  taskModel?: string;
  configModel?: string;
  taskId?: string;
  harnessProvider: ProviderName;
  /**
   * Resolved (or adapter-confirmed, post-completion) reasoning/effort level
   * for this session — see the three call sites in `src/commands/runner.ts`:
   * the initial report and the mid-session "result" event report both pass
   * the runner-resolved value; the final report (after `waitForCompletion()`
   * resolves) passes `ProviderResult.appliedReasoningEffort`.
   */
  reasoningEffort?: ReasoningEffort;
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
    reasoningEffort: opts.reasoningEffort,
  };
}
