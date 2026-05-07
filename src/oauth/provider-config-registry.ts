import type { OAuthProviderConfig } from "./wrapper";

/**
 * Provider-specific OAuth config registry.
 *
 * Refresh paths in `ensure-token.ts` need the same {@link OAuthProviderConfig}
 * the integration's own callback flow uses — including additive fields like
 * `tokenAuthMode`, `tokenContentType`, `extraTokenHeaders`, and
 * `defaultTokenLifetimeMs` that aren't persisted in the `oauth_apps` table.
 *
 * Each integration registers its config builder here at module load (see
 * `src/notion/oauth.ts`). `ensure-token.ts` checks the registry first and
 * falls back to a legacy DB-only reconstruction for providers that don't
 * register (Linear, Jira — neither needs additive fields for refresh today).
 *
 * Why a registry instead of importing from `notion/oauth.ts` directly: the
 * `oauth/` module is a low-level primitive; integrations like `notion/`,
 * `jira/`, `linear/` sit above it. A direct import would invert the layering
 * and create a circular dependency through the `wrapper` types.
 */
type OAuthProviderConfigBuilder = () => OAuthProviderConfig | null;

const registry = new Map<string, OAuthProviderConfigBuilder>();

export function registerOAuthProviderConfig(
  provider: string,
  builder: OAuthProviderConfigBuilder,
): void {
  registry.set(provider, builder);
}

export function getRegisteredOAuthProviderConfig(provider: string): OAuthProviderConfig | null {
  const builder = registry.get(provider);
  return builder ? builder() : null;
}

/** Test helper — empties the registry between unit tests. */
export function _clearOAuthProviderConfigRegistry(): void {
  registry.clear();
}
