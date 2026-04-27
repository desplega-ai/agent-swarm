import { getOAuthTokens } from "../be/db-queries/oauth";
import { ensureToken } from "../oauth/ensure-token";
import { getJiraMetadata } from "./metadata";

/**
 * Resolve a fresh Jira access token (refreshes if expiring soon).
 *
 * Throws if no tokens are stored — callers should treat this as "not yet
 * connected" rather than a programmer error.
 */
export async function getJiraAccessToken(): Promise<string> {
  await ensureToken("jira");
  const tokens = getOAuthTokens("jira");
  if (!tokens) {
    throw new Error("Jira not connected — no OAuth tokens stored");
  }
  return tokens.accessToken;
}

/**
 * Resolve the current workspace `cloudId` from `oauth_apps.metadata`.
 *
 * Throws if the OAuth callback hasn't completed yet (no cloudId persisted).
 */
export function getJiraCloudId(): string {
  const meta = getJiraMetadata();
  if (!meta.cloudId) {
    throw new Error("Jira cloudId not resolved — complete OAuth before calling Jira REST API");
  }
  return meta.cloudId;
}

/**
 * Typed fetch wrapper for the Atlassian Jira REST API.
 *
 * - Prepends `https://api.atlassian.com/ex/jira/{cloudId}` to `path`.
 * - Sets `Authorization: Bearer <token>` and `Accept: application/json`.
 * - Sets `Content-Type: application/json` when a body is provided.
 * - On 401: refreshes the token (forced via `ensureToken("jira", 0)`) and
 *   retries once.
 * - On 429: respects `Retry-After` (in seconds) with a single retry.
 *
 * Returns the raw `Response` — callers handle `response.json()`/`response.text()`
 * themselves so we don't impose a parse contract.
 */
export async function jiraFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!path.startsWith("/")) {
    throw new Error(`jiraFetch path must start with '/' — got: ${path}`);
  }

  const send = async (token: string): Promise<Response> => {
    const cloudId = getJiraCloudId();
    const url = `https://api.atlassian.com/ex/jira/${cloudId}${path}`;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(url, { ...init, headers });
  };

  let token = await getJiraAccessToken();
  let response = await send(token);

  if (response.status === 401) {
    // Force refresh — bufferMs=0 means "always refresh if any expiry is set"
    await ensureToken("jira", 0);
    token = await getJiraAccessToken();
    response = await send(token);
  }

  if (response.status === 429) {
    const retryAfterRaw = response.headers.get("Retry-After");
    const retryAfter = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : NaN;
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await send(token);
  }

  return response;
}
