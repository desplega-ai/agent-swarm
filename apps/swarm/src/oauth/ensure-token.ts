import {
  acquireOAuthRefreshLock,
  getOAuthApp,
  getOAuthTokens,
  isTokenExpiringSoon,
  releaseOAuthRefreshLock,
} from "../be/db-queries/oauth";
import type { OAuthTokens } from "../tracker/types";
import { type OAuthProviderConfig, refreshAccessToken } from "./wrapper";

const refreshLocks = new Map<string, Promise<void>>();
const REFRESH_LOCK_TTL_MS = 2 * 60 * 1000;
const REFRESH_LOCK_WAIT_MS = 30 * 1000;
const REFRESH_LOCK_POLL_MS = 250;

/**
 * Build an OAuthProviderConfig from the oauth_apps table for any provider.
 */
function getOAuthConfig(provider: string): OAuthProviderConfig | null {
  const app = getOAuthApp(provider);
  if (!app) return null;

  const metadata = JSON.parse(app.metadata || "{}");
  return {
    provider,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    authorizeUrl: app.authorizeUrl,
    tokenUrl: app.tokenUrl,
    redirectUri: app.redirectUri,
    scopes: app.scopes.split(","),
    extraParams: metadata.extraParams ?? (metadata.actor ? { actor: metadata.actor } : undefined),
    requiresRefreshTokenRotation: provider === "jira",
  };
}

async function withProviderRefreshLock<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  const previous = refreshLocks.get(provider) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  refreshLocks.set(provider, next);

  await previous.catch(() => undefined);

  try {
    return await fn();
  } finally {
    release();
    if (refreshLocks.get(provider) === next) {
      refreshLocks.delete(provider);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenRowChanged(current: OAuthTokens | null, observed: OAuthTokens | null): boolean {
  if (!observed) return current !== null;
  if (!current) return true;
  return (
    current.accessToken !== observed.accessToken ||
    current.refreshToken !== observed.refreshToken ||
    current.expiresAt !== observed.expiresAt
  );
}

/**
 * Ensure a valid OAuth token exists for the given provider.
 * If the token is expiring soon, attempt to refresh it.
 * Call this before any API interaction with an OAuth-protected service.
 *
 * Reactive variant — never throws. Refresh failures are logged so a single
 * dead-token incident doesn't tear down an unrelated request path. Use
 * {@link ensureTokenOrThrow} from keepalive contexts where you want a dead
 * refresh token to surface as an alert.
 *
 * @param bufferMs - How far ahead to check for expiry. Default 5 min (reactive use).
 *                   Keepalive callers should pass a larger value (e.g. 13h) to force
 *                   a proactive refresh well before the token actually expires.
 */
export async function ensureToken(provider: string, bufferMs?: number): Promise<void> {
  try {
    await ensureTokenOrThrow(provider, bufferMs);
  } catch (err) {
    console.error(
      `[OAuth] Failed to refresh ${provider} token:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Strict variant of {@link ensureToken}: throws on refresh failure of a
 * configured provider so callers (keepalive, alerting) can react.
 *
 * Stays silent (no throw) when the provider isn't configured or no refresh
 * token is stored — those are "not connected" states, not failures, and
 * shouldn't page anyone.
 */
export async function ensureTokenOrThrow(provider: string, bufferMs?: number): Promise<void> {
  if (!isTokenExpiringSoon(provider, bufferMs)) return;
  const observedTokens = getOAuthTokens(provider);

  await withProviderRefreshLock(provider, async () => {
    const waitStartedAt = Date.now();

    while (isTokenExpiringSoon(provider, bufferMs)) {
      const tokens = getOAuthTokens(provider);
      if (tokenRowChanged(tokens, observedTokens)) return;

      const config = getOAuthConfig(provider);
      if (!config || !tokens?.refreshToken) {
        console.warn(
          `[OAuth] ${provider} token expiring but cannot refresh (missing config or refresh token)`,
        );
        return;
      }

      const lockOwner = acquireOAuthRefreshLock(provider, REFRESH_LOCK_TTL_MS);
      if (!lockOwner) {
        if (Date.now() - waitStartedAt > REFRESH_LOCK_WAIT_MS) {
          throw new Error(`Timed out waiting for ${provider} OAuth token refresh lock`);
        }
        await sleep(REFRESH_LOCK_POLL_MS);
        continue;
      }

      try {
        const lockedTokens = getOAuthTokens(provider);
        if (
          !isTokenExpiringSoon(provider, bufferMs) ||
          tokenRowChanged(lockedTokens, observedTokens)
        ) {
          return;
        }

        const lockedConfig = getOAuthConfig(provider);
        if (!lockedConfig || !lockedTokens?.refreshToken) {
          console.warn(
            `[OAuth] ${provider} token expiring but cannot refresh (missing config or refresh token)`,
          );
          return;
        }

        await refreshAccessToken(lockedConfig, lockedTokens.refreshToken);
        console.log(`[OAuth] ${provider} token refreshed successfully`);
        return;
      } finally {
        releaseOAuthRefreshLock(provider, lockOwner);
      }
    }
  });
}
