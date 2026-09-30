import type { IncomingMessage } from "node:http";
import { getAgentById, getTaskById } from "../be/db";
import { getUserGrant } from "../be/rbac-roles";
import { mcpOverflowAuthError } from "../kv-overflow";
import { reservedNamespaceError } from "../kv-reserved-namespaces";
import { can, isRbacEnabled } from "../rbac";
import { agentContextKey, pageContextKey } from "../tasks/context-key";
import type { HttpRequestAuth } from "../utils/request-auth-context";

export type RoomNamespaceInfo = {
  agentId?: string;
  sourceTaskId?: string;
  pageId?: string;
};

export type RoomAuthorizationInfo = RoomNamespaceInfo & {
  callOrigin?: "http" | "mcp" | "ws";
  userId?: string;
  isOperator?: boolean;
};

export type ResolvedRoomNamespace = {
  namespace: string;
  source: "page" | "explicit" | "task" | "agent";
};

export type RoomNamespaceOperation =
  | "join"
  | "leave"
  | "update"
  | "change"
  | "reset"
  | "presence"
  | "subscribe"
  | "unsubscribe"
  | "publish";

const COMB_PRESENCE_NAMESPACE = /^presence:comb:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/;
const COMB_PRESENCE_OPERATIONS = new Set<RoomNamespaceOperation>(["join", "leave", "presence"]);

function pageNamespace(pageId: string): string | null {
  try {
    return pageContextKey({ pageId });
  } catch {
    return null;
  }
}

export async function resolveRoomNamespace(
  explicit: string | undefined,
  info: RoomNamespaceInfo,
): Promise<ResolvedRoomNamespace | { error: string }> {
  if (info.pageId) {
    const namespace = pageNamespace(info.pageId);
    if (!namespace) return { error: "invalid page id" };
    return { namespace, source: "page" };
  }

  if (explicit) return { namespace: explicit, source: "explicit" };

  if (info.sourceTaskId) {
    const task = await getTaskById(info.sourceTaskId);
    if (task?.contextKey) return { namespace: task.contextKey, source: "task" };
    if (task?.agentId) {
      try {
        return { namespace: agentContextKey({ agentId: task.agentId }), source: "agent" };
      } catch {
        // Fall through to the caller agent.
      }
    }
  }

  if (info.agentId) {
    try {
      return { namespace: agentContextKey({ agentId: info.agentId }), source: "agent" };
    } catch {
      // Report the same useful error as other namespace resolvers.
    }
  }

  return { error: "namespace could not be resolved. Pass `namespace` or set X-Agent-ID." };
}

export function roomRequestInfo(
  req: IncomingMessage,
  auth?: HttpRequestAuth | null,
): RoomNamespaceInfo {
  const header = (name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    agentId: auth?.kind === "user" ? undefined : header("x-agent-id"),
    sourceTaskId: header("x-source-task-id"),
    pageId: header("x-page-id"),
  };
}

/** Return a denial message, or null when the room namespace is allowed. */
export async function authorizeRoomNamespace(
  namespace: string,
  info: RoomAuthorizationInfo,
  access: boolean | RoomNamespaceOperation,
): Promise<string | null> {
  const overflowError = mcpOverflowAuthError(namespace, info.agentId);
  if (overflowError) return overflowError;

  if (namespace.startsWith("presence:comb:")) {
    if (!COMB_PRESENCE_NAMESPACE.test(namespace)) {
      return "invalid Comb presence namespace";
    }
    if (info.pageId || info.agentId || (!info.isOperator && !info.userId)) {
      return "Comb presence requires dashboard authentication";
    }
    if (typeof access !== "string" || !COMB_PRESENCE_OPERATIONS.has(access)) {
      return "Comb presence rooms only allow join, leave, and presence";
    }

    const principal = info.isOperator
      ? ({ kind: "operator" } as const)
      : ({ kind: "user", userId: info.userId! } as const);
    if (
      !can({
        principal,
        verb: "comb.presence",
        resource: { kind: "kv-namespace", namespace },
        source: info.callOrigin === "mcp" ? "mcp" : "http",
      }).allow
    ) {
      return "Comb presence requires the comb.presence permission";
    }
    if (info.userId && isRbacEnabled()) {
      const grant = await getUserGrant(info.userId);
      if (!grant.grantsAll && !grant.verbs.has("comb.presence")) {
        return "Comb presence requires the comb.presence permission";
      }
    }
    return null;
  }

  const reservedError = reservedNamespaceError(namespace);
  if (reservedError) return reservedError;

  const write =
    typeof access === "boolean"
      ? access
      : ["update", "change", "reset", "presence", "publish"].includes(access);
  if (!write) return null;

  if (info.userId && !info.isOperator && isRbacEnabled()) {
    const grant = await getUserGrant(info.userId);
    if (!grant.grantsAll && !grant.verbs.has("kv.write.any")) {
      return "room writes require the kv.write.any permission";
    }
  }

  if (namespace.startsWith("task:page:")) {
    if (info.pageId) {
      const ownPage = pageNamespace(info.pageId);
      return ownPage === namespace ? null : "page room namespace does not match the page session";
    }
    // Bearer-authenticated agents may explicitly join a page room.
    return info.agentId ? null : "page room writes require an authenticated agent";
  }

  if (namespace.startsWith("task:agent:")) {
    if (!info.agentId) {
      return info.isOperator ? null : "agent room writes require an authenticated agent";
    }
    const agent = await getAgentById(info.agentId);
    const allowed = can({
      principal: { kind: "agent", agentId: info.agentId, isLead: agent?.isLead ?? false },
      verb: "kv.write.any",
      resource: { kind: "kv-namespace", namespace },
      source: info.callOrigin === "mcp" ? "mcp" : "http",
    }).allow;
    if (!allowed) return "writes to another agent's namespace require lead";
  }

  return null;
}
