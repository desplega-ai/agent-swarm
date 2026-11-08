import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAgentById } from "../be/db";
import { listAccessibleResources, resolveResourceAccess } from "../be/resources/access";
import type { RbacPrincipal } from "../rbac";
import { ResourceKindSchema, ResourceStateSchema } from "../types";
import { getCurrentRequestAuth } from "../utils/request-auth-context";
import {
  createToolRegistrar,
  type RequestInfo,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "./utils";

export const resourceListConfig = {
  title: "Resource List",
  description:
    "List authorized sandbox and browser resources. Agents must specify their source task. Results exclude connection credentials.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: z
    .object({
      taskId: z.string().optional(),
      kind: ResourceKindSchema.optional(),
      state: ResourceStateSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  outputSchema: swarmToolOutputSchema({ resources: z.array(z.looseObject({})).optional() }),
};

export async function resourceListHandler(
  args: z.infer<typeof resourceListConfig.inputSchema>,
  info: RequestInfo,
) {
  const auth = getCurrentRequestAuth();
  if (auth?.kind === "guest" || auth?.kind === "controller")
    return toolErr("Resource access is denied.");
  let principal: RbacPrincipal;
  const callerAgentId = auth?.kind === "agent" ? auth.agentId : info.agentId;
  if (auth?.kind === "user") principal = { kind: "user", userId: auth.userId };
  else if (callerAgentId) {
    const agent = await getAgentById(callerAgentId);
    if (!agent) return toolErr("Resource access requires a registered agent.");
    principal = { kind: "agent", agentId: agent.id, isLead: agent.isLead };
  } else if (auth?.kind === "operator") principal = { kind: "operator" };
  else return toolErr("Resource access requires authentication.");
  const boundTask =
    auth?.kind === "agent" ? (auth.sourceTaskId ?? auth.taskId ?? undefined) : undefined;
  const requestedTask = args.taskId ?? info.sourceTaskId;
  if (boundTask && requestedTask && boundTask !== requestedTask)
    return toolErr("The task does not match the credential provenance.");
  const access = await resolveResourceAccess(principal, boundTask ?? requestedTask);
  if (!access) return toolErr("Resource access requires an explicit authorized task.");
  const resources = await listAccessibleResources(access, args, "mcp");
  return toolOk(`Found ${resources.length} resources.`, { data: { resources } });
}

export const registerResourceListTool = (server: McpServer) => {
  createToolRegistrar(server)("resource-list", resourceListConfig, resourceListHandler);
};
