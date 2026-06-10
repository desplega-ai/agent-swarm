import { existsSync } from "node:fs";

/** Env vars that may contain comma-separated credential pools */
export const CREDENTIAL_POOL_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_OAUTH",
  "DEVIN_API_KEY",
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
}

/**
 * If a value contains commas, split and select one credential.
 * When availableIndices is provided, only those indices are considered (rate-limit aware).
 * Falls back to random selection from all credentials if no available indices match.
 */
export function selectCredential(
  value: string,
  availableIndices?: number[],
  keyType = "ANTHROPIC_API_KEY",
): CredentialSelection {
  const credentials = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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

/**
 * Validate that at least one Claude credential is available.
 * Priority: CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY.
 * Returns the credential type found, or throws if neither is set.
 */
export function validateClaudeCredentials(
  env: Record<string, string | undefined>,
): "oauth" | "api_key" {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return "oauth";
  if (env.ANTHROPIC_API_KEY) return "api_key";
  throw new Error("No Claude credentials found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.");
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

/**
 * Fetch available (non-rate-limited) key indices from the API for each credential pool.
 * Returns a map of envVar → available indices.
 */
async function fetchAvailableIndices(
  env: Record<string, string | undefined>,
  apiUrl: string,
  apiKey: string,
  poolVars: readonly string[] = CREDENTIAL_POOL_VARS,
): Promise<Record<string, number[]>> {
  const availableIndicesMap: Record<string, number[]> = {};
  for (const envVar of poolVars) {
    const val = env[envVar];
    if (val) {
      const totalKeys = val.includes(",") ? val.split(",").filter((s) => s.trim()).length : 1;
      try {
        const resp = await fetch(
          `${apiUrl}/api/keys/available?keyType=${encodeURIComponent(envVar)}&totalKeys=${totalKeys}`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        if (resp.ok) {
          const data = (await resp.json()) as { availableIndices: number[] };
          availableIndicesMap[envVar] = data.availableIndices;
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
    availableIndicesMap?: Record<string, number[]>;
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
     * not select OPENAI_API_KEY, while a direct OpenAI model may.
     */
    model?: string;
  },
): Promise<CredentialSelection[]> {
  const providerVars = opts?.provider
    ? getModelAwareCredentialVars(opts.provider, opts.model)
    : CREDENTIAL_POOL_VARS;

  const availableIndicesMap =
    opts?.availableIndicesMap ??
    (opts?.apiUrl && opts?.apiKey
      ? await fetchAvailableIndices(env, opts.apiUrl, opts.apiKey, providerVars)
      : undefined);

  const selections: CredentialSelection[] = [];
  for (const envVar of providerVars) {
    const val = env[envVar];
    if (val) {
      const available = availableIndicesMap?.[envVar];
      const result = selectCredential(val, available, envVar);
      env[envVar] = result.selected;
      const availInfo = available ? ` (${available.length} available of ${result.total})` : "";
      console.log(
        `[credentials] Selected ${envVar} credential ${result.index + 1}/${result.total}${availInfo} [...${result.keySuffix}]`,
      );
      selections.push({ ...result });
    }
  }
  return selections;
}
