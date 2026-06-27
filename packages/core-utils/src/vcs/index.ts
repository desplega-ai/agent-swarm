/**
 * VCS Provider utilities.
 */

export type { VcsProvider } from "./types";

/**
 * Detect the VCS provider for a repo URL string.
 * Returns null for unrecognised URLs.
 */
export function detectVcsProvider(url: string): "github" | "gitlab" | null {
  if (url.includes("gitlab.com") || url.includes("gitlab.")) return "gitlab";
  if (url.includes("github.com") || /^[\w.-]+\/[\w.-]+$/.test(url)) return "github";
  return null;
}
