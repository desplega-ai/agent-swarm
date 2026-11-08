import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  canAccessResource,
  listAccessibleResources,
  resolveResourceAccess,
} from "../be/resources/access";
import { getResource } from "../be/resources/db";
import { ResourceListQuerySchema, ResourceSchema } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { scrubObject } from "../utils/secret-scrubber";
import { resolveRequestPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const listRoute = route({
  method: "get",
  path: "/api/resources",
  pattern: ["api", "resources"],
  operationId: "resources_list",
  summary: "List authorized resources",
  tags: ["Resources"],
  query: ResourceListQuerySchema,
  rbac: { permission: "resource.read" },
  responses: {
    200: {
      description: "Authorized resources",
      schema: z.object({ resources: z.array(ResourceSchema) }),
    },
    403: { description: "A verified task context is required" },
  },
});
const detailRoute = route({
  method: "get",
  path: "/api/resources/{id}",
  pattern: ["api", "resources", null],
  operationId: "resources_get",
  summary: "Read an authorized resource",
  tags: ["Resources"],
  params: z.object({ id: z.string() }),
  query: z.object({ taskId: z.string().optional() }),
  rbac: { permission: "resource.read" },
  responses: {
    200: { description: "Authorized resource", schema: z.object({ resource: ResourceSchema }) },
    403: { description: "A verified task context is required" },
    404: { description: "Resource unavailable" },
  },
});

export async function handleResources(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  query: URLSearchParams,
  agentId?: string,
): Promise<boolean> {
  const matched = listRoute.match(req.method, pathSegments)
    ? listRoute
    : detailRoute.match(req.method, pathSegments)
      ? detailRoute
      : null;
  if (!matched) return false;
  res.setHeader("Cache-Control", "no-store");
  const principal = await resolveRequestPrincipal(req, agentId, {
    precedence: "agent-first",
    requireRegisteredAgent: true,
  });
  const auth = getRequestAuth(req);
  const header = req.headers["x-source-task-id"];
  const headerTask = Array.isArray(header) ? header[0] : header;
  const boundTask =
    auth?.kind === "agent" ? (auth.sourceTaskId ?? auth.taskId ?? undefined) : undefined;
  const requestedTask = query.get("taskId") ?? headerTask;
  if (!principal || (boundTask && requestedTask && requestedTask !== boundTask)) {
    jsonError(res, "Resource access requires a verified task context.", 403);
    return true;
  }
  const access = await resolveResourceAccess(principal, boundTask ?? requestedTask);
  if (!access) {
    jsonError(res, "Resource access requires an explicit authorized task.", 403);
    return true;
  }
  if (matched === listRoute) {
    const parsed = await listRoute.parse(req, res, pathSegments, query);
    if (!parsed) return true;
    listRoute.respond(
      res,
      200,
      scrubObject({ resources: await listAccessibleResources(access, parsed.query) }),
    );
  } else {
    const parsed = await detailRoute.parse(req, res, pathSegments, query);
    if (!parsed) return true;
    const resource = await getResource(parsed.params.id);
    if (!resource || !(await canAccessResource(access, resource)))
      jsonError(res, "Resource unavailable.", 404);
    else detailRoute.respond(res, 200, scrubObject({ resource }));
  }
  return true;
}
