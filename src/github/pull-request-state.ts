import { githubApiUrl } from "../utils/github-host";
import { getWorkerInstallationToken } from "./app";

export type PullRequestState = { merged: boolean; state: "open" | "closed" };

/**
 * Read one PR from GitHub. A webhook only names a candidate; callers that wake
 * an agent confirm here first. Sends the App installation token when one is
 * configured, otherwise reads unauthenticated (enough for a public repo).
 * Throws on any non-2xx so a failed read never counts as an answer.
 */
export async function fetchPullRequestState(
  repo: string,
  number: number,
): Promise<PullRequestState> {
  const auth = await getWorkerInstallationToken();
  const response = await fetch(githubApiUrl(`/repos/${repo}/pulls/${number}`), {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(auth.status === "ok" ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${repo}#${number}`);
  const pr = (await response.json()) as {
    merged?: boolean;
    state?: string;
  };
  return {
    merged: pr.merged === true,
    state: pr.state === "open" ? "open" : "closed",
  };
}
