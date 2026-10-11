import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import { getAgentById } from "../be/db";
import { listRuntimeInstancesForPool } from "../be/multi-runtime";
import {
  bindAgentToPool,
  checkE2bControllerConfig,
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
  deleteRuntimeController,
  deleteRuntimePool,
  getRuntimeController,
  getRuntimePool,
  listRuntimeControllers,
  listRuntimePools,
  RuntimePoolError,
  updateRuntimeController,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import { mintControllerToken } from "../be/runtime-pools/tokens";
import { can } from "../rbac";
import {
  AgentSchema,
  RuntimeControllerCreateSchema,
  RuntimeControllerSchema,
  RuntimeControllerUpdateSchema,
  RuntimeInstanceSchema,
  RuntimePoolCreateAgentSchema,
  RuntimePoolCreateSchema,
  RuntimePoolSchema,
  RuntimePoolUpdateSchema,
} from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
import { scrubSecrets } from "../utils/secret-scrubber";
import { agentFirstPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const idParams = z.object({ id: z.string().min(1) });

const listPoolsRoute = route({
  method: "get",
  path: "/api/runtime-pools",
  pattern: ["api", "runtime-pools"],
  operationId: "runtime_listPools",
  summary: "List runtime pools",
  tags: ["Runtime pools"],

  responses: {
    200: { description: "Success", schema: z.object({ pools: z.array(RuntimePoolSchema) }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
  },
});

const createPoolRoute = route({
  method: "post",
  path: "/api/runtime-pools",
  pattern: ["api", "runtime-pools"],
  operationId: "runtime_createPool",
  summary: "Create a runtime pool",
  tags: ["Runtime pools"],

  body: RuntimePoolCreateSchema,

  responses: {
    200: {
      description: "Success",
      schema: z.object({ pool: RuntimePoolSchema, warning: z.string().optional() }),
    },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
    409: { description: "Entity is in use or already exists" },
  },
  rbac: { permission: "runtime_pool.write" },
});

const getPoolRoute = route({
  method: "get",
  path: "/api/runtime-pools/{id}",
  pattern: ["api", "runtime-pools", null],
  operationId: "runtime_getPool",
  summary: "Get a runtime pool",
  tags: ["Runtime pools"],
  params: idParams,

  responses: {
    200: { description: "Success", schema: z.object({ pool: RuntimePoolSchema }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
  },
});

const patchPoolRoute = route({
  method: "patch",
  path: "/api/runtime-pools/{id}",
  pattern: ["api", "runtime-pools", null],
  operationId: "runtime_patchPool",
  summary: "Update a runtime pool",
  tags: ["Runtime pools"],
  params: idParams,
  body: RuntimePoolUpdateSchema,

  responses: {
    200: { description: "Success", schema: z.object({ pool: RuntimePoolSchema }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
    409: { description: "Entity is in use or already exists" },
  },
  rbac: { permission: "runtime_pool.write" },
});

const deletePoolRoute = route({
  method: "delete",
  path: "/api/runtime-pools/{id}",
  pattern: ["api", "runtime-pools", null],
  operationId: "runtime_deletePool",
  summary: "Delete a runtime pool",
  tags: ["Runtime pools"],
  params: idParams,

  query: z.object({ force: z.enum(["true", "false"]).optional() }),
  responses: {
    200: { description: "Success", schema: z.object({ deleted: z.literal(true) }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
    409: { description: "Entity is in use or already exists" },
  },
  rbac: { permission: "runtime_pool.write" },
});

const runtimesRoute = route({
  method: "get",
  path: "/api/runtime-pools/{id}/runtimes",
  pattern: ["api", "runtime-pools", null, "runtimes"],
  operationId: "runtime_runtimes",
  summary: "List pool runtimes",
  tags: ["Runtime pools"],
  params: idParams,

  responses: {
    200: { description: "Success", schema: z.object({ runtimes: z.array(RuntimeInstanceSchema) }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
  },
});

const createAgentRoute = route({
  method: "post",
  path: "/api/runtime-pools/{id}/agents",
  pattern: ["api", "runtime-pools", null, "agents"],
  operationId: "runtime_createAgent",
  summary: "Create an offline agent in a pool",
  tags: ["Runtime pools"],
  params: idParams,
  body: RuntimePoolCreateAgentSchema,

  responses: {
    200: { description: "Success", schema: z.object({ agent: AgentSchema }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
    409: { description: "Entity is in use or already exists" },
  },
  rbac: { permission: "runtime_pool.bind" },
});

const listControllersRoute = route({
  method: "get",
  path: "/api/runtime-controllers",
  pattern: ["api", "runtime-controllers"],
  operationId: "runtime_listControllers",
  summary: "List runtime controllers",
  tags: ["Runtime pools"],

  responses: {
    200: {
      description: "Success",
      schema: z.object({ controllers: z.array(RuntimeControllerSchema) }),
    },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
  },
});

const createControllerRoute = route({
  method: "post",
  path: "/api/runtime-controllers",
  pattern: ["api", "runtime-controllers"],
  operationId: "runtime_createController",
  summary: "Create a runtime controller",
  tags: ["Runtime pools"],

  body: RuntimeControllerCreateSchema,

  responses: {
    200: { description: "Success", schema: z.object({ controller: RuntimeControllerSchema }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
    409: { description: "Entity is in use or already exists" },
  },
  rbac: { permission: "runtime_controller.write" },
});

const getControllerRoute = route({
  method: "get",
  path: "/api/runtime-controllers/{id}",
  pattern: ["api", "runtime-controllers", null],
  operationId: "runtime_getController",
  summary: "Get a runtime controller",
  tags: ["Runtime pools"],
  params: idParams,

  responses: {
    200: { description: "Success", schema: z.object({ controller: RuntimeControllerSchema }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
  },
});

const patchControllerRoute = route({
  method: "patch",
  path: "/api/runtime-controllers/{id}",
  pattern: ["api", "runtime-controllers", null],
  operationId: "runtime_patchController",
  summary: "Update a runtime controller",
  tags: ["Runtime pools"],
  params: idParams,
  body: RuntimeControllerUpdateSchema,

  responses: {
    200: { description: "Success", schema: z.object({ controller: RuntimeControllerSchema }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
    409: { description: "Entity is in use or already exists" },
  },
  rbac: { permission: "runtime_controller.write" },
});

const deleteControllerRoute = route({
  method: "delete",
  path: "/api/runtime-controllers/{id}",
  pattern: ["api", "runtime-controllers", null],
  operationId: "runtime_deleteController",
  summary: "Delete a runtime controller",
  tags: ["Runtime pools"],
  params: idParams,

  responses: {
    200: { description: "Success", schema: z.object({ deleted: z.literal(true) }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
    409: { description: "Entity is in use or already exists" },
  },
  rbac: { permission: "runtime_controller.write" },
});

const bindAgentRoute = route({
  method: "put",
  path: "/api/agents/{id}/runtime-pool",
  pattern: ["api", "agents", null, "runtime-pool"],
  operationId: "runtime_bindAgent",
  summary: "Bind or unbind an agent to a pool",
  tags: ["Runtime pools"],
  params: idParams,
  body: z.object({ poolId: z.string().min(1).nullable() }).strict(),

  responses: {
    200: { description: "Success", schema: z.object({ agent: AgentSchema }) },
    400: { description: "Invalid configuration" },
    403: { description: "Permission denied" },
    404: { description: "Not found or runtime pools disabled" },
  },
  rbac: { permission: "runtime_pool.bind" },
});

const controllerTokenRoute = route({
  method: "post",
  path: "/api/runtime-controllers/{id}/token",
  pattern: ["api", "runtime-controllers", null, "token"],
  operationId: "runtime_mintControllerToken",
  summary: "Mint a remote controller token",
  description: "Returns the token once. Revokes the previous token and disconnects its session.",
  tags: ["Runtime pools"],
  params: idParams,
  rbac: { permission: "runtime_controller.write" },
  responses: {
    200: {
      description: "Controller token",
      schema: z.object({ tokenId: z.string(), plaintext: z.string(), expiresAt: z.string() }),
    },
    400: { description: "Controller placement must be remote" },
    403: { description: "Operator or user credentials required" },
    404: { description: "Controller not found or runtime pools disabled" },
  },
});

function scrubResponse<T>(data: T): T {
  return JSON.parse(scrubSecrets(JSON.stringify(data))) as T;
}

export async function handleRuntimePools(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  agentId?: string,
): Promise<boolean> {
  const routes = [
    listPoolsRoute,
    createPoolRoute,
    getPoolRoute,
    patchPoolRoute,
    deletePoolRoute,
    runtimesRoute,
    createAgentRoute,
    listControllersRoute,
    createControllerRoute,
    getControllerRoute,
    patchControllerRoute,
    deleteControllerRoute,
    bindAgentRoute,
    controllerTokenRoute,
  ];
  const matched = routes.find((route) => route.match(req.method, pathSegments));
  if (!matched) return false;
  if (!isRuntimePoolsEnabled()) {
    jsonError(res, "runtime pools are disabled", 404);
    return true;
  }
  try {
    if (matched === controllerTokenRoute) {
      const auth = getRequestAuth(req);
      if (auth?.kind !== "operator" && auth?.kind !== "user") {
        jsonError(res, "Controller tokens require operator or user credentials", 403);
        return true;
      }
    }
    const binding =
      matched === bindAgentRoute
        ? await bindAgentRoute.parse(req, res, pathSegments, queryParams)
        : undefined;
    if (matched === bindAgentRoute && !binding) return true;
    const rbac = matched.def.rbac;
    if (rbac && "permission" in rbac) {
      const caller = await agentFirstPrincipal(req, agentId);
      const poolId = binding
        ? (binding.body.poolId ??
          (await getAgentById(binding.params.id))?.runtimePoolId ??
          undefined)
        : pathSegments[2];
      const decision = can({
        principal: caller,
        verb: rbac.permission,
        resource:
          rbac.permission === "runtime_controller.write"
            ? { kind: "runtime_controller", controllerId: pathSegments[2] }
            : { kind: "runtime_pool", poolId },
        source: "http",
      });
      if (!decision.allow) {
        jsonError(res, scrubSecrets(decision.reason), 403);
        return true;
      }
    }
    const actor = req.method === "GET" ? null : await resolveHttpAuditUserId(req, agentId);
    if (matched === controllerTokenRoute) {
      const parsed = await controllerTokenRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      res.setHeader("Cache-Control", "no-store");
      controllerTokenRoute.respond(res, 200, await mintControllerToken(parsed.params.id));
      return true;
    }
    if (matched === listPoolsRoute) {
      const parsed = await listPoolsRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      listPoolsRoute.respond(res, 200, scrubResponse({ pools: await listRuntimePools() }));
      return true;
    }
    if (matched === createPoolRoute) {
      const parsed = await createPoolRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      const pool = await createRuntimePool(parsed.body, actor);
      const controller =
        pool.kind === "e2b" ? await getRuntimeController(pool.placements[0]!) : null;
      const config =
        controller?.placement === "builtin" ? await checkE2bControllerConfig(controller) : null;
      createPoolRoute.respond(
        res,
        200,
        scrubResponse({
          pool,
          ...(config && !config.ready
            ? { warning: config.hint ?? `Missing configuration: ${config.missing.join(", ")}` }
            : {}),
        }),
      );
      return true;
    }
    if (matched === getPoolRoute) {
      const parsed = await getPoolRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      const pool = await getRuntimePool(parsed.params.id);
      if (!pool) throw new RuntimePoolError("Pool not found", 404);
      getPoolRoute.respond(res, 200, scrubResponse({ pool }));
      return true;
    }
    if (matched === patchPoolRoute) {
      const parsed = await patchPoolRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      patchPoolRoute.respond(
        res,
        200,
        scrubResponse({ pool: await updateRuntimePool(parsed.params.id, parsed.body, actor) }),
      );
      return true;
    }
    if (matched === deletePoolRoute) {
      const parsed = await deletePoolRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      await deleteRuntimePool(parsed.params.id, parsed.query.force === "true", actor);
      deletePoolRoute.respond(res, 200, { deleted: true });
      return true;
    }
    if (matched === runtimesRoute) {
      const parsed = await runtimesRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      if (!(await getRuntimePool(parsed.params.id)))
        throw new RuntimePoolError("Pool not found", 404);
      runtimesRoute.respond(
        res,
        200,
        scrubResponse({ runtimes: await listRuntimeInstancesForPool(parsed.params.id) }),
      );
      return true;
    }
    if (matched === createAgentRoute) {
      const parsed = await createAgentRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      createAgentRoute.respond(
        res,
        200,
        scrubResponse({ agent: await createPoolAgent(parsed.params.id, parsed.body, actor) }),
      );
      return true;
    }
    if (matched === listControllersRoute) {
      const parsed = await listControllersRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      listControllersRoute.respond(
        res,
        200,
        scrubResponse({ controllers: await listRuntimeControllers() }),
      );
      return true;
    }
    if (matched === createControllerRoute) {
      const parsed = await createControllerRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      createControllerRoute.respond(
        res,
        200,
        scrubResponse({ controller: await createRuntimeController(parsed.body, actor) }),
      );
      return true;
    }
    if (matched === getControllerRoute) {
      const parsed = await getControllerRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      const controller = await getRuntimeController(parsed.params.id);
      if (!controller) throw new RuntimePoolError("Controller not found", 404);
      getControllerRoute.respond(res, 200, scrubResponse({ controller }));
      return true;
    }
    if (matched === patchControllerRoute) {
      const parsed = await patchControllerRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      patchControllerRoute.respond(
        res,
        200,
        scrubResponse({
          controller: await updateRuntimeController(parsed.params.id, parsed.body, actor),
        }),
      );
      return true;
    }
    if (matched === deleteControllerRoute) {
      const parsed = await deleteControllerRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      await deleteRuntimeController(parsed.params.id);
      deleteControllerRoute.respond(res, 200, { deleted: true });
      return true;
    }
    if (matched === bindAgentRoute) {
      const parsed = binding!;
      bindAgentRoute.respond(
        res,
        200,
        scrubResponse({
          agent: await bindAgentToPool(parsed.params.id, parsed.body.poolId, actor),
        }),
      );
      return true;
    }
  } catch (error) {
    jsonError(
      res,
      scrubSecrets(error instanceof Error ? error.message : String(error)),
      error instanceof RuntimePoolError ? error.status : 500,
    );
  }
  return true;
}
