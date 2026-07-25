import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import { getAgentById, getTaskById, resolveEffectiveTaskOptions } from "../be/db";
import {
  createEdgeHandler,
  deleteEdgeHandler,
  getEdgeHandlerById,
  listEdgeHandlers,
  patchEdgeHandler,
} from "../be/edge-handlers-db";
import { aggregateHandlerStats } from "../be/routing-trace-db";
import { getScript } from "../be/scripts/db";
import { can } from "../rbac";
import { buildRoutingCtx } from "../routing/ctx";
import { runBeforeAssign, runPromptCompose } from "../routing/engine";
import { composeTaskRoutingDirectives } from "../routing/prompt-compose";
import { type RoutingCtx, RoutingTaskSchema, RoutingViaSchema } from "../routing/types";
import {
  EdgeHandlerEdgeSchema,
  EdgeHandlerFlavorSchema,
  EdgeHandlerMatcherSchema,
  EdgeHandlerModeSchema,
} from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

const handlerNameSchema = z.string().min(1).max(200);
const handlerIdSchema = z.object({ id: z.string().uuid() });
const prioritySchema = z.number().int().min(0).max(1_000_000);
const timeoutMsSchema = z.number().int().positive().max(300_000);

const dryRunBodySchema = z
  .object({
    edge: EdgeHandlerEdgeSchema,
    taskId: z.string().min(1).optional(),
    envelope: z
      .object({
        via: RoutingViaSchema.optional(),
        task: RoutingTaskSchema.partial().optional(),
        proposedAgentId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .refine((body) => body.taskId !== undefined || body.envelope?.task !== undefined, {
    message: "Provide taskId or envelope.task",
  })
  .refine((body) => !(body.taskId !== undefined && body.envelope?.task !== undefined), {
    message: "Provide either taskId or envelope.task, not both",
  });

const createBodySchema = z.object({
  name: handlerNameSchema,
  edge: EdgeHandlerEdgeSchema,
  scriptName: handlerNameSchema,
  description: z.string().max(2_000).optional(),
  flavor: EdgeHandlerFlavorSchema,
  mode: EdgeHandlerModeSchema,
  priority: prioritySchema.default(100),
  matcher: EdgeHandlerMatcherSchema.optional(),
  timeoutMs: timeoutMsSchema.optional(),
  enabled: z.boolean().default(true),
});

const patchBodySchema = z
  .object({
    name: handlerNameSchema.optional(),
    edge: EdgeHandlerEdgeSchema.optional(),
    scriptName: handlerNameSchema.optional(),
    description: z.string().max(2_000).nullable().optional(),
    flavor: EdgeHandlerFlavorSchema.optional(),
    mode: EdgeHandlerModeSchema.optional(),
    priority: prioritySchema.optional(),
    matcher: EdgeHandlerMatcherSchema.nullable().optional(),
    timeoutMs: timeoutMsSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to patch",
  });

const registerHandlerRoute = route({
  method: "post",
  path: "/api/routing/handlers",
  pattern: ["api", "routing", "handlers"],
  operationId: "routing_handler_register",
  summary: "Register a lifecycle edge handler",
  description:
    "Registers an enabled or disabled global-script handler; execution is not part of this endpoint.",
  tags: ["Routing"],
  body: createBodySchema,
  responses: {
    201: { description: "Handler registered" },
    400: { description: "Validation error or unknown global script" },
    403: { description: "Registration requires lead agent" },
  },
  rbac: { permission: "routing.write" },
});

const listHandlersRoute = route({
  method: "get",
  path: "/api/routing/handlers",
  pattern: ["api", "routing", "handlers"],
  operationId: "routing_handler_list",
  summary: "List lifecycle edge handlers",
  tags: ["Routing"],
  responses: {
    200: { description: "Registered handlers" },
  },
});

const handlerStatsRoute = route({
  method: "get",
  path: "/api/routing/stats",
  pattern: ["api", "routing", "stats"],
  operationId: "routing_handler_stats",
  summary: "Aggregate lifecycle handler statistics",
  tags: ["Routing"],
  query: z.object({ windowHours: z.coerce.number().positive().optional() }),
  responses: { 200: { description: "Per-handler routing statistics" } },
});

const dryRunRoute = route({
  method: "post",
  path: "/api/routing/dry-run",
  pattern: ["api", "routing", "dry-run"],
  operationId: "routing_dry_run",
  summary: "Dry-run a routing edge without applying lifecycle mutations",
  tags: ["Routing"],
  body: dryRunBodySchema,
  responses: {
    200: { description: "Would-be routing decision and ordered handler trace" },
    403: { description: "Dry-running routing requires lead agent" },
    404: { description: "Task not found" },
  },
  rbac: { permission: "routing.write" },
});

const patchHandlerRoute = route({
  method: "patch",
  path: "/api/routing/handlers/{id}",
  pattern: ["api", "routing", "handlers", null],
  operationId: "routing_handler_patch",
  summary: "Update a lifecycle edge handler",
  tags: ["Routing"],
  params: handlerIdSchema,
  body: patchBodySchema,
  responses: {
    200: { description: "Handler updated" },
    400: { description: "Validation error or unknown global script" },
    403: { description: "Requires lead agent or handler owner" },
    404: { description: "Handler not found" },
  },
  rbac: { permission: "routing.mutate.any" },
});

const deleteHandlerRoute = route({
  method: "delete",
  path: "/api/routing/handlers/{id}",
  pattern: ["api", "routing", "handlers", null],
  operationId: "routing_handler_delete",
  summary: "Delete a lifecycle edge handler",
  tags: ["Routing"],
  params: handlerIdSchema,
  responses: {
    200: { description: "Handler deleted" },
    403: { description: "Requires lead agent or handler owner" },
    404: { description: "Handler not found" },
  },
  rbac: { permission: "routing.mutate.any" },
});

function requireAgent(res: ServerResponse, agentId: string | undefined) {
  if (!agentId) {
    jsonError(res, "X-Agent-ID required for routing API", 400);
    return null;
  }
  const agent = getAgentById(agentId);
  if (!agent) {
    jsonError(res, "Agent not found", 404);
    return null;
  }
  return agent;
}

function canRegister(res: ServerResponse, agent: { id: string; isLead: boolean }): boolean {
  const decision = can({
    principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
    verb: "routing.write",
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, "Registering routing handlers requires lead agent", 403);
    return false;
  }
  return true;
}

function canMutate(
  res: ServerResponse,
  agent: { id: string; isLead: boolean },
  createdByAgentId: string | undefined,
): boolean {
  const decision = can({
    principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
    verb: "routing.mutate.any",
    resource: { kind: "owned", ownerAgentId: createdByAgentId },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, "Updating routing handlers requires lead agent or handler owner", 403);
    return false;
  }
  return true;
}

function requireGlobalScript(res: ServerResponse, scriptName: string): boolean {
  if (!getScript({ name: scriptName, scope: "global" })) {
    jsonError(res, `Global script not found: ${scriptName}`, 400);
    return false;
  }
  return true;
}

const promptComposeRoute = route({
  method: "post",
  path: "/api/routing/prompt-compose/{taskId}",
  pattern: ["api", "routing", "prompt-compose", null],
  operationId: "routing_prompt_compose",
  summary: "Compose per-task routing directives for an assigned agent",
  tags: ["Routing"],
  params: z.object({ taskId: z.string().uuid() }),
  responses: {
    200: { description: "Prompt routing directives" },
    404: { description: "Task is not assigned to this agent" },
  },
  auth: { agentId: true },
  rbac: { ungated: "Assigned agents may resolve only their own task prompt guidance." },
});

export async function handleRouting(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  agentId: string | undefined,
): Promise<boolean> {
  if (dryRunRoute.match(req.method, pathSegments)) {
    const parsed = await dryRunRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent || !canRegister(res, agent)) return true;

    const { edge, taskId, envelope } = parsed.body;
    let ctx: RoutingCtx;
    if (taskId) {
      const task = getTaskById(taskId);
      if (!task) {
        jsonError(res, "Task not found", 404);
        return true;
      }
      // Replay default: infer the via from the task shape instead of silently
      // assuming creation — a delegated follow-up replayed without an explicit
      // via would otherwise match zero delegation handlers.
      const inferredVia = envelope?.via ?? (task.parentTaskId ? "delegation" : "creation");
      ctx = buildRoutingCtx(inferredVia, task, {
        proposedAgentId: envelope?.proposedAgentId ?? task.agentId ?? undefined,
      });
    } else {
      const task = envelope?.task;
      if (!task?.description) {
        jsonError(res, "envelope.task.description required", 400);
        return true;
      }
      const { id: _id, description, ...options } = task;
      ctx = buildRoutingCtx(
        envelope?.via ?? "creation",
        resolveEffectiveTaskOptions(description, options),
        { proposedAgentId: envelope?.proposedAgentId },
      );
    }

    const decision = await (edge === "prompt.compose" ? runPromptCompose : runBeforeAssign)(ctx, {
      dryRun: true,
    });
    json(res, decision);
    return true;
  }

  if (promptComposeRoute.match(req.method, pathSegments)) {
    const parsed = await promptComposeRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent) return true;
    const task = getTaskById(parsed.params.taskId);
    if (!task || task.agentId !== agent.id) {
      jsonError(res, "Task is not assigned to this agent", 404);
      return true;
    }
    json(res, { routingDirectives: await composeTaskRoutingDirectives(task, agent.id) });
    return true;
  }
  if (registerHandlerRoute.match(req.method, pathSegments)) {
    const parsed = await registerHandlerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent || !canRegister(res, agent)) return true;
    if (!requireGlobalScript(res, parsed.body.scriptName)) return true;

    const handler = createEdgeHandler({
      ...parsed.body,
      createdByAgentId: agent.id,
      createdBy: resolveHttpAuditUserId(req, agent.id) ?? undefined,
    });
    json(res, { handler }, 201);
    return true;
  }

  if (listHandlersRoute.match(req.method, pathSegments)) {
    const parsed = await listHandlersRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const statsByHandler = new Map(
      aggregateHandlerStats().map((stats) => [stats.handlerName, stats]),
    );
    json(res, {
      handlers: listEdgeHandlers().map((handler) => ({
        ...handler,
        stats: statsByHandler.get(handler.name) ?? {
          handlerName: handler.name,
          hits: 0,
          decisive: 0,
          errors: 0,
          deviations: 0,
          avgDurationMs: null,
          lastHitAt: null,
        },
      })),
    });
    return true;
  }

  if (handlerStatsRoute.match(req.method, pathSegments)) {
    const parsed = await handlerStatsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    json(res, { stats: aggregateHandlerStats(parsed.query) });
    return true;
  }

  if (patchHandlerRoute.match(req.method, pathSegments)) {
    const parsed = await patchHandlerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent) return true;
    const existing = getEdgeHandlerById(parsed.params.id);
    if (!existing) {
      jsonError(res, "Routing handler not found", 404);
      return true;
    }
    if (!canMutate(res, agent, existing.createdByAgentId)) return true;
    if (parsed.body.scriptName && !requireGlobalScript(res, parsed.body.scriptName)) return true;

    const handler = patchEdgeHandler(parsed.params.id, {
      ...parsed.body,
      updatedBy: resolveHttpAuditUserId(req, agent.id) ?? undefined,
    });
    json(res, { handler });
    return true;
  }

  if (deleteHandlerRoute.match(req.method, pathSegments)) {
    const parsed = await deleteHandlerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent) return true;
    const existing = getEdgeHandlerById(parsed.params.id);
    if (!existing) {
      jsonError(res, "Routing handler not found", 404);
      return true;
    }
    if (!canMutate(res, agent, existing.createdByAgentId)) return true;
    deleteEdgeHandler(parsed.params.id);
    json(res, { deleted: true });
    return true;
  }

  return false;
}
