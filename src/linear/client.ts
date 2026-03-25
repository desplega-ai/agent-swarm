import { LinearClient } from "@linear/sdk";
import { getOAuthTokens, isTokenExpiringSoon } from "../be/db-queries/oauth";
import { refreshAccessToken } from "../oauth/wrapper";
import { getLinearOAuthConfig } from "./oauth";

let linearClient: LinearClient | null = null;

/**
 * Ensure the Linear OAuth token is valid, refreshing it if expiring/expired.
 * Call this before any Linear API interaction.
 */
export async function ensureValidLinearToken(): Promise<void> {
  if (!isTokenExpiringSoon("linear")) return;

  const config = getLinearOAuthConfig();
  const tokens = getOAuthTokens("linear");
  if (!config || !tokens?.refreshToken) {
    console.warn("[Linear] Token expiring but cannot refresh (missing config or refresh token)");
    return;
  }

  try {
    await refreshAccessToken(config, tokens.refreshToken);
    linearClient = null; // Reset cached client so it picks up the new token
    console.log("[Linear] OAuth token refreshed successfully");
  } catch (err) {
    console.error(
      "[Linear] Failed to refresh OAuth token:",
      err instanceof Error ? err.message : err,
    );
  }
}

export function getLinearClient(): LinearClient | null {
  const tokens = getOAuthTokens("linear");
  if (!tokens) return null;

  if (!linearClient) {
    linearClient = new LinearClient({ accessToken: tokens.accessToken });
  }
  return linearClient;
}

export function resetLinearClient(): void {
  linearClient = null;
}
