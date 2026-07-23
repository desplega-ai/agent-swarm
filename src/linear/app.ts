import { getOAuthApp, upsertOAuthApp } from "../be/db-queries/oauth";
import { onAuthorizationRefreshed } from "../oauth/ensure-token";
import { getPublicMcpBaseUrl } from "../utils/constants";
import { resetLinearClient } from "./client";
import { initLinearOutboundSync, teardownLinearOutboundSync } from "./outbound";

let initialized = false;
let unsubscribeRefresh: (() => void) | null = null;

export function isLinearEnabled(): boolean {
  const disabled = process.env.LINEAR_DISABLE;
  if (disabled === "true" || disabled === "1") return false;
  const enabled = process.env.LINEAR_ENABLED;
  if (enabled === "false" || enabled === "0") return false;
  return !!process.env.LINEAR_CLIENT_ID;
}

export function resetLinear(): void {
  teardownLinearOutboundSync();
  if (unsubscribeRefresh) {
    unsubscribeRefresh();
    unsubscribeRefresh = null;
  }
  initialized = false;
}

export function initLinear(): boolean {
  if (initialized) return isLinearEnabled();
  initialized = true;

  if (!isLinearEnabled()) {
    console.log("[Linear] Integration disabled or LINEAR_CLIENT_ID not set");
    return false;
  }

  const clientId = process.env.LINEAR_CLIENT_ID!;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET ?? "";
  // Boot-time redirect URI gets persisted into oauth_apps.redirectUri and used
  // verbatim by the OAuth flow. Prefer MCP_BASE_URL over the localhost default
  // so prod doesn't send users back to localhost when LINEAR_REDIRECT_URI is
  // unset.
  const apiBaseUrl = getPublicMcpBaseUrl();
  const redirectUri =
    process.env.LINEAR_REDIRECT_URI ?? `${apiBaseUrl}/api/trackers/linear/callback`;

  // `upsertOAuthApp` replaces the metadata blob wholesale when `metadata` is
  // passed. Merge the seeded keys ON TOP of any existing metadata so a re-boot
  // is idempotent AND preserves foreign keys (e.g. operator edits — now
  // possible since the row is user-manageable after the carve-out removal, and
  // runtime keys a future Linear flow may add). Seeded actor/keepAlive win.
  // Mirrors initJira's preserve-on-update behavior (it omits metadata entirely).
  const existing = getOAuthApp("linear");
  const existingMetadata = (() => {
    try {
      const parsed = JSON.parse(existing?.metadata || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  })();

  upsertOAuthApp("linear", {
    clientId,
    clientSecret,
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    redirectUri,
    scopes: "read,write,issues:create,comments:create,app:assignable,app:mentionable",
    // Linear requires comma-separated scopes in the authorize URL (RFC default
    // is space) — pin the quirk as a column rather than relying on the
    // provider-string default in upsertOAuthApp.
    scopeSeparator: ",",
    // `actor: app` installs the OAuth app as its own bot user. `keepAlive`
    // opts the row into the generalized keepalive job (Linear does not rotate
    // refresh tokens, so it wouldn't qualify via requiresRefreshTokenRotation);
    // this mirrors migration 121's backfill for a fresh-DB boot where that
    // data-only migration matches no rows yet.
    metadata: JSON.stringify({ ...existingMetadata, actor: "app", keepAlive: true }),
  });

  // Invalidate the cached LinearClient whenever *any* path (sweep, reactive)
  // refreshes the Linear authorization, not just the outbound-sync call sites
  // that already reset it inline. Closes the staleness gap for background
  // refreshes.
  if (!unsubscribeRefresh) {
    unsubscribeRefresh = onAuthorizationRefreshed((event) => {
      if (event.provider === "linear") resetLinearClient();
    });
  }

  initLinearOutboundSync();

  warnIfMcpBaseUrlLooksLikeAppUrl();

  console.log("[Linear] Integration initialized");
  return true;
}

/**
 * Soft sanity check for `MCP_BASE_URL`. If it equals `APP_URL` (a common
 * misconfig that surfaces a wrong-looking webhook URL in the dashboard),
 * warn loudly so the operator can fix the env.
 */
function warnIfMcpBaseUrlLooksLikeAppUrl(): void {
  const mcp = process.env.MCP_BASE_URL?.trim().replace(/\/+$/, "");
  const app = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (mcp && app && mcp === app) {
    console.warn(
      `[Linear] WARNING: MCP_BASE_URL (${mcp}) equals APP_URL — surfaced webhook URL points at the dashboard host, not the API. Configure Linear with this URL only if the dashboard host also serves /api/*.`,
    );
  }
}
