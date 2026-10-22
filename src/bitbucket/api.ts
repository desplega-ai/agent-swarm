/**
 * Bitbucket Cloud REST interactions — resolving the bot identity behind the
 * token and posting pull request comments. Uses raw fetch, no SDK.
 */

import { scrubSecrets } from "../utils/secret-scrubber";
import { getBitbucketToken } from "./auth";

export const BITBUCKET_API = "https://api.bitbucket.org/2.0";

function headers(): Record<string, string> {
  const token = getBitbucketToken();
  if (!token) throw new Error("[Bitbucket] No API token configured");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

let cachedBotAccountId: string | null = null;

/**
 * Atlassian `account_id` of the bot. A picker @mention is stored as
 * `@{<account_id>}` in the comment's raw content, so this is what mention
 * detection matches. Uses BITBUCKET_BOT_ACCOUNT_ID when set, otherwise the
 * user that owns the token (`GET /2.0/user`), cached. Returns null when
 * neither is available; callers then fall back to plain-text `@name` matching.
 */
export async function resolveBitbucketBotAccountId(): Promise<string | null> {
  const fromEnv = process.env.BITBUCKET_BOT_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;
  if (cachedBotAccountId) return cachedBotAccountId;
  if (!getBitbucketToken()) return null;
  try {
    // Redirects are refused so the token never follows a response to another host.
    const resp = await fetch(`${BITBUCKET_API}/user`, { headers: headers(), redirect: "error" });
    if (!resp.ok) {
      console.error(`[Bitbucket] GET /user returned ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as { account_id?: string };
    cachedBotAccountId = data.account_id?.trim() || null;
    return cachedBotAccountId;
  } catch (err) {
    console.error(`[Bitbucket] Failed to resolve bot identity: ${scrubSecrets(String(err))}`);
    return null;
  }
}

/** Reset the cached bot identity (tests, config reloads). */
export function resetBitbucketBotCache(): void {
  cachedBotAccountId = null;
}

/** Post a comment on a pull request. `fullName` is `<workspace>/<repo_slug>`. */
export async function postBitbucketPullRequestComment(
  fullName: string,
  pullRequestId: number,
  raw: string,
): Promise<void> {
  const [workspace, repoSlug] = fullName.split("/");
  if (!workspace || !repoSlug) throw new Error(`[Bitbucket] Invalid repository: ${fullName}`);
  const url =
    `${BITBUCKET_API}/repositories/${encodeURIComponent(workspace)}/` +
    `${encodeURIComponent(repoSlug)}/pullrequests/${pullRequestId}/comments`;
  const resp = await fetch(url, {
    method: "POST",
    headers: headers(),
    redirect: "error",
    body: JSON.stringify({ content: { raw } }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      scrubSecrets(
        `[Bitbucket] Comment on ${fullName}#${pullRequestId} failed: ${resp.status} ${text}`,
      ),
    );
  }
}
