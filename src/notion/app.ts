import { upsertOAuthApp } from "../be/db-queries/oauth";
import { NOTION_AUTHORIZE_URL, NOTION_TOKEN_URL } from "./constants";

let initialized = false;

export function isNotionEnabled(): boolean {
  const disabled = process.env.NOTION_DISABLE;
  if (disabled === "true" || disabled === "1") return false;
  const enabled = process.env.NOTION_ENABLED;
  if (enabled === "false" || enabled === "0") return false;
  return !!process.env.NOTION_CLIENT_ID;
}

export function resetNotion(): void {
  initialized = false;
}

/**
 * Initialise Notion integration. Persists/refreshes the `oauth_apps` row
 * for `provider='notion'` from env vars.
 *
 * **clientSecret-empty-bug guard:** if `NOTION_CLIENT_ID` is set but
 * `NOTION_CLIENT_SECRET` is missing or empty, throws at boot. Writing an
 * empty `clientSecret` would silently break `refreshAccessToken` later (and
 * `revokeNotionToken`) — we want a loud failure on the misconfiguration
 * instead of a 401 surfacing inside an agent task minutes later. Same shape
 * as the Jira fix from `jira-oauth-clientsecret-empty-bug` memory.
 */
export function initNotion(): boolean {
  if (initialized) return isNotionEnabled();
  initialized = true;

  if (!isNotionEnabled()) {
    console.log("[Notion] Integration disabled or NOTION_CLIENT_ID not set");
    return false;
  }

  const clientId = process.env.NOTION_CLIENT_ID!;
  const clientSecret = process.env.NOTION_CLIENT_SECRET ?? "";

  if (clientSecret.length === 0) {
    throw new Error(
      "[Notion] NOTION_CLIENT_ID is set but NOTION_CLIENT_SECRET is missing or empty. " +
        "Refusing to write an empty clientSecret to oauth_apps — this would break refresh + revoke later. " +
        "Set NOTION_CLIENT_SECRET (or unset NOTION_CLIENT_ID to disable) and restart.",
    );
  }

  // Boot-time redirect URI gets persisted into oauth_apps.redirectUri and used
  // verbatim by the OAuth flow — so it must match what's registered with
  // Notion. Prefer MCP_BASE_URL over the localhost dev default.
  const apiBaseUrl =
    process.env.MCP_BASE_URL?.trim().replace(/\/+$/, "") ||
    `http://localhost:${process.env.PORT || "3013"}`;
  const redirectUri =
    process.env.NOTION_REDIRECT_URI ?? `${apiBaseUrl}/api/trackers/notion/callback`;

  upsertOAuthApp("notion", {
    clientId,
    clientSecret,
    authorizeUrl: NOTION_AUTHORIZE_URL,
    tokenUrl: NOTION_TOKEN_URL,
    redirectUri,
    // Notion has no OAuth scopes — capabilities are configured at integration
    // creation time in https://www.notion.so/my-integrations. Persist empty
    // so the wrapper omits the `scope` query param.
    scopes: "",
    // Intentionally omit metadata: botId / workspaceId / etc. are written by
    // the OAuth callback flow. upsertOAuthApp preserves existing metadata on
    // UPDATE when not passed.
  });

  console.log("[Notion] Integration initialized");
  return true;
}
