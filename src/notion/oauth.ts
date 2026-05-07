import { getOAuthApp } from "../be/db-queries/oauth";
import { buildAuthorizationUrl, exchangeCode, type OAuthProviderConfig } from "../oauth/wrapper";
import { NOTION_DEFAULT_TOKEN_LIFETIME_MS, NOTION_REVOKE_URL, NOTION_VERSION } from "./constants";
import { updateNotionMetadata } from "./metadata";
import type { NotionOAuthAppMetadata } from "./types";

/**
 * Build the OAuth provider config for the generic wrapper.
 *
 * Notion's public-OAuth flow diverges from RFC 6749 / Linear / Jira:
 *
 * - Token endpoint expects HTTP Basic auth (`tokenAuthMode: "basic"`), not
 *   `client_id`/`client_secret` in the form body.
 * - Token endpoint expects `application/json` (`tokenContentType: "json"`).
 * - Every token-endpoint request must carry `Notion-Version`.
 * - No PKCE support — `usePkce: false` suppresses `code_challenge` and
 *   `code_verifier`.
 * - No OAuth scopes — capabilities are configured at integration creation
 *   time in Notion's developer console; `scopes: []` skips the `scope` param.
 * - Authorize URL requires `owner=user` (set via `extraParams`).
 * - Token responses don't include `expires_in`; `defaultTokenLifetimeMs` of
 *   1h matches the empirically-observed access-token TTL.
 */
export function getNotionOAuthConfig(): OAuthProviderConfig | null {
  const app = getOAuthApp("notion");
  if (!app) return null;

  return {
    provider: "notion",
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    authorizeUrl: app.authorizeUrl,
    tokenUrl: app.tokenUrl,
    redirectUri: app.redirectUri,
    scopes: [],
    extraParams: { owner: "user" },
    tokenAuthMode: "basic",
    tokenContentType: "json",
    extraTokenHeaders: { "Notion-Version": NOTION_VERSION },
    usePkce: false,
    defaultTokenLifetimeMs: NOTION_DEFAULT_TOKEN_LIFETIME_MS,
  };
}

export async function getNotionAuthorizationUrl(): Promise<string | null> {
  const config = getNotionOAuthConfig();
  if (!config) return null;
  const result = await buildAuthorizationUrl(config);
  return result.url;
}

/**
 * Handle the Notion OAuth callback: exchange the authorization code for tokens
 * (`exchangeCode` persists them via `storeOAuthTokens`), then persist the
 * workspace identity fields (botId, workspaceId, workspaceName, etc.) into
 * `oauth_apps.metadata`.
 *
 * The token-exchange response carries Notion-specific fields (`bot_id`,
 * `workspace_id`, ...) that the generic wrapper doesn't surface. We re-fetch
 * the response shape via a dedicated call indirection: the wrapper gives us
 * the standard subset (accessToken/refreshToken/scope), then we use that
 * accessToken to call `/v1/users/me` is overkill — the data we need was in
 * the original token-exchange response. So we do a second, parallel
 * token-shape extraction by calling the token endpoint ourselves... no — that
 * would consume a single-use code twice. Instead, we capture the extra fields
 * by intercepting the wrapper's response: not currently possible without
 * either changing the wrapper return shape (out of scope) or making a
 * separate `/v1/users/me?` call.
 *
 * **Phase 1 decision:** call `/v1/users/me` after the exchange to fetch
 * `bot.id`, `bot.workspace_name`, etc. One extra round-trip, but keeps the
 * wrapper untouched and the data structurally clean. The bot endpoint is
 * documented at https://developers.notion.com/reference/get-self.
 */
export async function handleNotionCallback(
  code: string,
  state: string,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  botId?: string;
  workspaceId?: string;
  workspaceName?: string | null;
}> {
  const config = getNotionOAuthConfig();
  if (!config) throw new Error("Notion OAuth not configured");

  const tokens = await exchangeCode(config, code, state);

  const meta = await fetchNotionBotIdentity(tokens.accessToken);
  updateNotionMetadata(meta);

  return {
    ...tokens,
    botId: meta.botId,
    workspaceId: meta.workspaceId,
    workspaceName: meta.workspaceName ?? null,
  };
}

/**
 * Best-effort revoke of an access token. Notion's revoke endpoint accepts
 * the token in the request body and Basic-auths the integration credentials.
 * Returns true on a 2xx response, false otherwise.
 */
export async function revokeNotionToken(accessToken: string): Promise<boolean> {
  const config = getNotionOAuthConfig();
  if (!config) return false;

  try {
    const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const res = await fetch(NOTION_REVOKE_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify({ token: accessToken }),
    });
    return res.ok;
  } catch (err) {
    console.warn(
      "[Notion] Token revocation failed (best-effort):",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Fetch `/v1/users/me` to resolve bot identity + workspace context.
 *
 * Exported only so the OAuth-callback flow can share it with the disconnect
 * flow's "verify-revoke" step. NOT a general-purpose helper — agents should
 * use the `notionFetch` client wrapper.
 */
async function fetchNotionBotIdentity(accessToken: string): Promise<NotionOAuthAppMetadata> {
  const res = await fetch("https://api.notion.com/v1/users/me", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion bot-identity fetch failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    id?: string;
    bot?: {
      owner?: Record<string, unknown>;
      workspace_name?: string | null;
    };
    name?: string | null;
    avatar_url?: string | null;
  };

  return {
    botId: data.id,
    workspaceName: data.bot?.workspace_name ?? data.name ?? null,
    workspaceIcon: data.avatar_url ?? null,
    owner: data.bot?.owner,
  };
}
