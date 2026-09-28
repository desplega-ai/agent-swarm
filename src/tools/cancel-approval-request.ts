import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { cancelApprovalRequest } from "@/workflows/approval-cancel";

export const cancelApprovalRequestInputSchema = z.object({
  requestId: z.uuid().describe("The ID of the approval request to cancel."),
  reason: z.string().max(500).optional().describe("Reason for cancellation."),
});

export const cancelApprovalRequestOutputSchema = swarmToolOutputSchema({
  yourAgentId: z.string().optional(),
  approvalRequest: z.looseObject({}).optional(),
  alreadyCancelled: z.boolean().optional(),
  runCancelled: z.boolean().optional(),
});

export const registerCancelApprovalRequestTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "cancel-approval-request",
    {
      title: "Cancel approval request",
      description:
        "Cancel a pending approval request by id. Allowed for a lead agent, or for the agent that owns the request's source task. If the request gates a running or waiting workflow run, that run is cancelled too. A request whose explicit timeout passed is already 'timeout' and cannot be cancelled.",
      annotations: { destructiveHint: true },
      inputSchema: cancelApprovalRequestInputSchema,
      outputSchema: cancelApprovalRequestOutputSchema,
    },
    async ({ requestId, reason }, info) => {
      if (!info.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }
      const agent = await getAgentById(info.agentId);
      const result = await cancelApprovalRequest({
        id: requestId,
        reason,
        principal: { kind: "agent", agentId: info.agentId, isLead: agent?.isLead ?? false },
        resolvedBy: info.agentId,
        source: "mcp",
      });
      if (!result.ok) {
        return toolErr(result.message, { data: { yourAgentId: info.agentId } });
      }
      const data = {
        yourAgentId: info.agentId,
        approvalRequest: result.request,
        alreadyCancelled: result.alreadyCancelled,
        runCancelled: result.runCancelled,
      };
      const message = result.alreadyCancelled
        ? `Approval request "${requestId}" was already cancelled.`
        : `Approval request "${requestId}" cancelled${result.runCancelled ? ", and its workflow run with it" : ""}.`;
      return toolOk(message, { data, details: JSON.stringify(data, null, 2) });
    },
  );
};
