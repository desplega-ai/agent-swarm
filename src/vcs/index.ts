/**
 * VCS Provider utilities.
 */

import { getGitHubLinkConfig, isGitHubUrl } from "../utils/github-host";
import { isAzureDevOpsUrl } from "./azure-devops";
import { isBitbucketUrl } from "./bitbucket";
import type { VcsProvider } from "./types";

export type { VcsProvider } from "./types";

/**
 * Detect the VCS provider for a repo URL string.
 * Returns null for unrecognised URLs.
 */
export function detectVcsProvider(url: string): VcsProvider | null {
  if (isAzureDevOpsUrl(url)) return "azure-devops";
  if (isBitbucketUrl(url)) return "bitbucket";
  // The configured GHES host wins even when its hostname starts with gitlab.
  if (getGitHubLinkConfig().enterprise && isGitHubUrl(url)) return "github";
  let hostname: string | undefined;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    // SCP-style SSH remotes: user@host:path.
    hostname = url
      .trim()
      .match(/^[^@/\s:]+@([^:/\s]+):/)?.[1]
      ?.toLowerCase();
  }
  if (hostname?.startsWith("gitlab.")) return "gitlab";
  if (url.includes("github.com") || /^[\w.-]+\/[\w.-]+$/.test(url)) return "github";
  return null;
}
