import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { applyAppDefinitionPatch, parseAppDefinition } from "@/apps/definition";
import { appDefinitionNeedsRepair, getApp, updateApp } from "@/apps/store";
import { snapshotApp } from "@/apps/version";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerAppPatchTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-patch",
    {
      title: "Patch an app",
      description:
        "Partially update an app. The definition uses RFC 7396 JSON Merge Patch semantics, except each pages.<page>.elements.<id>, pages.<page>.params.<param>, actions.<name>, and models.<name>.columns.<col> value is replaced atomically; null deletes a key.",
      annotations: { destructiveHint: false },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID to patch."),
        name: z.string().min(1).optional().describe("Replacement human-readable app name."),
        description: z
          .string()
          .nullable()
          .optional()
          .describe("Replacement description. Pass null to clear it; omit to keep it."),
        definition: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Definition merge patch. Objects merge recursively; arrays and scalars replace; null deletes. Element, param, action, and column entries replace atomically.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        appId: z.string().optional(),
        url: z.string().optional(),
        app: z.unknown().optional(),
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

      const existing = getApp(input.appId);
      if (!existing) return toolErr(`App ${input.appId} not found.`);
      if (appDefinitionNeedsRepair(existing)) {
        return toolErr("Definition needs repair.", { data: { issues: existing.definitionError } });
      }

      const patch = applyAppDefinitionPatch(existing.definition, input.definition ?? {});
      if (!patch.success) {
        return toolErr("Invalid app definition.", {
          details: JSON.stringify({ issues: patch.issues }, null, 2),
          data: { issues: patch.issues },
        });
      }
      const parsed = parseAppDefinition(patch.definition);
      if (!parsed.success) {
        return toolErr("Invalid app definition.", {
          details: JSON.stringify({ issues: parsed.issues }, null, 2),
          data: { issues: parsed.issues },
        });
      }

      try {
        snapshotApp(input.appId, requestInfo.agentId);
      } catch {
        return toolErr("Failed to snapshot app; patch was not applied.");
      }
      const app = updateApp(input.appId, {
        name: input.name,
        description: input.description,
        definition: parsed.definition,
      });
      if (!app) return toolErr(`App ${input.appId} not found.`);

      const url = `/apps/${app.id}`;
      return toolOk(`App "${app.name}" patched.`, {
        details: JSON.stringify({ appId: app.id, url, app }, null, 2),
        data: { appId: app.id, url, app },
      });
    },
  );
};
