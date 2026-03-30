/** Env vars that may contain comma-separated credential pools */
export const CREDENTIAL_POOL_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** Result of credential selection, including tracking info */
export interface CredentialSelection {
  selected: string;
  index: number;
  total: number;
  /** Last 5 characters of the selected credential (for tracking) */
  keySuffix: string;
}

/**
 * If a value contains commas, split and select one credential.
 * When availableIndices is provided, only those indices are considered (rate-limit aware).
 * Falls back to random selection from all credentials if no available indices match.
 */
export function selectCredential(value: string, availableIndices?: number[]): CredentialSelection {
  const credentials = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (credentials.length <= 1) {
    const selected = value.trim();
    return { selected, index: 0, total: 1, keySuffix: selected.slice(-5) };
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
  return { selected, index, total: credentials.length, keySuffix: selected.slice(-5) };
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
 * For credential env vars that contain comma-separated values,
 * select one based on availability (rate-limit aware when availableIndicesMap is provided).
 * Returns tracking info about which credentials were selected.
 */
export function resolveCredentialPools(
  env: Record<string, string | undefined>,
  availableIndicesMap?: Record<string, number[]>,
): CredentialSelection[] {
  const selections: CredentialSelection[] = [];
  for (const envVar of CREDENTIAL_POOL_VARS) {
    const val = env[envVar];
    if (val?.includes(",")) {
      const available = availableIndicesMap?.[envVar];
      const result = selectCredential(val, available);
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
