import { useSyncExternalStore } from "react";

/**
 * "Later" on the org-name dialog, per API connection and browser session.
 *
 * The dialog and the bell share it so only one of them asks for the name at
 * a time: the dialog asks on Home until Later, then the bell item takes over.
 */
const deferredInMemory = new Set<string>();
const listeners = new Set<() => void>();

function laterKey(apiUrl: string): string {
  return `swarm:org-name-prompt:later:v1:${apiUrl}`;
}

export function isOrgNamePromptDeferred(apiUrl: string): boolean {
  if (deferredInMemory.has(apiUrl)) return true;
  try {
    return sessionStorage.getItem(laterKey(apiUrl)) !== null;
  } catch {
    return false;
  }
}

export function deferOrgNamePrompt(apiUrl: string): void {
  try {
    sessionStorage.setItem(laterKey(apiUrl), "1");
  } catch {
    // Without browser storage, Later holds for this page load.
    deferredInMemory.add(apiUrl);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOrgNamePromptDeferred(apiUrl: string): boolean {
  return useSyncExternalStore(subscribe, () => isOrgNamePromptDeferred(apiUrl));
}
