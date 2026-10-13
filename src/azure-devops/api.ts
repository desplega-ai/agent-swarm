/**
 * Azure DevOps REST interactions — comment likes (the 👀 ack), PR comments,
 * and resolving the bot identity behind the PAT. Uses raw fetch, no SDK.
 */

import { getAzureDevOpsOrgUrl, getAzureDevOpsToken, normalizeOrgUrl } from "./auth";

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

let cachedBotId: { orgUrl: string; id: string } | null = null;

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

  const orgUrl = normalizeOrgUrl(orgBaseUrl) ?? getAzureDevOpsOrgUrl();
  if (!orgUrl || !getAzureDevOpsToken()) return null;
  if (cachedBotId?.orgUrl === orgUrl) return cachedBotId.id;

  try {
    const resp = await fetch(`${orgUrl}/_apis/connectionData`, { headers: headers() });
    if (!resp.ok) {
      console.error(`[AzureDevOps] Failed to resolve bot identity: ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as { authenticatedUser?: { id?: string } };
    const id = data.authenticatedUser?.id;
    if (!id) return null;
    cachedBotId = { orgUrl, id };
    return id;
  } catch (err) {
    console.error(`[AzureDevOps] Error resolving bot identity:`, err);
    return null;
  }
}

let cachedBotUniqueName: { orgUrl: string; uniqueName: string } | null = null;

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
  const orgUrl = normalizeOrgUrl(orgBaseUrl) ?? getAzureDevOpsOrgUrl();
  if (!orgUrl || !getAzureDevOpsToken()) return null;
  if (cachedBotUniqueName?.orgUrl === orgUrl) return cachedBotUniqueName.uniqueName;

  try {
    const resp = await fetch(`${orgUrl}/_apis/connectionData`, { headers: headers() });
    if (!resp.ok) {
      console.error(`[AzureDevOps] Failed to resolve bot sign-in name: ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as {
      authenticatedUser?: { properties?: { Account?: { $value?: string } } };
    };
    const uniqueName = data.authenticatedUser?.properties?.Account?.$value?.trim();
    if (!uniqueName) return null;
    cachedBotUniqueName = { orgUrl, uniqueName };
    return uniqueName;
  } catch (err) {
    console.error(`[AzureDevOps] Error resolving bot sign-in name:`, err);
    return null;
  }
}

/** Reset the cached bot identity (tests, config reloads). */
export function resetAzureDevOpsBotIdCache(): void {
  cachedBotId = null;
  cachedBotUniqueName = null;
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
