import type { IncomingMessage, ServerResponse } from "node:http";
import { getAgentById } from "../be/db";
import type { RbacPrincipal } from "../rbac";
import {
  authUser,
  authUserId,
  getRequestAuth,
  type HttpRequestAuth,
  isOperatorAuth,
} from "../utils/request-auth-context";
import { jsonError } from "./utils";

export { authUser, authUserId, isOperatorAuth };

function assertNever(value: never): never {
  throw new Error(`Unhandled request auth kind: ${JSON.stringify(value)}`);
}

export type ResolvePrincipalOptions = {
  /**
   * Whether an `operator` bearer wins over `myAgentId` ("operator-first") or
   * a supplied `myAgentId` acts as that agent on top of the shared key ("agent-first").
   */
  precedence?: "operator-first" | "agent-first";
  /**
   * Fallback principal when `getRequestAuth(req)` is null (e.g. direct handler unit tests)
   * and no agent id is present.
   */
  unauthenticatedFallback?: "operator" | "anonymous-agent" | null;
  /**
   * When true, an agent id that is not registered in `agents` resolves to `null`
   * instead of `{ kind: "agent", agentId, isLead: false }`.
   */
  requireRegisteredAgent?: boolean;
};

async function resolveAgentPrincipal(
  agentId: string | undefined,
  fallback: "operator" | "anonymous-agent" | null,
  requireRegisteredAgent: boolean,
): Promise<RbacPrincipal | null> {
  if (!agentId) {
    if (fallback === "operator") return { kind: "operator" };
    if (fallback === "anonymous-agent") return { kind: "agent", agentId: "", isLead: false };
    return null;
  }
  const agent = await getAgentById(agentId);
  if (requireRegisteredAgent && !agent) return null;
  return { kind: "agent", agentId, isLead: agent?.isLead === true };
}

/**
 * Central resolver mapping `HttpRequestAuth` + `X-Agent-ID` to an `RbacPrincipal`
 * via an exhaustive `switch (auth.kind)`. Adding a new variant to `HttpRequestAuth`
 * is a compile error here until handled.
 */
export async function resolveRequestPrincipal(
  req: IncomingMessage,
  myAgentId: string | undefined,
  options?: ResolvePrincipalOptions,
): Promise<RbacPrincipal | null> {
  const precedence = options?.precedence ?? "operator-first";
  const fallback = options?.unauthenticatedFallback ?? null;
  const requireRegisteredAgent = options?.requireRegisteredAgent ?? false;
  const auth = getRequestAuth(req);
  if (!auth) {
    return resolveAgentPrincipal(myAgentId, fallback, requireRegisteredAgent);
  }
  switch (auth.kind) {
    case "operator":
      if (precedence === "agent-first" && myAgentId) {
        return resolveAgentPrincipal(myAgentId, "operator", requireRegisteredAgent);
      }
      return { kind: "operator" };
    case "user":
      return { kind: "user", userId: auth.userId };
    case "guest":
    case "controller":
      return { kind: "guest" };
    case "agent":
      return resolveAgentPrincipal(auth.agentId || myAgentId, fallback, requireRegisteredAgent);
    default:
      return assertNever(auth);
  }
}

/**
 * The RBAC principal of an HTTP request, for a handler-side `can()` check.
 * Operator and user request auth win over the X-Agent-ID header (an operator
 * bearer with any agent id stays the operator). An agent id that is not
 * registered is a non-lead agent (unless `requireRegisteredAgent` is set).
 * Null when the request has neither (unless `unauthenticatedFallback` is set).
 */
export async function requestPrincipal(
  req: IncomingMessage,
  myAgentId: string | undefined,
  options?: {
    unauthenticatedFallback: "operator" | "anonymous-agent";
    requireRegisteredAgent?: boolean;
  },
): Promise<RbacPrincipal>;
export async function requestPrincipal(
  req: IncomingMessage,
  myAgentId: string | undefined,
  options?: {
    unauthenticatedFallback?: "operator" | "anonymous-agent" | null;
    requireRegisteredAgent?: boolean;
  },
): Promise<RbacPrincipal | null>;
export async function requestPrincipal(
  req: IncomingMessage,
  myAgentId: string | undefined,
  options?: {
    unauthenticatedFallback?: "operator" | "anonymous-agent" | null;
    requireRegisteredAgent?: boolean;
  },
): Promise<RbacPrincipal | null> {
  return resolveRequestPrincipal(req, myAgentId, {
    precedence: "operator-first",
    unauthenticatedFallback: options?.unauthenticatedFallback ?? null,
    requireRegisteredAgent: options?.requireRegisteredAgent,
  });
}

/**
 * The principal of a keyed HTTP request that may act as an agent. Workers share the swarm API
 * key, so the key alone authenticates as the operator. An X-Agent-ID, or an `aseph_` session
 * token, names the agent on top of it, and its lead flag is read live. A user token stays the
 * user. A request with no agent identity is the operator, as for the dashboard and the runner.
 * Unlike `requestPrincipal`, an agent identity wins over the operator key.
 */
export async function agentFirstPrincipal(
  req: IncomingMessage,
  myAgentId: string | undefined,
  options?: { unauthenticatedFallback?: "operator" | "anonymous-agent" },
): Promise<RbacPrincipal> {
  return (await resolveRequestPrincipal(req, myAgentId, {
    precedence: "agent-first",
    unauthenticatedFallback: options?.unauthenticatedFallback ?? "operator",
  }))!;
}

/**
 * Require the request's `HttpRequestAuth` kind to be in `allowed`.
 * Writes a 403 and returns null when missing or not allowed; otherwise returns
 * the narrowed `HttpRequestAuth`.
 */
export function requireAuthKind<const K extends HttpRequestAuth["kind"]>(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly K[],
  message = "Forbidden",
): Extract<HttpRequestAuth, { kind: K }> | null {
  const auth = getRequestAuth(req);
  if (auth && (allowed as readonly string[]).includes(auth.kind)) {
    return auth as Extract<HttpRequestAuth, { kind: K }>;
  }
  jsonError(res, message, 403);
  return null;
}

/**
 * Refuse a guest page session on a handler that has no per-route guest rule.
 * Writes a 403 and returns true when the request is a guest's.
 */
export function rejectGuest(req: IncomingMessage, res: ServerResponse): boolean {
  if (getRequestAuth(req)?.kind !== "guest") return false;
  jsonError(res, "Forbidden", 403);
  return true;
}
