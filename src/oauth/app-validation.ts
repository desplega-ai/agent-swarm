import { assertUrlSafe, publicEndpointSsrfOptions } from "./mcp-wrapper";

// NOTE: the former `RESERVED_OAUTH_PROVIDERS` / `assertOAuthProviderIsNotReserved`
// carve-out was removed in step-8. `linear`/`jira` are now ordinary
// `oauth_apps` rows manageable from the generic OAuth-app surface; the tracker
// integration merely seeds and reads them. Delete-time foot-guns (dropping the
// seeded tracker app / an app with registered webhooks) are surfaced as a
// warning by the delete handler rather than blocked here.

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
