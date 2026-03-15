/**
 * OAuth-aware LinearClient wrapper with automatic token refresh.
 *
 * Exports `getLinearClient()` which returns a LinearClient instance
 * that transparently refreshes expired access tokens before each call.
 */
import { LinearClient } from "@linear/sdk";
import { getStoredTokens, isTokenExpiringSoon, refreshAccessToken } from "./oauth";

let cachedClient: LinearClient | null = null;
let cachedAccessToken: string | null = null;

/**
 * Returns a LinearClient using the current stored access token.
 * Refreshes the token if it's about to expire.
 * Returns `null` if no tokens are stored (OAuth not completed).
 */
export async function getLinearClient(): Promise<LinearClient | null> {
  let tokens = getStoredTokens();
  if (!tokens) return null;

  // Refresh if expiring soon
  if (isTokenExpiringSoon(tokens.expiresAt)) {
    console.log("[Linear] Access token expiring soon, refreshing...");
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      tokens = refreshed;
    } else {
      console.warn("[Linear] Token refresh failed, using existing token");
    }
  }

  // Re-use cached client if token hasn't changed
  if (cachedClient && cachedAccessToken === tokens.accessToken) {
    return cachedClient;
  }

  cachedAccessToken = tokens.accessToken;
  cachedClient = new LinearClient({ accessToken: tokens.accessToken });
  return cachedClient;
}

/**
 * Invalidates the cached client, forcing a fresh client on next call.
 * Used after token refresh or auth errors.
 */
export function resetLinearClient(): void {
  cachedClient = null;
  cachedAccessToken = null;
}

/**
 * Execute a Linear API call with automatic retry on auth failure.
 * If the first attempt fails with an auth error, refreshes the token and retries once.
 */
export async function withLinearClient<T>(
  fn: (client: LinearClient) => Promise<T>,
): Promise<T | null> {
  const client = await getLinearClient();
  if (!client) {
    console.warn("[Linear] No Linear client available (OAuth not completed)");
    return null;
  }

  try {
    return await fn(client);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    // Check for auth errors (401/403 or token-related messages)
    if (message.includes("401") || message.includes("403") || message.includes("authentication")) {
      console.log("[Linear] Auth error, attempting token refresh...");
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        resetLinearClient();
        const retryClient = await getLinearClient();
        if (retryClient) {
          return await fn(retryClient);
        }
      }
      console.error("[Linear] Token refresh failed, cannot retry");
    }

    throw error;
  }
}
