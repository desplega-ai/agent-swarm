/**
 * Pinned Notion API version sent on every request.
 *
 * Notion uses opaque date-style version strings; pinning keeps responses
 * stable across silent server-side changes. Bump deliberately and re-test
 * the integration when changing this value.
 *
 * Reference: https://developers.notion.com/reference/versioning
 */
export const NOTION_VERSION = "2025-09-03";

/**
 * Default access-token lifetime fallback. Notion's token-exchange response
 * does not include `expires_in`, but the empirically-observed access-token
 * TTL is ~1h with refresh-token rotation. The 1h fallback ensures
 * `isTokenExpiringSoon` triggers under the standard 65-min keepalive buffer.
 */
export const NOTION_DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
export const NOTION_REVOKE_URL = "https://api.notion.com/v1/oauth/revoke";
