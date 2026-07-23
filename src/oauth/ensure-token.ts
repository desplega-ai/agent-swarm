import {
  acquireOAuthRefreshLock,
  getAuthorizationById,
  getDefaultAuthorizationIdForProvider,
  getOAuthApp,
  getOAuthAppById,
  markAuthorizationRefreshFailed,
  type OAuthAuthorization,
  releaseOAuthRefreshLock,
  updateAuthorizationTokens,
} from "../be/db-queries/oauth";
import type { OAuthApp } from "../tracker/types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { type OAuthProviderConfig, performTokenRefreshRequest } from "./wrapper";

function parseMetadata(metadataJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadataJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

/**
 * Map an oauth_apps row to a provider config. Single source of truth for the
 * token-endpoint behavior knobs stored in metadata (extraParams,
 * tokenAuthStyle, tokenBodyFormat) — used by ensure-token and re-exported by
 * be/oauth-credential-bindings (which can't be imported from here without a
 * cycle).
 */
export function oauthAppRowToProviderConfig(app: OAuthApp): OAuthProviderConfig {
  const metadata = parseMetadata(app.metadata);
  const liftedExtraParams = stringRecord(parseMetadata(app.extraParamsJson));
  const extraParams = {
    ...(typeof metadata.actor === "string" ? { actor: metadata.actor } : {}),
    ...liftedExtraParams,
  };

  return {
    provider: app.provider,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    authorizeUrl: app.authorizeUrl,
    tokenUrl: app.tokenUrl,
    redirectUri: app.redirectUri,
    scopes: app.scopes
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
    extraParams: Object.keys(extraParams).length > 0 ? extraParams : undefined,
    scopeSeparator: app.scopeSeparator,
    tokenAuthStyle: app.tokenAuthStyle,
    tokenBodyFormat: app.tokenBodyFormat,
    requiresRefreshTokenRotation: app.requiresRefreshTokenRotation,
  };
}

// ─── Typed refresh error ─────────────────────────────────────────────────────

export type OAuthRefreshFailureReason = "refresh_rejected" | "lock_timeout" | "no_refresh_token";

/**
 * Thrown by the authorization-keyed refresh path when an expiring authorization
 * cannot be refreshed. Carries structured context so downstream surfaces (the
 * credential broker → script failedBindings, HTTP endpoints, alerting) can
 * report *which* authorization broke and *why* instead of a silent drop.
 *
 * Shape precedent: {@link CodexOAuthRefreshError} in
 * src/providers/codex-oauth/storage.ts.
 */
export class OAuthRefreshError extends Error {
  constructor(
    public readonly authorizationId: string,
    public readonly appId: string,
    public readonly reason: OAuthRefreshFailureReason,
    public readonly authorizationLabel: string,
    message?: string,
  ) {
    super(message ?? `OAuth authorization '${authorizationLabel}' refresh failed (${reason})`);
    this.name = "OAuthRefreshError";
  }
}

function authorizationLabelFor(app: OAuthApp, authorization: OAuthAuthorization): string {
  const base = app.displayName?.trim() || app.provider;
  return authorization.label && authorization.label !== "default"
    ? `${base} (${authorization.label})`
    : base;
}

// ─── Refresh locks (in-process queue + cross-process DB lock) ─────────────────

const refreshLocks = new Map<string, Promise<void>>();
const REFRESH_LOCK_TTL_MS = 2 * 60 * 1000;
const REFRESH_LOCK_WAIT_MS = 30 * 1000;
const REFRESH_LOCK_POLL_MS = 250;
const DEFAULT_REFRESH_BUFFER_MS = 5 * 60 * 1000;

async function withAuthorizationRefreshLock<T>(
  authorizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = refreshLocks.get(authorizationId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  refreshLocks.set(authorizationId, next);

  await previous.catch(() => undefined);

  try {
    return await fn();
  } finally {
    release();
    if (refreshLocks.get(authorizationId) === next) {
      refreshLocks.delete(authorizationId);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * An authorization needs a refresh when it is expiring within `bufferMs`, has
 * no expiry, or is already in a non-terminal broken state (`refresh-failed` /
 * `expired`) — so the sweep and on-demand resolution retry those each pass and
 * self-heal once the provider recovers.
 */
function authorizationNeedsRefresh(
  authorization: OAuthAuthorization,
  bufferMs = DEFAULT_REFRESH_BUFFER_MS,
): boolean {
  if (authorization.status === "refresh-failed" || authorization.status === "expired") return true;
  if (!authorization.expiresAt) return true;
  const expiresAt = new Date(authorization.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - Date.now() < bufferMs;
}

/**
 * Buffer large enough that any stored expiry counts as "expiring soon",
 * turning a refresh call into an unconditional refresh.
 */
const FORCE_REFRESH_BUFFER_MS = 1000 * 60 * 60 * 24 * 365 * 100; // ~100 years

// ─── Authorization-keyed core ────────────────────────────────────────────────

/**
 * Strict authorization-keyed refresh. Refreshes the given authorization if it
 * is expiring (or already broken), persisting `status='active'` +
 * `lastRefreshedAt` on success and `status='refresh-failed'` +
 * `lastErrorMessage` (scrubbed) + a thrown {@link OAuthRefreshError} on
 * failure.
 *
 * Stays silent (no throw, no status change) when the authorization is missing,
 * revoked, or has no provider-facing app config — those are "not connected"
 * states, not refresh failures.
 */
export async function ensureAuthorizationTokenOrThrow(
  authorizationId: string,
  bufferMs?: number,
): Promise<void> {
  const initial = getAuthorizationById(authorizationId);
  if (!initial || initial.status === "revoked") return;
  if (!authorizationNeedsRefresh(initial, bufferMs)) return;

  await withAuthorizationRefreshLock(authorizationId, async () => {
    const waitStartedAt = Date.now();

    while (true) {
      const current = getAuthorizationById(authorizationId);
      if (!current || current.status === "revoked") return;
      // Another caller refreshed (tokenVersion bumped) since this call loaded
      // the row — its work satisfies ours. Without this check a waiter whose
      // bufferMs exceeds the token lifetime (e.g. force refresh) would rotate
      // again immediately after the winner, burning provider refresh calls.
      if (current.tokenVersion !== initial.tokenVersion) return;
      if (!authorizationNeedsRefresh(current, bufferMs)) return;

      const app = getOAuthAppById(current.appId);
      // No provider-facing app config (missing, or a DCR/MCP app): nothing this
      // path can refresh — leave status untouched.
      if (!app || app.mcpServerId !== null) return;

      if (!current.refreshToken) {
        const label = authorizationLabelFor(app, current);
        const message = `OAuth authorization '${label}' cannot refresh: no refresh token stored`;
        markAuthorizationRefreshFailed(authorizationId, message);
        throw new OAuthRefreshError(authorizationId, app.id, "no_refresh_token", label, message);
      }

      const lockOwner = acquireOAuthRefreshLock(`authz:${authorizationId}`, REFRESH_LOCK_TTL_MS);
      if (!lockOwner) {
        if (Date.now() - waitStartedAt > REFRESH_LOCK_WAIT_MS) {
          const label = authorizationLabelFor(app, current);
          const message = `Timed out waiting for OAuth refresh lock for '${label}'`;
          markAuthorizationRefreshFailed(authorizationId, message);
          throw new OAuthRefreshError(authorizationId, app.id, "lock_timeout", label, message);
        }
        await sleep(REFRESH_LOCK_POLL_MS);
        continue;
      }

      try {
        // Re-read under the cross-process lock: another node may have refreshed
        // (tokenVersion bumped → no longer expiring) or revoked while we waited.
        const locked = getAuthorizationById(authorizationId);
        if (!locked || locked.status === "revoked") return;
        if (locked.tokenVersion !== initial.tokenVersion) return;
        if (!authorizationNeedsRefresh(locked, bufferMs)) return;

        const lockedApp = getOAuthAppById(locked.appId);
        if (!lockedApp || lockedApp.mcpServerId !== null) return;

        if (!locked.refreshToken) {
          const label = authorizationLabelFor(lockedApp, locked);
          const message = `OAuth authorization '${label}' cannot refresh: no refresh token stored`;
          markAuthorizationRefreshFailed(authorizationId, message);
          throw new OAuthRefreshError(
            authorizationId,
            lockedApp.id,
            "no_refresh_token",
            label,
            message,
          );
        }

        const config = oauthAppRowToProviderConfig(lockedApp);
        try {
          const refreshed = await performTokenRefreshRequest(config, locked.refreshToken);
          const persisted = updateAuthorizationTokens(authorizationId, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? locked.refreshToken,
            expiresAt: refreshed.expiresAt,
            scope: refreshed.scope ?? null,
            expectedTokenVersion: locked.tokenVersion,
          });
          if (!persisted) {
            // Optimistic-concurrency loss to a concurrent writer — re-evaluate.
            continue;
          }
          return;
        } catch (err) {
          const label = authorizationLabelFor(lockedApp, locked);
          const message = scrubSecrets(err instanceof Error ? err.message : String(err));
          markAuthorizationRefreshFailed(authorizationId, message);
          if (err instanceof OAuthRefreshError) throw err;
          throw new OAuthRefreshError(
            authorizationId,
            lockedApp.id,
            "refresh_rejected",
            label,
            message,
          );
        }
      } finally {
        releaseOAuthRefreshLock(`authz:${authorizationId}`, lockOwner);
      }
    }
  });
}

/**
 * Reactive authorization-keyed refresh — never throws. Refresh failures are
 * persisted (`refresh-failed`) by {@link ensureAuthorizationTokenOrThrow} and
 * logged here so a single dead-token incident doesn't tear down an unrelated
 * request path.
 */
export async function ensureAuthorizationToken(
  authorizationId: string,
  bufferMs?: number,
): Promise<void> {
  try {
    await ensureAuthorizationTokenOrThrow(authorizationId, bufferMs);
  } catch (err) {
    console.error(
      scrubSecrets(
        `[OAuth] Failed to refresh authorization ${authorizationId}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

/**
 * Force a refresh of a specific authorization regardless of remaining lifetime,
 * through the same lock + persistence path. Used by the manual refresh endpoint
 * and the background sweep.
 */
export async function forceRefreshAuthorizationOrThrow(authorizationId: string): Promise<void> {
  await ensureAuthorizationTokenOrThrow(authorizationId, FORCE_REFRESH_BUFFER_MS);
}

// ─── Provider-string compatibility wrappers ──────────────────────────────────
//
// Resolve a provider to its migrated `default` authorization and delegate to
// the authorization-keyed core. Tracker callers migrate off these in step-8.

/**
 * Reactive per-provider refresh — never throws. See {@link ensureToken} history:
 * refresh failures are logged, not surfaced.
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
 * Strict per-provider refresh. Delegates to the default authorization.
 *
 * Stays silent (no throw) when the provider isn't connected (no app / no
 * default authorization) or the default authorization has no stored refresh
 * token — those are "not connected" states, preserved for legacy tracker /
 * oauth-access-token callers. A genuine provider rejection still throws.
 */
export async function ensureTokenOrThrow(provider: string, bufferMs?: number): Promise<void> {
  const authorizationId = getDefaultAuthorizationIdForProvider(provider);
  if (!authorizationId) return;
  try {
    await ensureAuthorizationTokenOrThrow(authorizationId, bufferMs);
  } catch (err) {
    if (err instanceof OAuthRefreshError && err.reason === "no_refresh_token") {
      // Legacy provider-string semantics: a provider with no refresh token is
      // "not connected", not a refresh failure — stay silent.
      return;
    }
    throw err;
  }
}

/**
 * Force-refresh a provider's default authorization. Silent when not connected.
 */
export async function forceRefreshTokenOrThrow(provider: string): Promise<void> {
  const authorizationId = getDefaultAuthorizationIdForProvider(provider);
  if (!authorizationId) return;
  try {
    await forceRefreshAuthorizationOrThrow(authorizationId);
  } catch (err) {
    if (err instanceof OAuthRefreshError && err.reason === "no_refresh_token") return;
    throw err;
  }
}

/**
 * Build an OAuthProviderConfig from the oauth_apps table for any provider.
 * Retained for callers that only need the provider config (not a refresh).
 */
export function getOAuthConfig(provider: string): OAuthProviderConfig | null {
  const app = getOAuthApp(provider);
  return app ? oauthAppRowToProviderConfig(app) : null;
}
