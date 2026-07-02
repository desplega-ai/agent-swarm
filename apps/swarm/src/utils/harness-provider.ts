import { type ProviderName, ProviderNameSchema } from "../types";

const SUPPORTED_PROVIDERS = ProviderNameSchema.options;

function hasEnvValue(
  key: string,
  resolvedEnv: Record<string, string | undefined>,
  fallbackEnv: Record<string, string | undefined>,
): boolean {
  return !!(resolvedEnv[key]?.trim() || fallbackEnv[key]?.trim());
}

/**
 * Credential-aware default for when HARNESS_PROVIDER is unset or invalid.
 * Unconditionally defaulting to "claude" leaves an OpenRouter-only swarm —
 * e.g. every auto-deployed swarm, which is provisioned with
 * OPENROUTER_API_KEY and NEVER an Anthropic credential — unable to
 * authenticate at all. Prefer "pi" when an OpenRouter key is present and no
 * Claude credential is; otherwise keep the original "claude" default.
 */
function credentialAwareDefault(
  resolvedEnv: Record<string, string | undefined>,
  fallbackEnv: Record<string, string | undefined>,
): ProviderName {
  const hasOpenRouterKey = hasEnvValue("OPENROUTER_API_KEY", resolvedEnv, fallbackEnv);
  const hasClaudeCredential =
    hasEnvValue("ANTHROPIC_API_KEY", resolvedEnv, fallbackEnv) ||
    hasEnvValue("CLAUDE_CODE_OAUTH_TOKEN", resolvedEnv, fallbackEnv);
  return hasOpenRouterKey && !hasClaudeCredential ? "pi" : "claude";
}

/**
 * Resolve the effective `HARNESS_PROVIDER` for a worker.
 *
 * Precedence (highest first):
 *   1. `resolvedEnv.HARNESS_PROVIDER` — value coming from `swarm_config`
 *      (overlay produced by `fetchResolvedEnv`, scoped repo > agent > global).
 *   2. `fallbackEnv.HARNESS_PROVIDER` — raw `process.env`.
 *   3. Credential-aware default — "pi" when an OpenRouter key is present and
 *      no Anthropic credential is (see `credentialAwareDefault`), else
 *      `"claude"`.
 *
 * Invalid values (anything outside `ProviderNameSchema`) log a warning and
 * fall through to the credential-aware default rather than throwing — boot
 * must not be killed by a typo'd swarm_config row.
 */
export function resolveHarnessProvider(
  resolvedEnv: Record<string, string | undefined>,
  fallbackEnv: Record<string, string | undefined> = process.env,
): ProviderName {
  const candidate = resolvedEnv.HARNESS_PROVIDER?.trim() || fallbackEnv.HARNESS_PROVIDER?.trim();
  if (!candidate) return credentialAwareDefault(resolvedEnv, fallbackEnv);
  const parsed = ProviderNameSchema.safeParse(candidate);
  if (!parsed.success) {
    console.warn(
      `[harness-provider] Invalid HARNESS_PROVIDER="${candidate}" (must be one of: ${SUPPORTED_PROVIDERS.join(", ")}); falling back to credential-aware default`,
    );
    return credentialAwareDefault(resolvedEnv, fallbackEnv);
  }
  return parsed.data;
}
