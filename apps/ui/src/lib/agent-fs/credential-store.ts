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

export function readCredential(
  apiUrl: string,
  endpoint: string,
  storage: CredentialStorage | null = browserStorage(),
): AgentFsCredential | null {
  try {
    return parseCredential(storage?.getItem(credentialStorageKey(apiUrl, endpoint)) ?? null);
  } catch {
    return null;
  }
}

export function writeCredential(
  apiUrl: string,
  endpoint: string,
  credential: AgentFsCredential,
  storage: CredentialStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(credentialStorageKey(apiUrl, endpoint), JSON.stringify(credential));
  } catch {
    // Storage unavailable (privacy mode): the credential lasts for this page only.
  }
}

export function clearCredential(
  apiUrl: string,
  endpoint: string,
  storage: CredentialStorage | null = browserStorage(),
): void {
  try {
    storage?.removeItem(credentialStorageKey(apiUrl, endpoint));
  } catch {
    // Nothing stored.
  }
}

/**
 * Call `onChange` when another tab writes or clears this credential. The
 * `storage` event never fires in the tab that made the change.
 */
export function subscribeCredential(
  apiUrl: string,
  endpoint: string,
  onChange: (credential: AgentFsCredential | null) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const key = credentialStorageKey(apiUrl, endpoint);
  const handler = (event: StorageEvent) => {
    // `key === null` means another tab called `localStorage.clear()`.
    if (event.key !== null && event.key !== key) return;
    onChange(readCredential(apiUrl, endpoint));
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
