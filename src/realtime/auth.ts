import type { IncomingMessage } from "node:http";
import { getAgentById, getTaskById } from "../be/db";
import { getUserGrant } from "../be/rbac-roles";
import { getSessionRoot, sessionAccessForRoot } from "../be/session-shares";
import { getCombConfig } from "../comb/config";
import { mcpOverflowAuthError } from "../kv-overflow";
import { reservedNamespaceError } from "../kv-reserved-namespaces";
import { can, isRbacEnabled } from "../rbac";
import { agentContextKey, pageContextKey } from "../tasks/context-key";
import type { HttpRequestAuth } from "../utils/request-auth-context";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";

export type RoomNamespaceInfo = {
  agentId?: string;
  sourceTaskId?: string;
  pageId?: string;
};

export type RoomAuthorizationInfo = RoomNamespaceInfo & {
  callOrigin?: "http" | "mcp" | "ws";
  userId?: string;
  isOperator?: boolean;
  /** The user an operator-key dashboard tab picked (`X-Swarm-User-Id`), captured on its ticket. */
  dashboardUserId?: string;
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
const SESSION_PRESENCE_NAMESPACE = /^presence:session:([A-Za-z0-9_-]{1,64})$/;

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
  name?: string,
): Promise<string | null> {
  const overflowError = mcpOverflowAuthError(namespace, info.agentId);
  if (overflowError) return overflowError;

  if (namespace === "worker" || namespace.startsWith("worker:")) {
    if (!isRuntimePoolsEnabled()) return "Worker push delivery is disabled";
    if (name !== "nudge" || (access !== "subscribe" && access !== "unsubscribe")) {
      return "Worker channels only allow subscribe and unsubscribe to nudge";
    }
    if (!info.agentId || info.pageId || namespace !== `worker:${info.agentId}`) {
      return "Worker channels require the matching agent identity";
    }
    return null;
  }

  if (namespace.startsWith("presence:comb:")) {
    if (!COMB_PRESENCE_NAMESPACE.test(namespace)) {
      return "invalid Comb presence namespace";
    }
    // Presence is for the swarm's shared Comb drive only, and only while Comb is on.
    const comb = getCombConfig();
    if (!comb.enabled) return "Comb is off";
    if (
      !comb.orgId ||
      !comb.driveId ||
      namespace !== `presence:comb:${comb.orgId}:${comb.driveId}`
    ) {
      return "Comb presence is only available for the configured Comb drive";
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

  if (namespace.startsWith("presence:session:")) {
    return authorizeSessionPresence(namespace, info, access);
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

/**
 * Bus topic published after a session's shares change. Sockets in that
 * session's presence room re-check access and are evicted when it ended.
 */
export function sessionAccessTopic(rootTaskId: string): string {
  return `session-access:${rootTaskId}`;
}

/** The root task id of a `presence:session:<rootTaskId>` namespace, else undefined. */
export function sessionPresenceRoot(namespace: string): string | undefined {
  return SESSION_PRESENCE_NAMESPACE.exec(namespace)?.[1];
}

/**
 * `presence:session:<rootTaskId>`: who is viewing (and typing in) a session.
 * Presence-only, dashboard-only, and gated on read access so it never reveals
 * who is inside a private session. An operator-key tab with no picked user
 * keeps the access it has everywhere else.
 */
async function authorizeSessionPresence(
  namespace: string,
  info: RoomAuthorizationInfo,
  access: boolean | RoomNamespaceOperation,
): Promise<string | null> {
  const match = SESSION_PRESENCE_NAMESPACE.exec(namespace);
  if (!match) return "invalid session presence namespace";
  if (info.pageId || info.agentId || (!info.isOperator && !info.userId)) {
    return "Session presence requires dashboard authentication";
  }
  if (typeof access !== "string" || !COMB_PRESENCE_OPERATIONS.has(access)) {
    return "Session presence rooms only allow join, leave, and presence";
  }
  const principal = info.isOperator
    ? ({ kind: "operator" } as const)
    : ({ kind: "user", userId: info.userId! } as const);
  if (
    !can({
      principal,
      verb: "session.presence",
      resource: { kind: "kv-namespace", namespace },
      source: info.callOrigin === "mcp" ? "mcp" : "http",
    }).allow
  ) {
    return "Session presence requires the session.presence permission";
  }
  if (info.userId && isRbacEnabled()) {
    const grant = await getUserGrant(info.userId);
    if (!grant.grantsAll && !grant.verbs.has("session.presence")) {
      return "Session presence requires the session.presence permission";
    }
  }
  const viewerId = info.isOperator ? info.dashboardUserId : info.userId;
  if (info.isOperator && !viewerId) return null;
  const root = await getSessionRoot(match[1]!);
  if (!root || root.id !== match[1]) return "session not found";
  if ((await sessionAccessForRoot(viewerId ?? null, root)) === "none") {
    return "You don't have access to this session";
  }
  return null;
}
