import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getApp } from "@/apps/store";
import { runAppSync, type SyncPassResult, SyncSelectionError } from "@/apps/sync";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

function escapeTableCell(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function renderPasses(passes: SyncPassResult[]): string {
  if (passes.length === 0) return "No sync passes ran.";
  const header =
    "| Model | Source | Connector | Pulled | Created | Updated | Unchanged | Stale | Warnings | Duration | Error |";
  const separator = "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |";
  const rows = passes.map((pass) => {
    const cells = [
      pass.model,
      pass.source,
      pass.connector,
      pass.pulled,
      pass.created,
      pass.updated,
      pass.unchanged,
      pass.markedStale,
      pass.warnings.length,
      `${pass.durationMs} ms`,
      pass.error,
    ];
    return `| ${cells.map(escapeTableCell).join(" | ")} |`;
  });
  return [header, separator, ...rows].join("\n");
}

export const registerAppSyncTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-sync",
    {
      title: "Synchronize an app",
      description:
        "Pull source-bound projections into app rows. Omit model and source to run every configured pair sequentially.",
      annotations: { destructiveHint: false },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID to synchronize."),
        model: z.string().min(1).optional().describe("Optional model name to restrict."),
        source: z.string().min(1).optional().describe("Optional source name to restrict."),
      }),
      outputSchema: swarmToolOutputSchema({
        passes: z.array(z.looseObject({})).optional(),
        issues: z
          .array(z.looseObject({ path: z.string().optional(), message: z.string().optional() }))
          .optional(),
      }),
    },
    async ({ appId, model, source }, requestInfo) => {
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

      const app = getApp(appId);
      if (!app) return toolErr(`App ${appId} not found.`);
      try {
        const result = await runAppSync(app, { model, source });
        const details = renderPasses(result.passes);
        return result.ok
          ? toolOk(`Synchronized ${result.passes.length} app source(s).`, {
              details,
              data: { passes: result.passes },
            })
          : toolErr("One or more app sync passes failed.", {
              details,
              data: { passes: result.passes },
            });
      } catch (error) {
        if (!(error instanceof SyncSelectionError)) return toolErr(String(error));
        return toolErr("Invalid app sync selection.", {
          details: JSON.stringify({ issues: error.issues }, null, 2),
          data: { issues: error.issues },
        });
      }
    },
  );
};
