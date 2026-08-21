import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getApp } from "@/apps/store";
import { decodeAppVersion } from "@/apps/version";
import { getAgentById, getAppVersions } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

function escapeTableCell(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function digest(version: ReturnType<typeof decodeAppVersion>): string {
  const snapshot = version.snapshot as { definition?: unknown; definitionError?: unknown };
  if (snapshot.definitionError) return "definition needs repair";
  const definition = snapshot.definition as { models?: Record<string, { columns?: object }> };
  const models = Object.entries(definition.models ?? {});
  if (models.length === 0) return "no models";
  return models
    .map(([name, model]) => `${name} (${Object.keys(model.columns ?? {}).length} columns)`)
    .join(", ");
}

function renderHistory(versions: Awaited<ReturnType<typeof getAppVersions>>): string {
  if (versions.length === 0) return "No snapshots yet; the current app has no prior version.";
  const header = "| Version | Created | Changed by | Digest |";
  const separator = "| --- | --- | --- | --- |";
  const rows = versions.map((version) => {
    const decoded = decodeAppVersion(version);
    return `| ${[decoded.version, decoded.createdAt, decoded.changedByAgentId, digest(decoded)]
      .map(escapeTableCell)
      .join(" | ")} |`;
  });
  return [header, separator, ...rows].join("\n");
}

export const registerAppHistoryTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-history",
    {
      title: "App history",
      description: "List prior app definition snapshots with a compact digest of each version.",
      annotations: { readOnlyHint: true },
      rbac: { permission: "app.manage" },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID whose history to inspect."),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Maximum snapshots to return."),
      }),
      outputSchema: swarmToolOutputSchema({
        versions: z.array(z.unknown()).optional(),
        currentHead: z.number().optional(),
      }),
    },
    async ({ appId, limit }, requestInfo) => {
      if (!requestInfo.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      const agent = await getAgentById(requestInfo.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: requestInfo.agentId, isLead: agent?.isLead ?? false },
        verb: "app.manage",
        resource: { kind: "app", appId },
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);
      if (!(await getApp(appId))) return toolErr(`App ${appId} not found.`);

      const allVersions = await getAppVersions(appId);
      const versions = limit === undefined ? allVersions : allVersions.slice(0, limit);
      const currentHead = allVersions[0]?.version;
      return toolOk(`Found ${allVersions.length} snapshot(s) for app ${appId}.`, {
        details: `${currentHead === undefined ? "Current head: no snapshots" : `Current head: v${currentHead}`}\n\n${renderHistory(versions)}`,
        data: {
          versions: versions.map(decodeAppVersion),
          ...(currentHead === undefined ? {} : { currentHead }),
        },
      });
    },
  );
};
