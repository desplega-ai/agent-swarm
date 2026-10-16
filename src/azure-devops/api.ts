/**
 * Azure DevOps REST interactions — comment likes (the 👀 ack), PR comments,
 * and resolving the bot identity behind the PAT. Uses raw fetch, no SDK.
 */

import {
  getAzureDevOpsOrgUrl,
  getAzureDevOpsToken,
  isTrustedOrgUrl,
  normalizeOrgUrl,
} from "./auth";

const API_VERSION = "7.1";

export interface AzureDevOpsPullRequestRef {
  orgUrl: string; // e.g. "https://dev.azure.com/fabrikam", no trailing slash
  projectId: string;
  repositoryId: string;
  pullRequestId: number;
}

function headers(): Record<string, string> {
  const token = getAzureDevOpsToken();
  if (!token) throw new Error("[AzureDevOps] No API token configured");
  return {
    // PATs authenticate as the Basic auth password with an empty username.
    Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function pullRequestBase(ref: AzureDevOpsPullRequestRef): string {
  return (
    `${ref.orgUrl}/${encodeURIComponent(ref.projectId)}/_apis/git/repositories/` +
    `${encodeURIComponent(ref.repositoryId)}/pullRequests/${ref.pullRequestId}`
  );
}

interface BotIdentity {
  id: string | null;
  uniqueName: string | null;
}

/** A transient failure resolving the bot identity; the caller should let the delivery be retried. */
export class AzureDevOpsLookupError extends Error {}

let cachedBotIdentity: { orgUrl: string; identity: BotIdentity } | null = null;

/** Org URL to query, or null when there is none or it is not safe to send the PAT to. */
function credentialedOrgUrl(orgBaseUrl: string | null | undefined): string | null {
  const orgUrl = normalizeOrgUrl(orgBaseUrl) ?? getAzureDevOpsOrgUrl();
  if (!orgUrl || !getAzureDevOpsToken()) return null;
  if (!isTrustedOrgUrl(orgUrl)) {
    console.error("[AzureDevOps] Refusing to send credentials to an untrusted organization URL");
    return null;
  }
  return orgUrl;
}

/**
 * `_apis/connectionData` of the identity that owns the PAT, cached per org.
 * Throws AzureDevOpsLookupError on a failed request. Redirects are refused so
 * the PAT never follows a response to another host.
 */
async function loadBotIdentity(orgUrl: string): Promise<BotIdentity> {
  if (cachedBotIdentity?.orgUrl === orgUrl) return cachedBotIdentity.identity;
  let data: {
    authenticatedUser?: { id?: string; properties?: { Account?: { $value?: string } } };
  };
  try {
    const resp = await fetch(`${orgUrl}/_apis/connectionData`, {
      headers: headers(),
      redirect: "error",
    });
    if (!resp.ok) throw new AzureDevOpsLookupError(`connectionData returned ${resp.status}`);
    data = (await resp.json()) as typeof data;
  } catch (err) {
    if (err instanceof AzureDevOpsLookupError) throw err;
    throw new AzureDevOpsLookupError(`connectionData request failed: ${String(err)}`);
  }
  const identity = {
    id: data.authenticatedUser?.id ?? null,
    uniqueName: data.authenticatedUser?.properties?.Account?.$value?.trim() || null,
  };
  if (identity.id || identity.uniqueName) cachedBotIdentity = { orgUrl, identity };
  return identity;
}

/**
 * Identity GUID of the bot. A picker @mention is stored as `@<GUID>` in the
 * comment body, so this is what mention detection matches. Uses
 * AZURE_DEVOPS_BOT_ID when set, otherwise the identity that owns the PAT
 * (`_apis/connectionData`), cached per org. Returns null when neither is
 * available; callers then fall back to plain-text `@name` matching.
 */
export async function resolveAzureDevOpsBotId(
  orgBaseUrl: string | null | undefined,
): Promise<string | null> {
  const fromEnv = process.env.AZURE_DEVOPS_BOT_ID?.trim();
  if (fromEnv) return fromEnv;
  const orgUrl = credentialedOrgUrl(orgBaseUrl);
  if (!orgUrl) return null;
  try {
    return (await loadBotIdentity(orgUrl)).id;
  } catch (err) {
    console.error(`[AzureDevOps] Failed to resolve bot identity:`, err);
    return null;
  }
}

/**
 * Sign-in name (usually the email) of the identity that owns the PAT, from
 * `_apis/connectionData` (`authenticatedUser.properties.Account.$value`),
 * cached per org. Work-item payloads carry people as the string
 * `"Display Name <unique@name>"` with no GUID, so this is what identifies the
 * bot in `System.AssignedTo`. Returns null when it cannot be resolved.
 */
export async function resolveAzureDevOpsBotUniqueName(
  orgBaseUrl: string | null | undefined,
): Promise<string | null> {
  const orgUrl = credentialedOrgUrl(orgBaseUrl);
  if (!orgUrl) return null;
  try {
    return (await loadBotIdentity(orgUrl)).uniqueName;
  } catch (err) {
    console.error(`[AzureDevOps] Failed to resolve bot sign-in name:`, err);
    return null;
  }
}

/**
 * Both bot identifiers in one lookup, for work-item handlers. Unlike the
 * helpers above, a failed request throws AzureDevOpsLookupError instead of
 * degrading to null, so a transient outage makes the delivery retryable.
 */
export async function resolveAzureDevOpsBotIdentity(
  orgBaseUrl: string | null | undefined,
): Promise<BotIdentity> {
  const fromEnv = process.env.AZURE_DEVOPS_BOT_ID?.trim() || null;
  const orgUrl = credentialedOrgUrl(orgBaseUrl);
  if (!orgUrl) return { id: fromEnv, uniqueName: null };
  const identity = await loadBotIdentity(orgUrl);
  return { id: fromEnv ?? identity.id, uniqueName: identity.uniqueName };
}

/** Reset the cached bot identity (tests, config reloads). */
export function resetAzureDevOpsBotIdCache(): void {
  cachedBotIdentity = null;
}

/**
 * Like a pull request comment — the Azure DevOps analogue of the 👀 reaction
 * GitHub/GitLab get, since PR comments have no emoji reactions.
 * @see https://learn.microsoft.com/rest/api/azure/devops/git/pull-request-comment-likes/create
 */
export async function likeAzureDevOpsComment(
  ref: AzureDevOpsPullRequestRef,
  threadId: number,
  commentId: number,
): Promise<void> {
  const url = `${pullRequestBase(ref)}/threads/${threadId}/comments/${commentId}/likes?api-version=${API_VERSION}`;
  try {
    const resp = await fetch(url, { method: "POST", headers: headers() });
    if (!resp.ok) {
      console.error(`[AzureDevOps] Failed to like comment: ${resp.status} ${await resp.text()}`);
    }
  } catch (err) {
    console.error(`[AzureDevOps] Error liking comment:`, err);
  }
}

/**
 * Post a comment on a pull request as a new thread.
 * @see https://learn.microsoft.com/rest/api/azure/devops/git/pull-request-threads/create
 */
export async function postAzureDevOpsPullRequestComment(
  ref: AzureDevOpsPullRequestRef,
  content: string,
): Promise<void> {
  const url = `${pullRequestBase(ref)}/threads?api-version=${API_VERSION}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        comments: [{ parentCommentId: 0, content, commentType: 1 }],
        status: 1, // active
      }),
    });
    if (!resp.ok) {
      console.error(`[AzureDevOps] Failed to post comment: ${resp.status} ${await resp.text()}`);
    }
  } catch (err) {
    console.error(`[AzureDevOps] Error posting comment:`, err);
  }
}
