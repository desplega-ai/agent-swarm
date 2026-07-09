import { assertUrlSafe, publicEndpointSsrfOptions } from "./mcp-wrapper";

export const RESERVED_OAUTH_PROVIDERS = new Set(["linear", "jira"]);

export function assertOAuthProviderIsNotReserved(provider: string): void {
  if (!RESERVED_OAUTH_PROVIDERS.has(provider.toLowerCase())) return;
  throw new Error(
    `OAuth provider "${provider}" is reserved for dedicated tracker OAuth flows. Use the Linear/Jira tracker integration flow instead.`,
  );
}

export function assertOAuthAppUrlsSafe(input: { authorizeUrl: string; tokenUrl: string }): void {
  const options = publicEndpointSsrfOptions();
  assertUrlSafe(input.authorizeUrl, options);
  assertUrlSafe(input.tokenUrl, options);
}
