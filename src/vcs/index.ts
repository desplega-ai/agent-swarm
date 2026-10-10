/**
 * VCS Provider utilities.
 */

import { isAzureDevOpsUrl } from "./azure-devops";
import type { VcsProvider } from "./types";

export type { VcsProvider } from "./types";

/**
 * Detect the VCS provider for a repo URL string.
 * Returns null for unrecognised URLs.
 */
export function detectVcsProvider(url: string): VcsProvider | null {
  if (isAzureDevOpsUrl(url)) return "azure-devops";
  if (url.includes("gitlab.com") || url.includes("gitlab.")) return "gitlab";
  if (url.includes("github.com") || /^[\w.-]+\/[\w.-]+$/.test(url)) return "github";
  return null;
}
