// The dashboard's "All users" read scope. An admin (or a role holding
// `session.read.all`) opts in, and every request of this tab then carries
// `X-Swarm-Session-Scope: all`: the task list, the sessions shell, and the
// task and session pages a click opens. The server honors the header only
// for a user it lets read every session and ignores it for anyone else.
// It never lifts writes or steering.
//
// The choice is stored in this browser per API and per authenticated
// identity: the credential (a one-way hash of the key, since a user-bound
// `aswt_` token carries no picked user) plus the picked dashboard user. A
// switch to another token or user starts with the scope off. Off is the
// default: nothing outside the usual private-by-default view shows until the
// user turns it on.
//
// Every tab follows the stored choice: an opt-out in one tab turns the header
// off in all of them, and `bindAllUsersScopeCache` drops each tab's cached
// results on any change, so no tab keeps showing what the old scope fetched.
// A kept page (`placeholderData`) is not in the cache: a query observer
// remembers it on its own. Wrap it in `useWithinAllUsersScope` so a scope
// change drops it too.
//
// Relative imports only: the API client imports this module, and the root
// `bun test` run resolves no `@/` alias.

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { deriveStorageKey } from "../hooks/use-dismissible-card-key";
import { dashboardUserIdFor } from "./dashboard-user";
import { sha256Hex } from "./sha256";

/** Request header that opts a request into the all-users read scope. */
export const SESSION_SCOPE_HEADER = "X-Swarm-Session-Scope";

/** The first API version that honors the scope (and reports `sessionReadAll` on whoami). */
export const ALL_USERS_SCOPE_MIN_VERSION = "2.7.8";

type Connection = { apiUrl: string; apiKey: string };

const KEY_MARKER = "all-users-scope:";

const listeners = new Set<() => void>();
// Used only while localStorage is unavailable. With storage, the stored value
// is the only truth, so another tab's opt-out is never masked by this tab's
// earlier opt-in.
const memory = new Map<string, boolean>();

// Every request and render reads the key, so the hash of the last key is kept.
let lastCredential: { apiKey: string; id: string } | null = null;

function credentialId(apiKey: string): string {
  if (lastCredential?.apiKey !== apiKey) {
    lastCredential = { apiKey, id: sha256Hex(apiKey).slice(0, 32) };
  }
  return lastCredential.id;
}

/** The authenticated identity of `config`: a one-way credential id plus the picked user. */
export function allUsersScopeIdentity(config: Connection): string {
  return `${credentialId(config.apiKey)}:${dashboardUserIdFor(config) ?? ""}`;
}

export function allUsersScopeKey(config: Connection): string {
  return scopeKey(config, dashboardUserIdFor(config));
}

function scopeKey(config: Connection, userId: string | null): string {
  return deriveStorageKey(
    config.apiUrl,
    `${KEY_MARKER}${credentialId(config.apiKey)}:${userId ?? ""}`,
  );
}

/** Whether this browser opted in, for the configured API and identity. */
export function allUsersScopeEnabled(config: Connection): boolean {
  return storedOn(allUsersScopeKey(config));
}

function storedOn(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return memory.get(key) ?? false;
  }
}

export function setAllUsersScope(config: Connection, on: boolean) {
  const key = allUsersScopeKey(config);
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
    memory.delete(key);
  } catch {
    // Storage unavailable: keep the choice for this tab only.
    memory.set(key, on);
  }
  notify();
}

const cacheResets = new Set<() => void>();
// Moved on every scope change, before any listener runs.
let epoch = 0;
let changedAt = 0;
let kept = new WeakMap<object, unknown>();

function notify() {
  epoch++;
  changedAt = Date.now();
  kept = new WeakMap();
  // Caches first: a re-render a listener schedules must find them dropped.
  for (const reset of [...cacheResets]) reset();
  for (const listener of [...listeners]) listener();
}

/**
 * A switch of the picked dashboard user moves the tab to another identity's
 * stored choice. When either identity had the scope on, it counts as a scope
 * change here and in no other tab: caches and kept pages drop.
 */
export function noteAllUsersScopeUserSwitch(
  config: Connection,
  from: string | null,
  to: string | null,
) {
  if (storedOn(scopeKey(config, from)) || storedOn(scopeKey(config, to))) notify();
}

/** The parts of the previous query a `placeholderData` function may read. */
type PreviousQuery = { queryKey: QueryKey; state: { dataUpdatedAt: number } };
type Placeholder<T> = (
  previous: T | undefined,
  previousQuery: PreviousQuery | undefined,
) => T | undefined;

/**
 * `placeholderData` that never outlives a scope change. A query observer
 * keeps showing the placeholder it computed last for as long as its
 * `placeholderData` option stays the same function, even after
 * `resetQueries`, and a reset of a query that is still loading changes
 * nothing it would re-render for. This returns a new wrapper after each
 * change, so the next render computes the placeholder again, and it keeps
 * only data fetched after the change (a page garbage-collected before the
 * reset still holds the old scope's rows). The same wrapper comes back
 * between changes, so a placeholder is computed once per key switch, as
 * with `keepPreviousData`. Call it during a render that
 * `useAllUsersScopeChanges` subscribes; `useWithinAllUsersScope` does both.
 */
export function withinAllUsersScope<T>(placeholder: Placeholder<T>): Placeholder<T> {
  const existing = kept.get(placeholder) as Placeholder<T> | undefined;
  if (existing) return existing;
  const since = changedAt;
  const wrapped: Placeholder<T> = (previous, previousQuery) =>
    previousQuery && previousQuery.state.dataUpdatedAt > since
      ? placeholder(previous, previousQuery)
      : undefined;
  kept.set(placeholder, wrapped);
  return wrapped;
}

// Another tab changed a scope choice (or cleared storage).
function onStorage(event: StorageEvent) {
  if (event.key === null || event.key.includes(KEY_MARKER)) notify();
}

/**
 * Calls `listener` when a scope choice changes in this tab or another one.
 * Returns the unsubscribe.
 */
export function subscribeAllUsersScope(listener: () => void): () => void {
  // No `window` where a hook renders without a DOM (react-test-renderer).
  const tabs = typeof window === "undefined" ? null : window;
  listeners.add(listener);
  if (listeners.size === 1) tabs?.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) tabs?.removeEventListener("storage", onStorage);
  };
}

/** Re-renders the caller on every scope change, in this tab or another. */
export function useAllUsersScopeChanges(): number {
  return useSyncExternalStore(
    subscribeAllUsersScope,
    () => epoch,
    () => 0,
  );
}

/** `withinAllUsersScope(placeholder)`, re-rendered on every scope change. */
export function useWithinAllUsersScope<T>(placeholder: Placeholder<T>): Placeholder<T> {
  useAllUsersScopeChanges();
  return withinAllUsersScope(placeholder);
}

/**
 * Drops `queryClient`'s cached results whenever the scope changes, in this
 * tab or another: active queries refetch under the new scope, inactive ones
 * refetch on their next mount instead of showing the old scope's rows.
 * whoami is kept: it does not depend on the scope, and resetting it would
 * hide the toggle while it refetches.
 */
export function bindAllUsersScopeCache(queryClient: QueryClient): () => void {
  const reset = () => {
    void queryClient.resetQueries({ predicate: (query) => query.queryKey[0] !== "whoami" });
  };
  cacheResets.add(reset);
  // Keeps the `storage` listener on for another tab's change.
  const unsubscribe = subscribeAllUsersScope(() => {});
  return () => {
    cacheResets.delete(reset);
    unsubscribe();
  };
}

/** The stored opt-in for `config`, re-rendered on a change in this or another tab. */
export function useStoredAllUsersScope(config: Connection): boolean {
  return useSyncExternalStore(
    subscribeAllUsersScope,
    () => allUsersScopeEnabled(config),
    () => false,
  );
}
