import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import type { User } from "../types";

export type HttpRequestAuth = (
  | { kind: "operator"; fingerprint: string }
  /**
   * `tokenId` is the `user_tokens` row the request authenticated with, unset
   * for a page session. Credential and identity writes recheck it in their
   * write transaction (`assertMayActOnOperatorGrantedTarget`).
   */
  | { kind: "user"; userId: string; user: User; tokenId?: string }
  /** Password-page viewer with no user identity. Least privilege: every gate denies it. */
  | { kind: "guest" }
  | { kind: "controller"; controllerId: string; tokenId: string; expiresAt: string }
  /** Session token bound to an ACP task, a worker runtime, or only its agent (aseph_ prefix). */
  | {
      kind: "agent";
      tokenKind: "task" | "runtime" | "agent";
      agentId: string;
      taskId: string | null;
      runtimeId: string | null;
      tokenId: string;
      expiresAt: string;
      /**
       * Set on a script run's per-run token (`mintScriptRunToken`): the
       * swarm-script workflow step that started the run, and the run's own
       * `script_runs` row. Rows the request creates are stamped with them.
       */
      sourceTaskId?: string | null;
      sourceStepId?: string | null;
      sourceScriptRunId?: string | null;
    }
) & {
  /** Verified page context for agent-scoped operations. This does not identify the viewer. */
  page?: { id: string; executionAgentId: string };
};

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

export function authUserId(auth: HttpRequestAuth | null | undefined): string | undefined {
  return auth?.kind === "user" ? auth.userId : undefined;
}

export function authUser(auth: HttpRequestAuth | null | undefined): User | undefined {
  return auth?.kind === "user" ? auth.user : undefined;
}

export function isOperatorAuth(
  auth: HttpRequestAuth | null | undefined,
): auth is Extract<HttpRequestAuth, { kind: "operator" }> {
  return auth?.kind === "operator";
}

export function getCurrentRequestUserId(): string | undefined {
  return authUserId(getCurrentRequestAuth());
}

/** Where the current request's script run came from, when it presents a script-run token. */
export type RunProvenance = { sourceStepId: string | null; sourceScriptRunId: string | null };

/**
 * Provenance of the current request: set only when it authenticated with a
 * script run's per-run token that recorded a step or a script run. Async work
 * started inside the request inherits it (the workflow engine continuing a run
 * it triggered), so callers stamp only rows a script can create directly.
 */
export function getCurrentRunProvenance(): RunProvenance | null {
  const auth = getCurrentRequestAuth();
  if (auth?.kind !== "agent") return null;
  const sourceStepId = auth.sourceStepId ?? null;
  const sourceScriptRunId = auth.sourceScriptRunId ?? null;
  return sourceStepId || sourceScriptRunId ? { sourceStepId, sourceScriptRunId } : null;
}
