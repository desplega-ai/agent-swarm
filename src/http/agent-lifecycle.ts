/**
 * Operator-only agent soft delete and restore (migration 334). Every route
 * checks `agent.lifecycle.manage`, which only the shared key without
 * `X-Agent-ID` (operator) and user tokens hold, so no agent, the lead included,
 * can delete or restore one. There is deliberately no MCP tool.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  AgentLifecycleError,
  listAgentLifecycleEvents,
  previewAgentDeletion,
  restoreAgent,
  softDeleteAgent,
} from "../be/db/agent-lifecycle";
import { can } from "../rbac";
import { AgentDeletePreviewSchema, AgentLifecycleEventSchema, AgentSchema } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getOperatorActor } from "./operator-actor";
import { agentFirstPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const params = z.object({ id: z.string().min(1) });
const reason = z.string().trim().min(3).max(2000);
const RefusalSchema = z.object({
  error: z.string(),
  code: z.string(),
  preview: AgentDeletePreviewSchema.optional(),
});
const ChangeResultSchema = z.object({
  agent: AgentSchema,
  disabledScheduleIds: z.array(z.string()),
  event: AgentLifecycleEventSchema,
});
const RBAC = { permission: "agent.lifecycle.manage" } as const;
const DENIED = { description: "Operator or user credentials required" };

const previewRoute = route({
  method: "get",
  path: "/api/agents/{id}/delete-preview",
  pattern: ["api", "agents", null, "delete-preview"],
  summary: "Preview an agent soft delete",
  description:
    "Blockers refuse the delete (open tasks, pool binding, a live worker, the lead, an extension identity, already deleted). Warnings list what stays pinned to the agent; echo `warningsHash` to the delete to confirm you saw them.",
  tags: ["Agents"],
  params,
  responses: {
    200: { description: "Preview", schema: AgentDeletePreviewSchema },
    403: DENIED,
    404: { description: "Agent not found" },
  },
  rbac: RBAC,
});

const deleteRoute = route({
  method: "post",
  path: "/api/agents/{id}/delete",
  pattern: ["api", "agents", null, "delete"],
  summary: "Soft-delete an agent",
  description:
    "Marks the agent deleted, disables schedules that target it, and records who, when and why. The row and everything it owns stay, so restore is lossless.",
  tags: ["Agents"],
  params,
  body: z.object({ reason, warningsHash: z.string().min(1) }),
  responses: {
    200: { description: "Agent deleted", schema: ChangeResultSchema },
    400: { description: "Validation error" },
    403: DENIED,
    404: { description: "Agent not found" },
    409: {
      description: "A blocker refuses the delete, or the warnings changed since the preview",
      schema: RefusalSchema,
    },
  },
  rbac: RBAC,
});

const restoreRoute = route({
  method: "post",
  path: "/api/agents/{id}/restore",
  pattern: ["api", "agents", null, "restore"],
  summary: "Restore a soft-deleted agent",
  description:
    "The agent comes back offline and unbound from any pool. Schedules the delete disabled stay off; their ids are returned for a manual re-enable.",
  tags: ["Agents"],
  params,
  body: z.object({ reason, newName: z.string().trim().min(1).optional() }),
  responses: {
    200: { description: "Agent restored", schema: ChangeResultSchema },
    400: { description: "Validation error" },
    403: DENIED,
    404: { description: "Agent not found" },
    409: { description: "Not deleted, or its name is taken (`name_taken`)", schema: RefusalSchema },
  },
  rbac: RBAC,
});

const eventsRoute = route({
  method: "get",
  path: "/api/agents/{id}/lifecycle-events",
  pattern: ["api", "agents", null, "lifecycle-events"],
  summary: "List an agent's delete and restore audit events",
  tags: ["Agents"],
  params,
  responses: {
    200: {
      description: "Events, newest first",
      schema: z.object({ events: z.array(AgentLifecycleEventSchema) }),
    },
    403: DENIED,
  },
  rbac: RBAC,
});

/** Gate shared with `GET /api/agents?deleted=only`. Writes a 403 and returns false on deny. */
export async function canManageAgentLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
  agentId?: string,
): Promise<boolean> {
  const decision = can({
    principal: await agentFirstPrincipal(req, myAgentId),
    verb: "agent.lifecycle.manage",
    resource: agentId ? { kind: "agent", agentId } : { kind: "none" },
    source: "http",
  });
  if (!decision.allow) jsonError(res, scrubSecrets(decision.reason), 403);
  return decision.allow;
}

export async function handleAgentLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  const matched = [previewRoute, deleteRoute, restoreRoute, eventsRoute].find((r) =>
    r.match(req.method, pathSegments),
  );
  if (!matched) return false;
  if (!(await canManageAgentLifecycle(req, res, myAgentId, pathSegments[2]))) return true;
  try {
    if (matched === previewRoute) {
      const parsed = await previewRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      previewRoute.respond(res, 200, await previewAgentDeletion(parsed.params.id));
      return true;
    }
    if (matched === eventsRoute) {
      const parsed = await eventsRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      eventsRoute.respond(res, 200, { events: await listAgentLifecycleEvents(parsed.params.id) });
      return true;
    }
    const operator = getOperatorActor(req, res);
    if (!operator) return true;
    const actor =
      operator.kind === "user"
        ? { kind: "user" as const, ref: `user:${operator.id}`, userId: operator.id }
        : { kind: "operator" as const, ref: operator.id, userId: null };
    if (matched === deleteRoute) {
      const parsed = await deleteRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      deleteRoute.respond(res, 200, await softDeleteAgent(parsed.params.id, parsed.body, actor));
      return true;
    }
    const parsed = await restoreRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    restoreRoute.respond(res, 200, await restoreAgent(parsed.params.id, parsed.body, actor));
    return true;
  } catch (error) {
    if (!(error instanceof AgentLifecycleError)) throw error;
    if (error.status === 404) {
      jsonError(res, error.message, 404);
      return true;
    }
    const body = { error: error.message, code: error.code, preview: error.preview };
    if (matched === restoreRoute) restoreRoute.respond(res, 409, body);
    else deleteRoute.respond(res, 409, body);
    return true;
  }
}
