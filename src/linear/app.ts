import { upsertOAuthApp } from "../be/db-queries/oauth";
import { initLinearOutboundSync, teardownLinearOutboundSync } from "./outbound";

let initialized = false;

export function isLinearEnabled(): boolean {
  const disabled = process.env.LINEAR_DISABLE;
  if (disabled === "true" || disabled === "1") return false;
  const enabled = process.env.LINEAR_ENABLED;
  if (enabled === "false" || enabled === "0") return false;
  return !!process.env.LINEAR_CLIENT_ID;
}

export function resetLinear(): void {
  teardownLinearOutboundSync();
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
  const apiBaseUrl =
    process.env.MCP_BASE_URL?.trim().replace(/\/+$/, "") ||
    `http://localhost:${process.env.PORT || "3013"}`;
  const redirectUri =
    process.env.LINEAR_REDIRECT_URI ?? `${apiBaseUrl}/api/trackers/linear/callback`;

  upsertOAuthApp("linear", {
    clientId,
    clientSecret,
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    redirectUri,
    scopes: "read,write,issues:create,comments:create,app:assignable,app:mentionable",
    metadata: JSON.stringify({ actor: "app" }),
  });

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
