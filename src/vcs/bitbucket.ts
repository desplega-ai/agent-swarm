/**
 * Bitbucket Cloud URL helpers. Pure functions, safe on both the API server and
 * the worker (no DB imports). Bitbucket Data Center is out of scope.
 */

/**
 * True when the URL's host is bitbucket.org. Only the host counts, so a
 * `bitbucket.org` path segment on another host (`gitlab.com/bitbucket.org/x`)
 * is not Bitbucket.
 */
export function isBitbucketUrl(url: string): boolean {
  const trimmed = url.trim();
  // SCP-style SSH: user@host:path
  const scp = trimmed.match(/^[^@/\s:]+@([^:/\s]+):/);
  if (scp) return (scp[1] as string).toLowerCase() === "bitbucket.org";
  try {
    return new URL(trimmed).hostname.toLowerCase() === "bitbucket.org";
  } catch {
    // Scheme-less `bitbucket.org/ws/repo`
    return /^bitbucket\.org(\/|$)/i.test(trimmed);
  }
}

/**
 * Split a Bitbucket Cloud remote into its workspace and repository slug.
 * Accepts the HTTPS forms (with or without a `user@` prefix, trailing `/` or
 * `.git`) and the SSH forms (`git@bitbucket.org:ws/repo.git`,
 * `ssh://git@bitbucket.org/ws/repo.git`). Returns null otherwise.
 */
export function parseBitbucketRepoUrl(url: string): { workspace: string; repoSlug: string } | null {
  const trimmed = url.trim();
  if (!isBitbucketUrl(trimmed)) return null;

  // SCP-style SSH: git@bitbucket.org:{workspace}/{repo}.git
  const scp = trimmed.match(/^[^@/\s]+@bitbucket\.org:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (scp) return { workspace: scp[1] as string, repoSlug: scp[2] as string };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "bitbucket.org") return null;
  const parts = parsed.pathname
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter(Boolean);
  const [workspace, repoSlug] = parts;
  if (!workspace || !repoSlug) return null;
  return { workspace: decodeURIComponent(workspace), repoSlug: decodeURIComponent(repoSlug) };
}

/** `workspace/repo_slug` for a Bitbucket Cloud remote, or null. */
export function bitbucketFullName(url: string): string | null {
  const parsed = parseBitbucketRepoUrl(url);
  return parsed ? `${parsed.workspace}/${parsed.repoSlug}` : null;
}
