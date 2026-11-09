/**
 * VCS Provider utilities.
 */

import { getGitHubLinkConfig, isGitHubUrl } from "../utils/github-host";
import { isAzureDevOpsUrl } from "./azure-devops";
import { isBitbucketUrl } from "./bitbucket";
import type { VcsProvider } from "./types";

export type { VcsProvider } from "./types";

/** Host of a repo URL (`https://host/...`, `ssh://git@host/...`, `git@host:path` or a bare `host/...`), lower-cased. */
function repoHost(url: string): string | null {
  const scp = url.match(/^[^@/\s]+@([^:/\s]+):/);
  if (scp) return scp[1]!.toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    const bare = url.match(/^([\w-]+(?:\.[\w-]+)+)\//);
    return bare ? bare[1]!.toLowerCase() : null;
  }
}

/**
 * Detect the VCS provider for a repo URL string.
 * Returns null for unrecognised URLs.
 */
export function detectVcsProvider(url: string): VcsProvider | null {
  if (isAzureDevOpsUrl(url)) return "azure-devops";
  if (isBitbucketUrl(url)) return "bitbucket";
  // The configured GHES host wins over the loose gitlab checks below.
  if (getGitHubLinkConfig().enterprise && isGitHubUrl(url)) return "github";
  // Only the host selects GitLab, so a GitHub repo named `gitlab.client` stays GitHub.
  const host = repoHost(url);
  if (host === "gitlab.com" || host?.startsWith("gitlab.")) return "gitlab";
  if (host === "github.com" || url.includes("github.com") || /^[\w.-]+\/[\w.-]+$/.test(url)) {
    return "github";
  }
  return null;
}
