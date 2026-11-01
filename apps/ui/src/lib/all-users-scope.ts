// The dashboard's "All users" read scope. An admin (or a role holding
// `session.read.all`) opts in, and every request of this tab then carries
// `X-Swarm-Session-Scope: all`: the task list, the sessions shell, and the
// task and session pages a click opens. The server honors the header only
// for a user it lets read every session and ignores it for anyone else.
// It never lifts writes or steering.
//
// The choice is stored in this browser per API and per picked user, so a
// switch to another identity starts with the scope off. Off is the default:
// nothing outside the usual private-by-default view shows until the user
// turns it on.
//
// Relative imports only: the API client imports this module, and the root
// `bun test` run resolves no `@/` alias.

import { useSyncExternalStore } from "react";
import { deriveStorageKey } from "../hooks/use-dismissible-card-key";
import { dashboardUserIdFor } from "./dashboard-user";

/** Request header that opts a request into the all-users read scope. */
export const SESSION_SCOPE_HEADER = "X-Swarm-Session-Scope";

/** The first API version that honors the scope (and reports `sessionReadAll` on whoami). */
export const ALL_USERS_SCOPE_MIN_VERSION = "2.7.8";

type Connection = { apiUrl: string; apiKey: string };

const listeners = new Set<() => void>();
const memory = new Map<string, boolean>();

export function allUsersScopeKey(config: Connection): string {
  const userId = dashboardUserIdFor(config) ?? "token";
  return deriveStorageKey(config.apiUrl, `all-users-scope:${userId}`);
}

/** Whether this tab opted in, for the configured API and picked user. */
export function allUsersScopeEnabled(config: Connection): boolean {
  const key = allUsersScopeKey(config);
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) return stored === "1";
  } catch {
    // Storage unavailable: fall back to the in-memory value.
  }
  return memory.get(key) ?? false;
}

export function setAllUsersScope(config: Connection, on: boolean) {
  const key = allUsersScopeKey(config);
  memory.set(key, on);
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable: the in-memory value still changes.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** The stored opt-in for `config`, re-rendered on a change in this or another tab. */
export function useStoredAllUsersScope(config: Connection): boolean {
  return useSyncExternalStore(
    subscribe,
    () => allUsersScopeEnabled(config),
    () => false,
  );
}
