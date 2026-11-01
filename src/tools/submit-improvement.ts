import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { createImprovement, IMPROVEMENT_TEXT_MAX, ImprovementError } from "@/be/improvements";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const submitImprovementInputSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(IMPROVEMENT_TEXT_MAX)
    .describe(
      "The product improvement for desplega, in plain words. Do not include names, repos, hosts, customer details or secrets.",
    ),
});

export const submitImprovementOutputSchema = swarmToolOutputSchema({
  id: z.string().optional(),
  status: z.string().optional(),
});

/**
 * Drafts only. The draft waits in `pending_approval` until a person approves
 * it in the dashboard; there is no approve tool, and nothing is sent here.
 */
export const registerSubmitImprovementTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "submit-improvement",
    {
      title: "Draft a product improvement",
      description:
        "Draft a short product improvement for the agent-swarm team at desplega. It is stored as a pending draft and is never sent by this tool: a person must approve it in Settings → Configuration → Improvements. Only the text you write (plus the install id while telemetry is on, and an email the approver adds) is sent.",
      annotations: { destructiveHint: false },
      inputSchema: submitImprovementInputSchema,
      outputSchema: submitImprovementOutputSchema,
    },
    async ({ text }, info) => {
      if (info.callOrigin === "script-sdk" || info.callOrigin === "extension") {
        return toolErr("Scripts and extensions cannot draft improvements.");
      }
      if (!info.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }
      const agent = await getAgentById(info.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: info.agentId, isLead: agent?.isLead ?? false },
        verb: "improvement.submit",
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);
      try {
        const { improvement } = await createImprovement({
          text,
          source: "mcp",
          requestedByAgentId: info.agentId,
        });
        return toolOk(
          `Drafted improvement ${improvement.id}. A person must approve it in Settings → Configuration → Improvements before anything is sent.`,
          { data: { id: improvement.id, status: improvement.status } },
        );
      } catch (error) {
        if (error instanceof ImprovementError) return toolErr(error.message);
        throw error;
      }
    },
  );
};
