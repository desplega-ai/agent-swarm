import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAutomationSetupStates } from "@/be/automation-preflight";
import { listScriptConnections } from "@/be/script-connections";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";

export const registerIntegrationStatusTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "integration-status",
    {
      title: "Integration Status",
      description:
        "Read which integrations this swarm has connected: slack, github, linear, jira, gsc, agentmail and agentfs as unverified, configured or verified (the same states the dashboard status page shows), plus the slugs of the enabled script connections this agent can call. Read-only.",
      annotations: { readOnlyHint: true },
      outputSchema: swarmToolOutputSchema({
        integrations: z.record(z.string(), z.string()).optional(),
        connections: z
          .array(z.looseObject({ slug: z.string().optional(), kind: z.string().optional() }))
          .optional(),
      }),
    },
    async (requestInfo) => {
      const [integrations, connections] = await Promise.all([
        getAutomationSetupStates(),
        listScriptConnections({ agentId: requestInfo.agentId }),
      ]);
      const slugs = connections.map(({ slug, kind }) => ({ slug, kind }));
      const summary = Object.entries(integrations)
        .map(([id, state]) => `${id}: ${state}`)
        .join(", ");
      return toolOk(`Integrations: ${summary}. Script connections: ${slugs.length}.`, {
        details:
          slugs.length > 0 ? slugs.map((c) => `- ${c.slug} (${c.kind})`).join("\n") : undefined,
        data: { integrations: { ...integrations }, connections: slugs },
      });
    },
  );
};
