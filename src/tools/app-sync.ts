import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { AppNameSchema } from "@/apps/definition";
import { getApp } from "@/apps/store";
import { runAppSync, type SyncPassResult } from "@/apps/sync";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

function cell(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/** One row per pass: what it wrote, and why it did not, if it failed. */
function renderPasses(passes: SyncPassResult[]): string {
  if (passes.length === 0) return "No sync passes ran.";
  const header = "| model | source | created | updated | refreshed | stale | error |";
  const separator = "| --- | --- | --- | --- | --- | --- | --- |";
  const body = passes.map((pass) =>
    [
      cell(pass.model),
      cell(pass.source),
      cell(pass.created),
      cell(pass.updated),
      cell(pass.refreshed),
      cell(pass.markedStale),
      cell(pass.error ?? (pass.skipped ? "skipped: already running" : undefined)),
    ]
      .map((value) => ` ${value} `)
      .join("|"),
  );
  const warnings = passes.flatMap((pass) =>
    pass.warnings.map((warning) => `- ${pass.model}.${pass.source}: ${warning}`),
  );
  return [header, separator, ...body.map((row) => `|${row}|`), ...warnings].join("\n");
}

export const registerAppSyncTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-sync",
    {
      title: "Sync an app's sources",
      description:
        "Refresh an app's declared sources: pull each selected (model x source) pair and reconcile its rows.",
      // Writes rows, but only ever projects the source's own view onto them.
      annotations: { destructiveHint: false },
      rbac: { permission: "app.use" },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID whose sources should sync."),
        model: AppNameSchema.optional().describe("Limit the sync to one model."),
        source: AppNameSchema.optional().describe("Limit the sync to one declared source name."),
      }),
      outputSchema: swarmToolOutputSchema({
        passes: z.array(z.looseObject({})).optional(),
        ok: z.boolean().optional(),
      }),
    },
    async ({ appId, model, source }, requestInfo) => {
      if (!requestInfo.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      const agent = getAgentById(requestInfo.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: requestInfo.agentId, isLead: agent?.isLead ?? false },
        verb: "app.use",
        resource: { kind: "app", appId },
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);
      const app = getApp(appId);
      if (!app) return toolErr(`App ${appId} not found.`);

      const result = await runAppSync({
        appId,
        ...(model === undefined ? {} : { model }),
        ...(source === undefined ? {} : { source }),
        invokedBy: `agent:${requestInfo.agentId}`,
      });

      if (result.issues && result.issues.length > 0) {
        // Covers both "no matching pair" and "definition needs repair".
        return toolErr(`Cannot sync app "${app.name}" (${app.id}).`, {
          details: result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
          data: { ok: false },
        });
      }

      const totals = result.passes.reduce(
        (sum, pass) => ({
          created: sum.created + pass.created,
          updated: sum.updated + pass.updated,
          refreshed: sum.refreshed + pass.refreshed,
          markedStale: sum.markedStale + pass.markedStale,
        }),
        { created: 0, updated: 0, refreshed: 0, markedStale: 0 },
      );
      const summary =
        `${result.passes.length} pass(es): ${totals.created} created, ${totals.updated} updated, ` +
        `${totals.refreshed} refreshed, ${totals.markedStale} marked stale.`;
      const details = renderPasses(result.passes);
      const data = { ok: result.ok, passes: result.passes };
      if (!result.ok) {
        return toolErr(`Sync failed for app "${app.name}" (${app.id}) — ${summary}`, {
          details,
          data,
        });
      }
      return toolOk(`Synced app "${app.name}" (${app.id}) — ${summary}`, { details, data });
    },
  );
};
