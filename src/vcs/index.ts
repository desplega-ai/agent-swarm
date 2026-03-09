/**
 * VCS Provider Registry — look up adapters by provider name.
 */

import type { VcsAdapter, VcsProvider } from "./types";

export type { NormalizedEvent, VcsAdapter, VcsProvider } from "./types";

const adapters = new Map<VcsProvider, VcsAdapter>();

export function registerVcsAdapter(adapter: VcsAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function getVcsAdapter(provider: VcsProvider): VcsAdapter | undefined {
  return adapters.get(provider);
}

export function getEnabledAdapters(): VcsAdapter[] {
  return [...adapters.values()].filter((a) => a.isEnabled());
}

/**
 * Detect the VCS provider for a repo URL string.
 * Returns null for unrecognised URLs.
 */
export function detectVcsProvider(url: string): VcsProvider | null {
  if (url.includes("gitlab.com") || url.includes("gitlab.")) return "gitlab";
  if (url.includes("github.com") || /^[\w.-]+\/[\w.-]+$/.test(url)) return "github";
  return null;
}
