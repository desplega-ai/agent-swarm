import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getApp } from "@/apps/store";
import { decodeAppVersion } from "@/apps/version";
import { getAgentById, getAppVersion, getAppVersions } from "@/be/db";
import { can } from "@/rbac";
import { computeDiff } from "@/tools/context-diff";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

async function definitionForVersion(appId: string, version: number): Promise<unknown | null> {
  const snapshot = await getAppVersion(appId, version);
  if (!snapshot) return null;
  return (decodeAppVersion(snapshot).snapshot as { definition: unknown }).definition;
}

export const registerAppDiffTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-diff",
    {
      title: "App definition diff",
      description:
        "Show a unified diff between two app definition snapshots, or a snapshot and CURRENT.",
      annotations: { readOnlyHint: true },
      rbac: { permission: "app.manage" },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID to compare."),
        from: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Older snapshot version. Defaults to newest snapshot."),
        to: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Newer snapshot version. Defaults to CURRENT."),
      }),
      outputSchema: swarmToolOutputSchema({
        fromLabel: z.string().optional(),
        toLabel: z.string().optional(),
        diff: z.string().optional(),
      }),
    },
    async ({ appId, from, to }, requestInfo) => {
      if (!requestInfo.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      const agent = await getAgentById(requestInfo.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: requestInfo.agentId, isLead: agent?.isLead ?? false },
        verb: "app.manage",
        resource: { kind: "app", appId },
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);

      const app = await getApp(appId);
      if (!app) return toolErr(`App ${appId} not found.`);
      const selectedFrom = from ?? (await getAppVersions(appId))[0]?.version;
      if (selectedFrom === undefined)
        return toolErr("No snapshots exist yet; create a definition write before diffing.");
      const fromDefinition = await definitionForVersion(appId, selectedFrom);
      if (fromDefinition === null) return toolErr(`App version ${selectedFrom} not found.`);

      const toDefinition =
        to === undefined ? app.definition : await definitionForVersion(appId, to);
      if (toDefinition === null) return toolErr(`App version ${to} not found.`);
      const fromLabel = `v${selectedFrom}`;
      const toLabel = to === undefined ? "CURRENT" : `v${to}`;
      const diff = await computeDiff(
        `${JSON.stringify(fromDefinition, null, 2)}\n`,
        `${JSON.stringify(toDefinition, null, 2)}\n`,
        { old: fromLabel, new: toLabel },
      );
      return toolOk(`Definition diff: ${fromLabel} → ${toLabel}.`, {
        details: diff,
        data: { fromLabel, toLabel, diff },
      });
    },
  );
};
