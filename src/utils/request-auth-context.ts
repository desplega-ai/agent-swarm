import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import type { User } from "../types";

export type HttpRequestAuth =
  | { kind: "operator"; fingerprint: string }
  | { kind: "user"; userId: string; user: User };

const requestAuth = new WeakMap<IncomingMessage, HttpRequestAuth | null>();
const authStorage = new AsyncLocalStorage<HttpRequestAuth | null>();

export function setRequestAuth(req: IncomingMessage, auth: HttpRequestAuth | null): void {
  requestAuth.set(req, auth);
  authStorage.enterWith(auth);
}

export function getRequestAuth(req: IncomingMessage): HttpRequestAuth | null {
  return requestAuth.get(req) ?? null;
}

export function getCurrentRequestAuth(): HttpRequestAuth | null {
  return authStorage.getStore() ?? null;
}

export function getCurrentRequestUserId(): string | undefined {
  const auth = getCurrentRequestAuth();
  return auth?.kind === "user" ? auth.userId : undefined;
}
