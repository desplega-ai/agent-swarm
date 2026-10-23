/**
 * RBAC role assignment for people.
 *
 *   GET /api/rbac/roles
 *   GET /api/users/:id/roles
 *   PUT /api/users/:id/roles
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getUserById } from "../be/db";
import {
  getUserGrant,
  InvalidRoleSetError,
  LastAdminError,
  listRbacRoles,
  listUserRoles,
  PRIMARY_ROLE_NAMES,
  setUserRoles,
} from "../be/rbac-roles";
import { recordIdentityEvent } from "../be/users";
import { can, isRbacEnabled } from "../rbac";
import { RbacRoleSchema, UserRbacRolesSchema } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { getOperatorActor } from "./operator-actor";
import { agentFirstPrincipal, rejectGuest } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const listRolesRoute = route({
  method: "get",
  path: "/api/rbac/roles",
  pattern: ["api", "rbac", "roles"],
  operationId: "rbac_listRoles",
  summary: "List RBAC roles with their verbs",
  tags: ["Users"],
  responses: {
    200: { description: "Role catalog", schema: z.object({ roles: z.array(RbacRoleSchema) }) },
  },
});

const getUserRolesRoute = route({
  method: "get",
  path: "/api/users/{id}/roles",
  pattern: ["api", "users", null, "roles"],
  operationId: "users_getRbacRoles",
  summary: "Get a user's RBAC roles",
  tags: ["Users"],
  params: z.object({ id: z.string().min(1) }),
  responses: {
    200: { description: "The user's roles", schema: UserRbacRolesSchema },
    404: { description: "User not found" },
  },
});

const setUserRolesRoute = route({
  method: "put",
  path: "/api/users/{id}/roles",
  pattern: ["api", "users", null, "roles"],
  operationId: "users_setRbacRoles",
  summary: "Set a user's RBAC roles",
  description: `Replaces the user's roles. The set holds exactly one of ${PRIMARY_ROLE_NAMES.join(", ")} plus any extra roles. Demoting a user below admin removes the ability to answer approval requests, even when the user is listed as an approver. Fails with 409 when it would leave no active admin.`,
  tags: ["Users"],
  params: z.object({ id: z.string().min(1) }),
  body: z.object({ roles: z.array(z.string().min(1)).min(1) }).strict(),
  responses: {
    200: { description: "The user's roles after the change", schema: UserRbacRolesSchema },
    400: { description: "Invalid role set" },
    403: { description: "Not allowed to change roles" },
    404: { description: "User not found" },
    409: { description: "Would leave no active admin" },
  },
  rbac: { permission: "user.role.manage" },
});

async function composeRoles(userId: string) {
  const [catalog, held] = await Promise.all([listRbacRoles(), listUserRoles(userId)]);
  const names = new Set(held.map((role) => role.name));
  return { userId, roles: catalog.filter((role) => names.has(role.name)) };
}

/** Operator or user only; agents never change human roles, even with the shared key. */
async function ensureRoleManager(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (rejectGuest(req, res)) return false;
  const auth = getRequestAuth(req);
  if (auth?.kind !== "operator" && auth?.kind !== "user") {
    jsonError(res, "Role changes require operator or user credentials", 403);
    return false;
  }
  const header = req.headers["x-agent-id"];
  const decision = can({
    principal: await agentFirstPrincipal(req, Array.isArray(header) ? header[0] : header),
    verb: "user.role.manage",
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, decision.reason, 403);
    return false;
  }
  // A custom role holding user.role.manage must not be able to grant admin.
  if (auth.kind === "user" && isRbacEnabled() && !(await getUserGrant(auth.userId)).grantsAll) {
    jsonError(res, "Role changes require a grant-all role", 403);
    return false;
  }
  return true;
}

export async function handleUserRoles(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (listRolesRoute.match(req.method, pathSegments)) {
    if (rejectGuest(req, res)) return true;
    listRolesRoute.respond(res, 200, { roles: await listRbacRoles() });
    return true;
  }

  if (getUserRolesRoute.match(req.method, pathSegments)) {
    if (rejectGuest(req, res)) return true;
    const parsed = await getUserRolesRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await getUserById(parsed.params.id))) {
      jsonError(res, "User not found", 404);
      return true;
    }
    getUserRolesRoute.respond(res, 200, await composeRoles(parsed.params.id));
    return true;
  }

  if (setUserRolesRoute.match(req.method, pathSegments)) {
    const parsed = await setUserRolesRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureRoleManager(req, res))) return true;
    const actor = getOperatorActor(req, res);
    if (!actor) return true;
    const userId = parsed.params.id;
    if (!(await getUserById(userId))) {
      jsonError(res, "User not found", 404);
      return true;
    }
    try {
      const { before, after } = await setUserRoles(
        userId,
        parsed.body.roles,
        actor.kind === "user" ? actor.id : null,
      );
      await recordIdentityEvent(
        userId,
        "profile_changed",
        actor,
        { rbacRoles: before },
        { rbacRoles: after },
      );
    } catch (err) {
      if (err instanceof LastAdminError) {
        jsonError(res, "last_admin", 409);
        return true;
      }
      if (err instanceof InvalidRoleSetError) {
        jsonError(res, err.message, 400);
        return true;
      }
      throw err;
    }
    setUserRolesRoute.respond(res, 200, await composeRoles(userId));
    return true;
  }

  return false;
}
