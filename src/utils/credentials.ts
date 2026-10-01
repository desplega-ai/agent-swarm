import { existsSync } from "node:fs";
import { deriveDefaultRoute, routeCredentialStatus } from "@desplega/model-routing";
import { type ModelFamily, modelFamilyOf, windowForModelFamily } from "./model-rate-limit-windows";

/** Env vars that may contain comma-separated credential pools */
export const CREDENTIAL_POOL_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_OAUTH",
  "DEVIN_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

/**
 * Which credential env vars are relevant for each harness provider. The
 * runner uses this map to filter `CREDENTIAL_POOL_VARS` so a codex worker
 * doesn't get a `CLAUDE_CODE_OAUTH_TOKEN` stamped on its task record (and
 * vice versa). Providers are listed in priority order — when both are
 * present in the env, the runner uses the first match's selection as the
 * primary credential for tracking.
 *
 * Unknown providers (or no provider hint) fall back to ALL pool vars,
 * preserving backwards compatibility for older code paths.
 */
export const PROVIDER_CREDENTIAL_VARS: Record<string, readonly string[]> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  pi: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  codex: ["OPENAI_API_KEY", "CODEX_OAUTH"],
  devin: ["DEVIN_API_KEY"],
  dsh: ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"],
  opencode: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
};

/**
 * Providers where models use `provider_id/model_id` format — a slash in the
 * model string means the model is routed through an upstream provider (e.g.
 * OpenRouter) and OPENAI_API_KEY must not be selected (it would auth against
 * the wrong endpoint). Without a slash the model targets a direct API (e.g.
 * OpenAI) and OPENAI_API_KEY is valid.
 *
 * Both opencode and pi follow this convention:
 * - opencode: https://opencode.ai/docs/models/
 * - pi: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
 */
const SLASH_MODEL_PROVIDERS = new Set(["opencode", "pi"]);

/**
 * Given a provider and model string, return the credential vars that are
 * actually relevant. This implements the harness × model matrix constraint:
 *
 * - (opencode | pi) + model with "/" (e.g. "google/gemini-3-flash-preview",
 *   "openrouter/openai/gpt-4o"): the model is routed through OpenRouter →
 *   OPENAI_API_KEY must not be selected.
 * - (opencode | pi) + model without "/" (e.g. "gpt-4o", "o3-mini") or empty:
 *   the model targets a direct API → keep all creds including OPENAI_API_KEY.
 *
 * All other providers return their static list unchanged.
 */
export function getModelAwareCredentialVars(provider: string, model?: string): readonly string[] {
  const base = PROVIDER_CREDENTIAL_VARS[provider];
  if (!base) return CREDENTIAL_POOL_VARS;
  // dsh has exact prefix routing; the generic slash rule only filters OpenAI keys.
  if (provider === "dsh" && model) {
    return model.startsWith("openrouter/") ? ["OPENROUTER_API_KEY"] : ["DEEPSEEK_API_KEY"];
  }
  if (!SLASH_MODEL_PROVIDERS.has(provider) || !model) return base;
  if (model.includes("/")) {
    return base.filter((v) => v !== "OPENAI_API_KEY");
  }
  return base;
}

/**
 * Derive a canonical harness provider from a credential env var name. Used
 * by the api_key_status table's `provider` column so the dashboard can
 * group/filter pooled credentials by harness without re-deriving at every
 * read site. ANTHROPIC_API_KEY is shared between claude and pi — we default
 * it to claude (the primary consumer) since the runner overrides on every
 * usage with the active worker's HARNESS_PROVIDER.
 */
export function deriveProviderFromKeyType(keyType: string): string {
  switch (keyType) {
    case "CLAUDE_CODE_OAUTH_TOKEN":
    case "ANTHROPIC_API_KEY":
      return "claude";
    case "OPENROUTER_API_KEY":
      return "pi";
    case "OPENAI_API_KEY":
    case "CODEX_OAUTH":
      return "codex";
    case "DEEPSEEK_API_KEY":
      return "dsh";
    case "DEVIN_API_KEY":
      return "devin";
    default:
      return "claude";
  }
}

/** Result of credential selection, including tracking info */
export interface CredentialSelection {
  selected: string;
  index: number;
  total: number;
  /** Last 5 characters of the selected credential (for tracking) */
  keySuffix: string;
  /** Which credential pool env var this selection came from */
  keyType: string;
  /** True when all indices for this keyType were rate-limited (best-effort pick) */
  isRateLimitFallback: boolean;
  /** Indices excluded only by an active model-scoped window block for the requested model. */
  modelBlockedIndices?: number[];
  /** ISO of the earliest reset among modelBlockedIndices, or null/undefined when none. */
  earliestModelResetAt?: string | null;
  /** Indices excluded because the key's subscription plan cannot run the requested model. */
  seatBlockedIndices?: number[];
  /** Subscription plan id detected on the credential (`SUBSCRIPTION_PLANS`), reported with its usage. */
  plan?: string | null;
  /** `authFailureFence` from `GET /api/keys/available`, read before the task (Codex pool only). */
  authFailureFence?: number;
}

const MODEL_LABELS: Record<ModelFamily, string> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

/**
 * Thrown by `resolveCredentialPools` at task admission (`enforceModelCapacity`)
 * when no key for a pool can run the requested model: every key is key-wide
 * rate-limited, blocked by the model's weekly window, or on a subscription
 * seat that cannot run the model (`seatBlockedCount`). A window block throws
 * only when `MODEL_WINDOW_EXHAUSTED_POLICY` is `fail` (the default); a seat
 * block never resets, so it throws under every policy. The caller must not
 * spawn the CLI on this error — see `spawnProviderProcess` in
 * `src/commands/runner.ts`. Taskless configuration loads never throw it.
 */
export class ModelWindowExhaustedError extends Error {
  readonly model: ModelFamily;
  readonly window: string;
  readonly earliestResetAt: string | null;
  readonly keyType: string;
  readonly seatBlockedCount: number;
  readonly modelBlockedCount: number;

  constructor(opts: {
    model: ModelFamily;
    window: string;
    earliestResetAt: string | null;
    keyType: string;
    seatBlockedCount?: number;
    modelBlockedCount?: number;
  }) {
    const modelLabel = MODEL_LABELS[opts.model];
    const seatBlockedCount = opts.seatBlockedCount ?? 0;
    const modelBlockedCount = opts.modelBlockedCount ?? 0;
    const windowClause =
      modelBlockedCount > 0 && opts.earliestResetAt
        ? `${modelBlockedCount} keys have the ${modelLabel} window exhausted until ${opts.earliestResetAt}`
        : `${modelBlockedCount} keys have the ${modelLabel} window exhausted`;
    super(
      seatBlockedCount > 0
        ? `No ${opts.keyType} key can run ${modelLabel}: ${seatBlockedCount} keys are on a seat without ${modelLabel}, ${windowClause}. Re-dispatch with another model or modelTier.`
        : `No ${opts.keyType} key has ${modelLabel} capacity until ${opts.earliestResetAt ?? "unknown"}. Re-dispatch with another model or modelTier.`,
    );
    this.name = "ModelWindowExhaustedError";
    this.model = opts.model;
    this.window = opts.window;
    this.earliestResetAt = opts.earliestResetAt;
    this.keyType = opts.keyType;
    this.seatBlockedCount = seatBlockedCount;
    this.modelBlockedCount = modelBlockedCount;
  }
}

function isJsonObject(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * If a value contains commas, split and select one credential.
 * When availableIndices is provided, only those indices are considered (rate-limit aware).
 * Falls back to random selection from all credentials if no available indices match.
 * A JSON object value (the CODEX_OAUTH blob) is always one credential.
 */
function splitCredentialPool(value: string): string[] {
  return isJsonObject(value)
    ? [value.trim()]
    : value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

export function selectCredential(
  value: string,
  availableIndices?: number[],
  keyType = "ANTHROPIC_API_KEY",
): CredentialSelection {
  // A CODEX_OAUTH value is one JSON blob ({access, refresh, expires, accountId}),
  // never a comma-separated pool: its commas are field separators. Splitting it
  // handed out fragments such as `"accountId":"..."}` as the selected credential
  // and stamped `965"}` as the key suffix on task records. Codex pools live in
  // config-store slots (codex_oauth_<n>), resolved by the runner instead.
  const credentials = splitCredentialPool(value);
  if (credentials.length <= 1) {
    const selected = value.trim();
    const isRateLimitFallback = availableIndices !== undefined && availableIndices.length === 0;
    return {
      selected,
      index: 0,
      total: 1,
      keySuffix: selected.slice(-5),
      keyType,
      isRateLimitFallback,
    };
  }

  let index: number;
  let isRateLimitFallback = false;
  if (availableIndices && availableIndices.length > 0) {
    // Pick randomly from available (non-rate-limited) indices
    const validIndices = availableIndices.filter((i) => i >= 0 && i < credentials.length);
    if (validIndices.length > 0) {
      index = validIndices[Math.floor(Math.random() * validIndices.length)]!;
    } else {
      // All available indices out of range — fall back to random from all
      index = Math.floor(Math.random() * credentials.length);
      isRateLimitFallback = true;
    }
  } else if (availableIndices && availableIndices.length === 0) {
    // All keys are rate-limited — pick randomly anyway (best effort)
    index = Math.floor(Math.random() * credentials.length);
    isRateLimitFallback = true;
  } else {
    // No availability info — pure random (backward compatible)
    index = Math.floor(Math.random() * credentials.length);
  }

  const selected = credentials[index]!;
  return {
    selected,
    index,
    total: credentials.length,
    keySuffix: selected.slice(-5),
    keyType,
    isRateLimitFallback,
  };
}

/**
 * Legacy wrapper for backward compatibility.
 * @deprecated Use selectCredential instead
 */
export function selectRandomCredential(value: string): {
  selected: string;
  index: number;
  total: number;
} {
  const result = selectCredential(value);
  return { selected: result.selected, index: result.index, total: result.total };
}

export const CLAUDE_CREDENTIALS_HINT =
  "Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or route Claude Code through a gateway (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY), Microsoft Foundry (CLAUDE_CODE_USE_FOUNDRY), Amazon Bedrock (CLAUDE_CODE_USE_BEDROCK), or Google Vertex AI (CLAUDE_CODE_USE_VERTEX).";

const CLAUDE_CREDENTIAL_TYPE_BY_PROVIDER: Record<string, string> = {
  "claude-subscription": "oauth",
  anthropic: "api_key",
  "anthropic-gateway": "gateway",
};

/**
 * Validate that the claude harness has a usable default route (see
 * `deriveDefaultRoute` in @desplega/model-routing for the precedence).
 * Returns the credential type found ("oauth", "api_key", "gateway", "foundry",
 * "bedrock", "vertex"), or throws with what is missing.
 */
export function validateClaudeCredentials(env: Record<string, string | undefined>): string {
  const route = deriveDefaultRoute("claude", env);
  if (!route) throw new Error(`No Claude credentials found. ${CLAUDE_CREDENTIALS_HINT}`);
  const status = routeCredentialStatus(route, env);
  if (!status.ready) throw new Error(`No Claude credentials found. ${status.hint}`);
  return CLAUDE_CREDENTIAL_TYPE_BY_PROVIDER[route.provider] ?? route.provider;
}

/**
 * Validate that at least one opencode credential is available.
 * Priority: OPENROUTER_API_KEY → ANTHROPIC_API_KEY → OPENAI_API_KEY → ~/.local/share/opencode/auth.json.
 * Returns the credential type found, or throws if none are available.
 */
export function validateOpencodeCredentials(
  env: Record<string, string | undefined>,
): "openrouter_api_key" | "anthropic_api_key" | "openai_api_key" | "auth_file" {
  if (env.OPENROUTER_API_KEY) return "openrouter_api_key";
  if (env.ANTHROPIC_API_KEY) return "anthropic_api_key";
  if (env.OPENAI_API_KEY) return "openai_api_key";
  const authFile = `${process.env.HOME ?? "/root"}/.local/share/opencode/auth.json`;
  if (existsSync(authFile)) return "auth_file";
  throw new Error(
    "No opencode credentials found. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or provide ~/.local/share/opencode/auth.json.",
  );
}

/** Per-pool availability, including the model-scoped block breakdown when a model was requested. */
export interface AvailabilityInfo {
  availableIndices: number[];
  modelBlockedIndices?: number[];
  earliestModelResetAt?: string | null;
  /** Indices excluded because the key's subscription plan cannot run the model. */
  seatBlockedIndices?: number[];
}

/**
 * Fetch available (non-rate-limited) key indices from the API for each credential pool.
 * Returns a map of envVar → availability info. When `modelFamily` has a weekly
 * window (fable/opus/sonnet — haiku has none), the request also asks the
 * server to exclude keys with an active block for that family.
 */
async function fetchAvailableIndices(
  env: Record<string, string | undefined>,
  apiUrl: string,
  apiKey: string,
  poolVars: readonly string[] = CREDENTIAL_POOL_VARS,
  modelFamily?: ModelFamily,
): Promise<Record<string, AvailabilityInfo>> {
  const availableIndicesMap: Record<string, AvailabilityInfo> = {};
  const window = modelFamily ? windowForModelFamily(modelFamily) : undefined;
  const modelParam = window ? `&model=${encodeURIComponent(modelFamily as string)}` : "";
  for (const envVar of poolVars) {
    const val = env[envVar];
    if (val) {
      const totalKeys = val.includes(",") ? val.split(",").filter((s) => s.trim()).length : 1;
      try {
        const resp = await fetch(
          `${apiUrl}/api/keys/available?keyType=${encodeURIComponent(envVar)}&totalKeys=${totalKeys}${modelParam}`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        if (resp.ok) {
          const data = (await resp.json()) as {
            availableIndices: number[];
            modelBlockedIndices?: number[];
            earliestModelResetAt?: string | null;
            seatBlockedIndices?: number[];
          };
          availableIndicesMap[envVar] = {
            availableIndices: data.availableIndices,
            modelBlockedIndices: data.modelBlockedIndices,
            earliestModelResetAt: data.earliestModelResetAt,
            seatBlockedIndices: data.seatBlockedIndices,
          };
          if (data.availableIndices.length < totalKeys) {
            console.log(
              `[credentials] ${envVar}: ${data.availableIndices.length}/${totalKeys} keys available (${totalKeys - data.availableIndices.length} rate-limited)`,
            );
          }
        }
      } catch {
        // Non-critical — fall back to random selection
      }
    }
  }
  return availableIndicesMap;
}

/**
 * For credential env vars that contain comma-separated values,
 * select one based on availability (rate-limit aware when API info is available).
 * When apiUrl and apiKey are provided, fetches rate-limit availability from the API.
 * Returns tracking info about which credentials were selected.
 */
export async function resolveCredentialPools(
  env: Record<string, string | undefined>,
  opts?: {
    apiUrl?: string;
    apiKey?: string;
    availableIndicesMap?: Record<string, AvailabilityInfo>;
    /**
     * Optional `HARNESS_PROVIDER` value (claude, pi, codex). When provided,
     * only credential env vars relevant to that provider are pooled. This
     * prevents e.g. a codex worker from stamping a CLAUDE_CODE_OAUTH_TOKEN
     * on its task record when both env vars happen to be set in the
     * container env. Defaults to ALL pool vars for backwards compatibility.
     */
    provider?: string;
    /**
     * Optional model string (e.g. "google/gemini-3-flash-preview", "gpt-4o").
     * Used together with `provider` to apply the harness × model matrix:
     * an OpenRouter-routed model (contains "/") on the opencode harness must
     * not select OPENAI_API_KEY, while a direct OpenAI model may. Also used
     * to derive the model family (fable/opus/sonnet/haiku) for the
     * model-scoped window filter.
     */
    model?: string;
    /**
     * In-process guard (`RunnerState.modelWindowBlocks`) against re-drawing a
     * key whose model-scoped window was just reported exhausted, before the
     * server's write is visible to this worker's next `GET
     * /api/keys/available` poll. Keyed by `${keyType}:${keyIndex}:${window}`,
     * value is the reset time in ms.
     */
    localBlocks?: Map<string, number>;
    /**
     * Set only at task admission (`spawnProviderProcess`). When true, an
     * exhausted model window, or a pool where every remaining key is on a
     * seat that cannot run the model, fails fast with
     * `ModelWindowExhaustedError`.
     * Taskless configuration loads (worker boot, credential recovery,
     * periodic reconciliation) leave it unset: they still pick a key, so an
     * exhausted default model never blocks boot or config refresh, and the
     * worker can still accept tasks for another model.
     */
    enforceModelCapacity?: boolean;
  },
): Promise<CredentialSelection[]> {
  const providerVars = opts?.provider
    ? getModelAwareCredentialVars(opts.provider, opts.model)
    : CREDENTIAL_POOL_VARS;

  const modelFamily = modelFamilyOf(opts?.model);
  const window = modelFamily ? windowForModelFamily(modelFamily) : undefined;

  const availableIndicesMap =
    opts?.availableIndicesMap ??
    (opts?.apiUrl && opts?.apiKey
      ? await fetchAvailableIndices(env, opts.apiUrl, opts.apiKey, providerVars, modelFamily)
      : undefined);

  const nowMs = Date.now();
  const selections: CredentialSelection[] = [];
  for (const envVar of providerVars) {
    const val = env[envVar];
    if (val) {
      const info = availableIndicesMap?.[envVar];
      let available = info?.availableIndices;
      let modelBlockedCount = info?.modelBlockedIndices?.length ?? 0;
      if (available && window && opts?.localBlocks) {
        const beforeCount = available.length;
        available = available.filter((i) => {
          const blockedUntilMs = opts.localBlocks?.get(`${envVar}:${i}:${window}`);
          return blockedUntilMs === undefined || blockedUntilMs <= nowMs;
        });
        modelBlockedCount += beforeCount - available.length;
      }

      const seatBlockedIndices = info?.seatBlockedIndices ?? [];
      const seatBlockedCount = seatBlockedIndices.length;
      let seatFallbackIndices: number[] | undefined;

      // Every key is key-wide rate-limited, blocked by this model's weekly
      // window, or on a seat that cannot run the model, and at least one is
      // blocked specifically for the model (not just legacy key-wide rate
      // limiting) — the picker can't make progress for this model on this
      // pool. Default policy fails fast instead of looping the worker
      // through the same exhausted key every few minutes. A seat block is a
      // plan fact with no window and no reset, so the fallback pick excludes
      // seat-blocked keys: a pick from them is a guaranteed failure. It fails
      // only when every key is seat-blocked.
      if (opts?.enforceModelCapacity && modelFamily && available && available.length === 0) {
        const policy = (env.MODEL_WINDOW_EXHAUSTED_POLICY ?? "fail").trim().toLowerCase();
        const windowExhausted =
          window !== undefined && modelBlockedCount > 0 && policy !== "fallback";
        if (seatBlockedCount > 0) {
          seatFallbackIndices = splitCredentialPool(val)
            .map((_, i) => i)
            .filter((i) => !seatBlockedIndices.includes(i));
        }
        if (windowExhausted || seatFallbackIndices?.length === 0) {
          throw new ModelWindowExhaustedError({
            model: modelFamily,
            window: window ?? "",
            earliestResetAt: info?.earliestModelResetAt ?? null,
            keyType: envVar,
            seatBlockedCount,
            modelBlockedCount,
          });
        }
      }

      const result = seatFallbackIndices
        ? { ...selectCredential(val, seatFallbackIndices, envVar), isRateLimitFallback: true }
        : selectCredential(val, available, envVar);
      env[envVar] = result.selected;
      const availInfo = available ? ` (${available.length} available of ${result.total})` : "";
      console.log(
        `[credentials] Selected ${envVar} credential ${result.index + 1}/${result.total}${availInfo} [...${result.keySuffix}]`,
      );
      selections.push({
        ...result,
        modelBlockedIndices: info?.modelBlockedIndices,
        earliestModelResetAt: info?.earliestModelResetAt,
        seatBlockedIndices: info?.seatBlockedIndices,
      });
    }
  }
  return selections;
}
