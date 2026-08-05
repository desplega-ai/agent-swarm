import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  AppMigrationReportOutputSchema,
  AppMigrationSchema,
  AppSchemaMigrationError,
  AppSnapshotFailure,
  ForceElementBreakSchema,
  unexpectedMigrationDetails,
} from "@/apps/schema-migrate";
import {
  AppRollbackAppNotFoundError,
  AppRollbackDefinitionError,
  AppRollbackVersionNotFoundError,
  rollbackApp,
} from "@/apps/version";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerAppRollbackTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-rollback",
    {
      title: "Rollback an app",
      description:
        "Restore a historical app snapshot through the schema migration and exported-element compatibility gates. Lossy row restores require migration directives; intentional consumer breaks require forceElementBreak.",
      annotations: { destructiveHint: false },
      rbac: { permission: "app.manage" },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID to restore."),
        version: z.number().int().positive().describe("Snapshot version to restore."),
        migration: AppMigrationSchema.optional().describe(
          "Explicit per-column directives for a lossy restore (set, from/map/else, coerce/else, or purge).",
        ),
        forceElementBreak: ForceElementBreakSchema.optional().describe(
          "Exported element names whose consumers may be broken by this restore.",
        ),
      }),
      outputSchema: swarmToolOutputSchema({
        appId: z.string().optional(),
        url: z.string().optional(),
        app: z.unknown().optional(),
        migration: AppMigrationReportOutputSchema.optional(),
        issues: z
          .array(z.looseObject({ path: z.string().optional(), message: z.string().optional() }))
          .optional(),
      }),
    },
    async ({ appId, version, migration, forceElementBreak }, requestInfo) => {
      if (!requestInfo.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      const agent = getAgentById(requestInfo.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: requestInfo.agentId, isLead: agent?.isLead ?? false },
        verb: "app.manage",
        resource: { kind: "app", appId },
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);

      try {
        const rolledBack = await rollbackApp({
          appId,
          version,
          migration,
          forceElementBreak,
          changedByAgentId: requestInfo.agentId,
        });
        const url = `/apps/${rolledBack.app.id}`;
        return toolOk(`App "${rolledBack.app.name}" rolled back to v${version}.`, {
          details: JSON.stringify(
            { appId: rolledBack.app.id, url, app: rolledBack.app, migration: rolledBack.migration },
            null,
            2,
          ),
          data: {
            appId: rolledBack.app.id,
            url,
            app: rolledBack.app,
            migration: rolledBack.migration,
          },
        });
      } catch (error) {
        if (
          error instanceof AppRollbackAppNotFoundError ||
          error instanceof AppRollbackVersionNotFoundError
        ) {
          return toolErr(error.message);
        }
        if (error instanceof AppRollbackDefinitionError) {
          return toolErr(error.message, {
            details: JSON.stringify({ issues: error.issues }, null, 2),
            data: { issues: error.issues },
          });
        }
        if (error instanceof AppSchemaMigrationError) {
          return toolErr("Invalid app schema migration.", {
            details: JSON.stringify({ issues: error.issues }, null, 2),
            data: { issues: error.issues },
          });
        }
        if (error instanceof AppSnapshotFailure) {
          return toolErr("Failed to snapshot app; rollback was not applied.");
        }
        return toolErr("Failed to roll back app; rollback was not applied.", {
          details: unexpectedMigrationDetails(error),
        });
      }
    },
  );
};
