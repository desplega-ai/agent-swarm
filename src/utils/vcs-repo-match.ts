/**
 * How a task's `vcsRepo` names a registered repo (`swarm_repos`). The worker
 * loads that repo's scoped config with it (`fetchRepoConfig`), and the API
 * reads the same repo at claim, so both sides must match the same way.
 */

/** `vcsRepo` without surrounding spaces, trailing slashes or `.git`. */
export function normalizeVcsRepo(vcsRepo: string): string {
  return vcsRepo
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/** The `swarm_repos.name` candidates are looked up by: the last path segment. */
export function vcsRepoName(vcsRepo: string): string {
  const requested = normalizeVcsRepo(vcsRepo);
  return requested.split("/").pop() || requested;
}

/** Whether a registered repo URL is exactly the repo `vcsRepo` names. */
export function vcsRepoUrlMatches(url: string, vcsRepo: string): boolean {
  const requested = normalizeVcsRepo(vcsRepo);
  const normalized = normalizeVcsRepo(url);
  if (normalized === requested) return true;
  // Qualified URLs must retain their host. Only shorthand references use suffix matching.
  if (requested.includes(":")) return false;
  return normalized.endsWith(`/${requested}`) || normalized.endsWith(`:${requested}`);
}
