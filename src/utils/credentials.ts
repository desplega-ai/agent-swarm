/** Env vars that may contain comma-separated credential pools */
export const CREDENTIAL_POOL_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_OAUTH",
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
  // pi-mono accepts either router or anthropic keys
  pi: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY", "CODEX_OAUTH"],
};

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
    return { selected, index: 0, total: 1, keySuffix: selected.slice(-5), keyType };
  }

  let index: number;
  if (availableIndices && availableIndices.length > 0) {
    // Pick randomly from available (non-rate-limited) indices
    const validIndices = availableIndices.filter((i) => i >= 0 && i < credentials.length);
    if (validIndices.length > 0) {
      index = validIndices[Math.floor(Math.random() * validIndices.length)]!;
    } else {
      // All available indices out of range — fall back to random from all
      index = Math.floor(Math.random() * credentials.length);
    }
  } else if (availableIndices && availableIndices.length === 0) {
    // All keys are rate-limited — pick randomly anyway (best effort)
    index = Math.floor(Math.random() * credentials.length);
  } else {
    // No availability info — pure random (backward compatible)
    index = Math.floor(Math.random() * credentials.length);
  }

  const selected = credentials[index]!;
  return { selected, index, total: credentials.length, keySuffix: selected.slice(-5), keyType };
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
  },
): Promise<CredentialSelection[]> {
  const providerVars = opts?.provider
    ? (PROVIDER_CREDENTIAL_VARS[opts.provider] ?? CREDENTIAL_POOL_VARS)
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
