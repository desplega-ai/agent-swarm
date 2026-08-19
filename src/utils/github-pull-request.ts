export interface GitHubPullRequestUrl {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

const GITHUB_PULL_REQUEST_URL_RE =
  /(?<![\w.-])(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?=$|[/?#\s)\]}>"'`,.;:!])/gi;

/** Extract distinct canonical GitHub pull-request URLs from free text. */
export function extractGitHubPullRequestUrls(
  text: string | null | undefined,
): GitHubPullRequestUrl[] {
  if (!text) return [];

  const results: GitHubPullRequestUrl[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(GITHUB_PULL_REQUEST_URL_RE)) {
    const owner = match[1];
    const repo = match[2];
    const numberText = match[3];
    if (!owner || !repo || !numberText) continue;

    const url = `https://github.com/${owner}/${repo}/pull/${numberText}`;
    const dedupeKey = url.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    results.push({ url, owner, repo, number: Number(numberText) });
  }
  return results;
}
