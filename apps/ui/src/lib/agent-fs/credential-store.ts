// The human's agent-fs credential for Comb. It lives only in this browser's
// localStorage and is never sent to the swarm API. The key is namespaced by
// the swarm API URL and the agent-fs URL, so two swarms (or two agent-fs
// servers) never share a credential.

import { deriveStorageKey } from "../../hooks/use-dismissible-card-key";

export interface AgentFsCredential {
  apiKey: string;
  userId: string;
  email: string;
  displayName: string | null;
  /** ISO timestamp. */
  connectedAt: string;
}

type CredentialStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): CredentialStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function credentialStorageKey(apiUrl: string, endpoint: string): string {
  return deriveStorageKey(apiUrl, `comb:agent-fs:${endpoint}`);
}

function parseCredential(raw: string | null): AgentFsCredential | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AgentFsCredential> | null;
    if (
      !value ||
      typeof value.apiKey !== "string" ||
      value.apiKey.length === 0 ||
      typeof value.userId !== "string" ||
      typeof value.email !== "string" ||
      typeof value.connectedAt !== "string"
    ) {
      return null;
    }
    return {
      apiKey: value.apiKey,
      userId: value.userId,
      email: value.email,
      displayName: typeof value.displayName === "string" ? value.displayName : null,
      connectedAt: value.connectedAt,
    };
  } catch {
    return null;
  }
}

function readRaw(
  apiUrl: string,
  endpoint: string,
  storage: CredentialStorage | null,
): string | null {
  try {
    return storage?.getItem(credentialStorageKey(apiUrl, endpoint)) ?? null;
  } catch {
    return null;
  }
}

export function readCredential(
  apiUrl: string,
  endpoint: string,
  storage: CredentialStorage | null = browserStorage(),
): AgentFsCredential | null {
  return parseCredential(readRaw(apiUrl, endpoint, storage));
}

/**
 * A `getSnapshot` for `useSyncExternalStore`. It returns the same object until
 * the stored string changes.
 */
export function credentialSnapshot(
  apiUrl: string,
  endpoint: string,
  storage: CredentialStorage | null = browserStorage(),
): () => AgentFsCredential | null {
  let raw: string | null | undefined;
  let credential: AgentFsCredential | null = null;
  return () => {
    const next = readRaw(apiUrl, endpoint, storage);
    if (next !== raw) {
      raw = next;
      credential = parseCredential(next);
    }
    return credential;
  };
}

// The `storage` event never fires in the tab that made the change, so writes
// in this tab notify the subscribers directly.
const sameTabListeners = new Set<(storageKey: string) => void>();

function notifySameTab(storageKey: string): void {
  for (const listener of sameTabListeners) listener(storageKey);
}

export function writeCredential(
  apiUrl: string,
  endpoint: string,
  credential: AgentFsCredential,
  storage: CredentialStorage | null = browserStorage(),
): void {
  const key = credentialStorageKey(apiUrl, endpoint);
  try {
    storage?.setItem(key, JSON.stringify(credential));
  } catch {
    // Storage unavailable: nothing is saved (the dashboard needs localStorage).
    return;
  }
  notifySameTab(key);
}

export function clearCredential(
  apiUrl: string,
  endpoint: string,
  storage: CredentialStorage | null = browserStorage(),
): void {
  const key = credentialStorageKey(apiUrl, endpoint);
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing stored.
    return;
  }
  notifySameTab(key);
}

/**
 * Call `onChange` when this credential is written or cleared, in this tab or
 * in another one (`target` receives the other tabs' `storage` events).
 */
export function subscribeCredential(
  apiUrl: string,
  endpoint: string,
  onChange: () => void,
  target: EventTarget | null = typeof window === "undefined" ? null : window,
): () => void {
  const key = credentialStorageKey(apiUrl, endpoint);
  const onSameTab = (changed: string) => {
    if (changed === key) onChange();
  };
  const onStorage = (event: Event) => {
    // `key === null` means another tab called `localStorage.clear()`.
    const changed = (event as StorageEvent).key;
    if (changed === null || changed === key) onChange();
  };
  sameTabListeners.add(onSameTab);
  target?.addEventListener("storage", onStorage);
  return () => {
    sameTabListeners.delete(onSameTab);
    target?.removeEventListener("storage", onStorage);
  };
}
