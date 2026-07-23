import { assertUrlSafe, publicEndpointSsrfOptions } from "./mcp-wrapper";

export const RESERVED_OAUTH_PROVIDERS = new Set(["linear", "jira"]);

export function assertOAuthProviderIsNotReserved(provider: string): void {
  if (!RESERVED_OAUTH_PROVIDERS.has(provider.toLowerCase())) return;
  throw new Error(
    `OAuth provider "${provider}" is reserved for dedicated tracker OAuth flows. Use the Linear/Jira tracker integration flow instead.`,
  );
}

export function assertOAuthAppUrlsSafe(input: {
  authorizeUrl: string;
  tokenUrl: string;
  // These endpoints are fetched server-side with a live bearer / client_secret
  // (identity capture, token revocation) — they MUST pass the same fail-closed
  // SSRF check as authorize/token so an app-write cannot point them at an
  // internal host (e.g. 169.254.169.254) to exfiltrate credentials.
  userinfoUrl?: string | null;
  revocationUrl?: string | null;
}): void {
  const options = publicEndpointSsrfOptions();
  assertUrlSafe(input.authorizeUrl, options);
  assertUrlSafe(input.tokenUrl, options);
  if (input.userinfoUrl) assertUrlSafe(input.userinfoUrl, options);
  if (input.revocationUrl) assertUrlSafe(input.revocationUrl, options);
}

/**
 * Re-assert host safety on an endpoint we are about to fetch server-side with
 * credentials. Used at egress time (identity capture, revocation) as
 * defense-in-depth on top of write-time validation. Throws on unsafe hosts.
 */
export function assertOAuthEgressUrlSafe(url: string): void {
  assertUrlSafe(url, publicEndpointSsrfOptions());
}
