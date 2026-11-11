/**
 * Operator-only agent delete and restore (src/be/agent-history.ts). Every route
 * checks `agent.lifecycle.manage`, which only the shared key without
 * `X-Agent-ID` (operator) and user tokens hold, so no agent, the lead included,
 * can delete or restore one. There is deliberately no MCP tool.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  AgentHistoryError,
  deleteAgentToHistory,
  listAgentHistory,
  restoreAgentFromHistory,
} from "../be/agent-history";
import { can } from "../rbac";
import { AgentHistoryEventSchema, AgentSchema } from "../types";
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
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
});
const RBAC = { permission: "agent.lifecycle.manage" } as const;
const DENIED = { description: "Operator or user credentials required" };

const deleteRoute = route({
  method: "post",
  path: "/api/agents/{id}/delete",
  pattern: ["api", "agents", null, "delete"],
  summary: "Delete an agent into agent_history",
  description:
    "Appends the agent row to `agent_history`, revokes its session tokens, and deletes the row. Refused with 409 while the agent is the lead, an extension identity, not offline, pool-bound, holds open tasks or enabled schedules, or owns skills, MCP servers or inboxes.",
  tags: ["Agents"],
  params,
  body: z.object({ reason }),
  responses: {
    200: { description: "Agent deleted", schema: z.object({ event: AgentHistoryEventSchema }) },
    400: { description: "Validation error" },
    403: DENIED,
    404: { description: "Agent not found" },
    409: { description: "A blocker refuses the delete", schema: RefusalSchema },
  },
  rbac: RBAC,
});

const restoreRoute = route({
  method: "post",
  path: "/api/agents/{id}/restore",
  pattern: ["api", "agents", null, "restore"],
  summary: "Restore a deleted agent from agent_history",
  description:
    "Reinserts the latest deleted snapshot under the same id. Rows a cascading foreign key removed on delete do not come back.",
  tags: ["Agents"],
  params,
  body: z.object({ reason, newName: z.string().trim().min(1).optional() }),
  responses: {
    200: {
      description: "Agent restored",
      schema: z.object({ agent: AgentSchema, event: AgentHistoryEventSchema }),
    },
    400: { description: "Validation error" },
    403: DENIED,
    404: { description: "No deleted agent with this id" },
    409: { description: "The agent exists, or its name is taken", schema: RefusalSchema },
  },
  rbac: RBAC,
});

const historyRoute = route({
  method: "get",
  path: "/api/agent-history",
  pattern: ["api", "agent-history"],
  summary: "List agent delete and restore events",
  description: "Newest first, at most 500. Filter by `agentId`.",
  tags: ["Agents"],
  query: z.object({ agentId: z.string().min(1).optional() }),
  responses: {
    200: {
      description: "Events",
      schema: z.object({ events: z.array(AgentHistoryEventSchema) }),
    },
    403: DENIED,
  },
  rbac: RBAC,
});

export async function handleAgentLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  const matched = [deleteRoute, restoreRoute, historyRoute].find((r) =>
    r.match(req.method, pathSegments),
  );
  if (!matched) return false;
  const decision = can({
    principal: await agentFirstPrincipal(req, myAgentId),
    verb: "agent.lifecycle.manage",
    resource:
      matched === historyRoute ? { kind: "none" } : { kind: "agent", agentId: pathSegments[2]! },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, scrubSecrets(decision.reason), 403);
    return true;
  }
  if (matched === historyRoute) {
    const parsed = await historyRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    historyRoute.respond(res, 200, { events: await listAgentHistory(parsed.query.agentId) });
    return true;
  }
  const operator = getOperatorActor(req, res);
  if (!operator) return true;
  const actorRef = operator.kind === "user" ? `user:${operator.id}` : operator.id;
  try {
    if (matched === deleteRoute) {
      const parsed = await deleteRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      const event = await deleteAgentToHistory(parsed.params.id, parsed.body.reason, actorRef);
      deleteRoute.respond(res, 200, { event });
      return true;
    }
    const parsed = await restoreRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    restoreRoute.respond(
      res,
      200,
      await restoreAgentFromHistory(parsed.params.id, parsed.body, actorRef),
    );
    return true;
  } catch (error) {
    if (!(error instanceof AgentHistoryError)) throw error;
    if (error.status === 404) {
      jsonError(res, error.message, 404);
      return true;
    }
    const body = { error: error.message, code: error.code, blockers: error.blockers };
    if (matched === restoreRoute) restoreRoute.respond(res, 409, body);
    else deleteRoute.respond(res, 409, body);
    return true;
  }
}
