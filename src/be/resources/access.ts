import { can, type RbacPrincipal } from "../../rbac";
import {
  type BrowserProfile,
  type Resource,
  type ResourceListQuery,
  ResourceSchema,
} from "../../types";
import { getDbClient } from "../db";
import { getBrowserProfile, resourcePublicColumns, resourceTaskContext } from "./db";

export type ResourceAccess = {
  principal: RbacPrincipal;
  taskId: string | null;
  rootTaskId: string | null;
  requesterUserId: string | null;
};

/** Only explicit tasks qualify. Task ownership comes from current database rows. */
export async function resolveResourceAccess(
  principal: RbacPrincipal,
  taskId?: string,
): Promise<ResourceAccess | null> {
  if (principal.kind === "guest") return null;
  if (!taskId)
    return principal.kind === "agent"
      ? null
      : {
          principal,
          taskId: null,
          rootTaskId: null,
          requesterUserId: principal.kind === "user" ? principal.userId : null,
        };
  const context = await resourceTaskContext(taskId);
  if (!context) return null;
  if (principal.kind === "agent" && context.task.agentId !== principal.agentId) return null;
  if (principal.kind === "user" && context.requestedByUserId !== principal.userId) return null;
  return {
    principal,
    taskId,
    rootTaskId: context.rootTaskId,
    requesterUserId: context.requestedByUserId,
  };
}

export type ResourceAction =
  | "resource.read"
  | "resource.use"
  | "resource.destroy"
  | "resource.feedback";

export function canManageResourceProfile(
  principal: RbacPrincipal,
  profile: Pick<BrowserProfile, "ownerScope" | "ownerUserId">,
): boolean {
  return can({
    principal,
    verb: "resource.profile.manage",
    resource: { kind: "browser_profile", ...profile },
    source: "http",
  }).allow;
}
export function canManageResourceTemplates(principal: RbacPrincipal): boolean {
  return can({ principal, verb: "resource.template.manage", source: "http" }).allow;
}

async function currentAccess(access: ResourceAccess): Promise<ResourceAccess | null> {
  // Never trust cached assignment, requester, or ancestry when making a new decision.
  return resolveResourceAccess(access.principal, access.taskId ?? undefined);
}

export async function canCreateResource(
  access: ResourceAccess,
  profileId?: string,
): Promise<boolean> {
  const current = await currentAccess(access);
  const profile = profileId ? await getBrowserProfile(profileId) : null;
  const profileAllowed =
    !profileId ||
    !!(
      profile &&
      !profile.deletedAt &&
      (profile.ownerScope === "swarm" ||
        (current?.principal.kind !== "operator" &&
          profile.ownerUserId === current?.requesterUserId))
    );
  return can({
    principal: access.principal,
    verb: "resource.create",
    source: "http",
    resource: { kind: "resource", contextAuthorized: !!current?.taskId, profileAllowed },
  }).allow;
}

/**
 * List and detail reads use this same SQL predicate and only public columns.
 * Operators read retained metadata without task or profile access. Users read their stored attribution.
 * Agents require a current assigned task and a live source tree. Links never grant access.
 */
async function readPredicate(access: ResourceAccess) {
  const current = await currentAccess(access);
  const clauses = [current ? "1" : "0"];
  const params: (string | number)[] = [];
  let cte = "";
  if (current?.principal.kind === "agent") {
    // UNION terminates repeated nodes. Cycles and missing parents have no reachable root.
    cte = `WITH RECURSIVE live_tree(id, rootId) AS (
      SELECT id, id FROM agent_tasks WHERE id = ? AND parentTaskId IS NULL
      UNION SELECT child.id, parent.rootId FROM agent_tasks child
      JOIN live_tree parent ON child.parentTaskId = parent.id
    )`;
    params.push(current.rootTaskId ?? "");
    clauses.push(
      "r.rootTaskId = ?",
      "EXISTS (SELECT 1 FROM live_tree t WHERE t.id = r.sourceTaskId AND t.rootId = r.rootTaskId)",
    );
    params.push(current.rootTaskId ?? "");
  } else if (current?.principal.kind === "user") {
    clauses.push("r.requestedByUserId = ?");
    params.push(current.principal.userId);
  }
  if (current?.rootTaskId && current.principal.kind !== "agent") {
    clauses.push("r.rootTaskId = ?");
    params.push(current.rootTaskId);
  }
  if (current && current.principal.kind !== "operator") {
    clauses.push(`(r.profileId IS NULL OR EXISTS (
      SELECT 1 FROM browser_profiles p WHERE p.id = r.profileId
      ${current.principal.kind === "agent" ? "AND p.deletedAt IS NULL" : ""}
      AND (p.ownerScope = 'swarm' OR p.ownerUserId = ?)
    ))`);
    params.push(current.requesterUserId ?? "");
  }
  return { cte, clauses, params, current };
}

export async function canAccessResource(
  access: ResourceAccess,
  resource: Resource,
  verb: ResourceAction = "resource.read",
  source: "http" | "mcp" = "http",
): Promise<boolean> {
  if (verb === "resource.read") {
    const { cte, clauses, params } = await readPredicate(access);
    const visible = await getDbClient().get(
      `${cte} SELECT 1 FROM resources r WHERE ${clauses.join(" AND ")} AND r.id = ?`,
      [...params, resource.id],
    );
    return can({
      principal: access.principal,
      verb,
      source,
      resource: {
        kind: "resource",
        resourceId: resource.id,
        contextAuthorized: !!visible,
        profileAllowed: true,
      },
    }).allow;
  }
  const current = await currentAccess(access);
  const context = await resourceTaskContext(resource.sourceTaskId);
  const contextAuthorized =
    !!current?.taskId &&
    !!context &&
    context.rootTaskId === resource.rootTaskId &&
    current.rootTaskId === context.rootTaskId;
  const profile = resource.profileId ? await getBrowserProfile(resource.profileId) : null;
  const profileAllowed =
    !resource.profileId ||
    !!(
      profile &&
      !profile.deletedAt &&
      (profile.ownerScope === "swarm" ||
        (current?.principal.kind !== "operator" &&
          current?.requesterUserId != null &&
          current.requesterUserId === profile.ownerUserId))
    );
  return can({
    principal: access.principal,
    verb,
    source,
    resource: { kind: "resource", resourceId: resource.id, contextAuthorized, profileAllowed },
  }).allow;
}

export async function listAccessibleResources(
  access: ResourceAccess,
  query: ResourceListQuery,
  source: "http" | "mcp" = "http",
): Promise<Resource[]> {
  const { cte, clauses, params, current } = await readPredicate(access);
  // One admission audit covers the filtered list. Detail audits name the resource separately.
  if (
    !can({
      principal: access.principal,
      verb: "resource.read",
      source,
      resource: { kind: "resource", contextAuthorized: !!current, profileAllowed: true },
    }).allow
  )
    return [];
  if (query.kind) {
    clauses.push("r.kind = ?");
    params.push(query.kind);
  }
  if (query.state) {
    clauses.push("r.state = ?");
    params.push(query.state);
  }
  const rows = await getDbClient().query<Record<string, unknown>>(
    `${cte} SELECT ${resourcePublicColumns} FROM resources r WHERE ${clauses.join(" AND ")}
     ORDER BY r.createdAt DESC, r.id DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(100, Math.max(1, query.limit)), Math.max(0, query.offset)],
  );
  return rows.map((row) => ResourceSchema.parse(row));
}
