export interface GitHubPullRequestUrl {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

const CANDIDATE_TOKEN_RE = /[^\s()[\]{}<>"'`]+/g;
const TRAILING_PROSE_PUNCTUATION_RE = /[)\]},.;:!]+$/;
const GITHUB_PATH_SEGMENT_RE = /^[\w.-]+$/;

function parseGitHubPullRequestToken(token: string): GitHubPullRequestUrl | null {
  const candidate = token.replace(TRAILING_PROSE_PUNCTUATION_RE, "");
  const lowerCandidate = candidate.toLowerCase();
  if (
    !lowerCandidate.startsWith("https://github.com/") &&
    !lowerCandidate.startsWith("http://github.com/") &&
    !lowerCandidate.startsWith("github.com/")
  ) {
    return null;
  }
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (
    parsed.host.toLowerCase() !== "github.com" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return null;
  }

  const [owner, repo, pull, numberText] = parsed.pathname.split("/").filter(Boolean);
  if (
    !owner ||
    !repo ||
    pull?.toLowerCase() !== "pull" ||
    !numberText ||
    !GITHUB_PATH_SEGMENT_RE.test(owner) ||
    !GITHUB_PATH_SEGMENT_RE.test(repo) ||
    !/^\d+$/.test(numberText)
  ) {
    return null;
  }

  return {
    url: `https://github.com/${owner}/${repo}/pull/${numberText}`,
    owner,
    repo,
    number: Number(numberText),
  };
}

/** Extract distinct canonical GitHub pull-request URLs from free text. */
export function extractGitHubPullRequestUrls(
  text: string | null | undefined,
): GitHubPullRequestUrl[] {
  if (!text) return [];

  const results: GitHubPullRequestUrl[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CANDIDATE_TOKEN_RE)) {
    const pullRequest = parseGitHubPullRequestToken(match[0]);
    if (!pullRequest) continue;
    const dedupeKey = pullRequest.url.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    results.push(pullRequest);
  }
  return results;
}
