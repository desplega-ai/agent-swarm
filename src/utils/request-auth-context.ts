import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import type { User } from "../types";

export type HttpRequestAuth =
  | { kind: "operator"; fingerprint: string }
  | { kind: "user"; userId: string; user: User };

/**
 * The ambient store holds a mutable slot, not the auth value itself.
 *
 * `enterWith` only mutates the CURRENT execution context, and resolving the
 * request's auth is asynchronous (it may read a user token from the DB). An
 * `enterWith` issued after that await lives in the resolver's own async frame
 * and never reaches the request pipeline that called it. Installing the slot
 * synchronously — before the first await of the request — and filling it in
 * afterwards keeps ambient reads (`getCurrentRequestUserId`, used for audit
 * columns deep in the DB layer) correct without threading `req` everywhere.
 */
type RequestAuthSlot = { auth: HttpRequestAuth | null };

const requestAuth = new WeakMap<IncomingMessage, HttpRequestAuth | null>();
const authStorage = new AsyncLocalStorage<RequestAuthSlot>();

/**
 * Install the per-request auth slot. MUST be called synchronously, before the
 * request pipeline's first `await`, so the slot propagates to everything the
 * request goes on to do.
 */
export function beginRequestAuthScope(): void {
  authStorage.enterWith({ auth: null });
}

export function setRequestAuth(req: IncomingMessage, auth: HttpRequestAuth | null): void {
  requestAuth.set(req, auth);
  const slot = authStorage.getStore();
  if (slot) slot.auth = auth;
  else authStorage.enterWith({ auth });
}

export function getRequestAuth(req: IncomingMessage): HttpRequestAuth | null {
  return requestAuth.get(req) ?? null;
}

export function getCurrentRequestAuth(): HttpRequestAuth | null {
  return authStorage.getStore()?.auth ?? null;
}

/**
 * Run `fn` outside any request-auth frame (AsyncLocalStorage.exit). Use this
 * around code that creates long-lived resources during a request — integration
 * clients, sockets, timers. Async resources created inside a request's frame
 * capture that request's slot for their whole lifetime, so their later DB
 * writes would be attributed to whichever user happened to trigger them.
 */
export function runWithoutRequestAuth<T>(fn: () => T): T {
  return authStorage.exit(fn);
}

export function getCurrentRequestUserId(): string | undefined {
  const auth = getCurrentRequestAuth();
  return auth?.kind === "user" ? auth.userId : undefined;
}
