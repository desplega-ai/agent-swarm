import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { parseAppDefinition } from "@/apps/definition";
import type { AppRecord } from "@/apps/store";
import { createApp, getApp, updateApp } from "@/apps/store";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerAppUpsertTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-upsert",
    {
      title: "Create or update an app",
      description:
        "Stores a schema-backed app definition and returns its dashboard URL. Pass appId to update an existing app.",
      annotations: { destructiveHint: false },
      inputSchema: z.object({
        name: z.string().min(1).describe("Human-readable app name."),
        description: z.string().optional().describe("Optional short app description."),
        definition: z
          .unknown()
          .describe("App models, named queries, and json-render page definition."),
        appId: z.string().min(1).optional().describe("Existing app ID to update."),
      }),
      outputSchema: swarmToolOutputSchema({
        appId: z.string().optional(),
        url: z.string().optional(),
        issues: z
          .array(z.looseObject({ path: z.string().optional(), message: z.string().optional() }))
          .optional(),
      }),
    },
    async (input, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }
      const agent = getAgentById(requestInfo.agentId);
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        },
        verb: "app.manage",
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);

      const parsed = parseAppDefinition(input.definition);
      if (!parsed.success) {
        return toolErr("Invalid app definition.", {
          details: JSON.stringify({ issues: parsed.issues }, null, 2),
          data: { issues: parsed.issues },
        });
      }

      let app: AppRecord | null;
      if (input.appId) {
        if (!getApp(input.appId)) {
          return toolErr(`App ${input.appId} not found.`, {
            data: { appId: input.appId, url: `/apps/${input.appId}` },
          });
        }
        app = updateApp(input.appId, {
          name: input.name,
          description: input.description,
          definition: parsed.definition,
        });
      } else {
        app = createApp({
          name: input.name,
          description: input.description,
          definition: parsed.definition,
        });
      }

      if (!app) return toolErr("Failed to save app.");
      const url = `/apps/${app.id}`;
      return toolOk(`App "${app.name}" saved.`, {
        details: `App: ${url}`,
        data: { appId: app.id, url },
      });
    },
  );
};
