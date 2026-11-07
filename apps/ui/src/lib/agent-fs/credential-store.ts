// The human's agent-fs credential for Comb. It lives only in this browser's
// localStorage and is never sent to the swarm API. The key is namespaced by
// the swarm API URL, the agent-fs URL, and the dashboard user, so two swarms,
// two agent-fs servers, or two dashboard users never share a credential.
//
// Credentials saved before the user part existed sit under the key without
// it (the legacy key). The owner still reads one when its email matches the
// owner's email. A write or a clear for that owner removes it.

import { deriveStorageKey } from "../../hooks/use-dismissible-card-key";

export interface AgentFsCredential {
  apiKey: string;
  userId: string;
  email: string;
  displayName: string | null;
  /** ISO timestamp. */
  connectedAt: string;
  /**
   * Set for a key the dashboard minted for this browser (`POST /api/fs/keys`):
   * its agent-fs label and id. Absent for a pasted key.
   */
  label?: string;
  keyId?: string;
}

type CredentialStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): CredentialStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The dashboard user a credential belongs to. Null: a tab with no user (the legacy key). */
export interface CredentialOwner {
  userId: string;
  email: string | null;
}

export function credentialStorageKey(
  apiUrl: string,
  endpoint: string,
  owner: CredentialOwner | null = null,
): string {
  const base = deriveStorageKey(apiUrl, `comb:agent-fs:${endpoint}`);
  return owner ? `${base}:user:${owner.userId}` : base;
}

function ownsLegacy(owner: CredentialOwner, credential: AgentFsCredential | null): boolean {
  const email = owner.email?.trim().toLowerCase();
  return Boolean(email && credential && credential.email.trim().toLowerCase() === email);
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
      ...(typeof value.label === "string" ? { label: value.label } : {}),
      ...(typeof value.keyId === "string" ? { keyId: value.keyId } : {}),
    };
  } catch {
    return null;
  }
}

function getItem(storage: CredentialStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * The owner's stored string, else a legacy one that belongs to the owner. An
 * owned legacy string moves to the owner's key on its first read.
 */
function readRaw(
  apiUrl: string,
  endpoint: string,
  owner: CredentialOwner | null,
  storage: CredentialStorage | null,
): string | null {
  const own = getItem(storage, credentialStorageKey(apiUrl, endpoint, owner));
  if (own !== null || !owner) return own;
  const legacy = getItem(storage, credentialStorageKey(apiUrl, endpoint));
  if (legacy === null || !ownsLegacy(owner, parseCredential(legacy))) return null;
  try {
    storage?.setItem(credentialStorageKey(apiUrl, endpoint, owner), legacy);
    storage?.removeItem(credentialStorageKey(apiUrl, endpoint));
  } catch {
    // Storage unavailable: the legacy string still reads for its owner.
  }
  return legacy;
}

export function readCredential(
  apiUrl: string,
  endpoint: string,
  owner: CredentialOwner | null,
  storage: CredentialStorage | null = browserStorage(),
): AgentFsCredential | null {
  return parseCredential(readRaw(apiUrl, endpoint, owner, storage));
}

/**
 * A `getSnapshot` for `useSyncExternalStore`. It returns the same object until
 * the stored string changes.
 */
export function credentialSnapshot(
  apiUrl: string,
  endpoint: string,
  owner: CredentialOwner | null,
  storage: CredentialStorage | null = browserStorage(),
): () => AgentFsCredential | null {
  let raw: string | null | undefined;
  let credential: AgentFsCredential | null = null;
  return () => {
    const next = readRaw(apiUrl, endpoint, owner, storage);
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

/** Remove the legacy credential when it belongs to `owner`, so it cannot come back. */
function dropOwnedLegacy(
  apiUrl: string,
  endpoint: string,
  owner: CredentialOwner | null,
  storage: CredentialStorage | null,
): void {
  if (!owner) return;
  const legacyKey = credentialStorageKey(apiUrl, endpoint);
  if (!ownsLegacy(owner, parseCredential(getItem(storage, legacyKey)))) return;
  try {
    storage?.removeItem(legacyKey);
  } catch {
    // Nothing stored.
  }
}

export function writeCredential(
  apiUrl: string,
  endpoint: string,
  owner: CredentialOwner | null,
  credential: AgentFsCredential,
  storage: CredentialStorage | null = browserStorage(),
): void {
  const key = credentialStorageKey(apiUrl, endpoint, owner);
  try {
    storage?.setItem(key, JSON.stringify(credential));
  } catch {
    // Storage unavailable: nothing is saved (the dashboard needs localStorage).
    return;
  }
  dropOwnedLegacy(apiUrl, endpoint, owner, storage);
  notifySameTab(key);
}

export function clearCredential(
  apiUrl: string,
  endpoint: string,
  owner: CredentialOwner | null,
  storage: CredentialStorage | null = browserStorage(),
): void {
  const key = credentialStorageKey(apiUrl, endpoint, owner);
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing stored.
    return;
  }
  dropOwnedLegacy(apiUrl, endpoint, owner, storage);
  notifySameTab(key);
}

/**
 * Call `onChange` when this credential is written or cleared, in this tab or
 * in another one (`target` receives the other tabs' `storage` events).
 */
export function subscribeCredential(
  apiUrl: string,
  endpoint: string,
  owner: CredentialOwner | null,
  onChange: () => void,
  target: EventTarget | null = typeof window === "undefined" ? null : window,
): () => void {
  // The owner's key, plus the legacy key it may still read.
  const keys = new Set([
    credentialStorageKey(apiUrl, endpoint, owner),
    credentialStorageKey(apiUrl, endpoint),
  ]);
  const onSameTab = (changed: string) => {
    if (keys.has(changed)) onChange();
  };
  const onStorage = (event: Event) => {
    // `key === null` means another tab called `localStorage.clear()`.
    const changed = (event as StorageEvent).key;
    if (changed === null || keys.has(changed)) onChange();
  };
  sameTabListeners.add(onSameTab);
  target?.addEventListener("storage", onStorage);
  return () => {
    sameTabListeners.delete(onSameTab);
    target?.removeEventListener("storage", onStorage);
  };
}
