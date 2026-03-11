/** Env vars that may contain comma-separated credential pools */
export const CREDENTIAL_POOL_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/**
 * If a value contains commas, split and randomly select one credential.
 * Single values (no commas) are returned as-is for backward compatibility.
 */
export function selectRandomCredential(value: string): {
  selected: string;
  index: number;
  total: number;
} {
  const credentials = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (credentials.length <= 1) {
    return { selected: value, index: 0, total: 1 };
  }
  const index = Math.floor(Math.random() * credentials.length);
  return { selected: credentials[index]!, index, total: credentials.length };
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
 * randomly select one to distribute load across subscriptions.
 */
export function resolveCredentialPools(env: Record<string, string | undefined>): void {
  for (const envVar of CREDENTIAL_POOL_VARS) {
    const val = env[envVar];
    if (val?.includes(",")) {
      const { selected, index, total } = selectRandomCredential(val);
      env[envVar] = selected;
      console.log(`[credentials] Selected ${envVar} credential ${index + 1}/${total}`);
    }
  }
}
