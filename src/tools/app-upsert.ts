import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { parseAppDefinition } from "@/apps/definition";
import {
  type AppMigrationReport,
  AppMigrationReportOutputSchema,
  AppMigrationSchema,
  AppSchemaMigrationError,
  AppSnapshotFailure,
  migrateAppSchema,
  unexpectedMigrationDetails,
  withAppDefinitionLock,
} from "@/apps/schema-migrate";
import { createApp, getApp, updateApp } from "@/apps/store";
import { snapshotApp } from "@/apps/version";
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
        migration: AppMigrationSchema.optional().describe(
          "Explicit per-column directives for an update's lossy schema changes. Requires appId.",
        ),
      }),
      outputSchema: swarmToolOutputSchema({
        appId: z.string().optional(),
        url: z.string().optional(),
        migration: AppMigrationReportOutputSchema.optional(),
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

      if (input.appId) {
        const appId = input.appId;
        const existing = getApp(appId);
        if (!existing) {
          return toolErr(`App ${appId} not found.`, {
            data: { appId, url: `/apps/${appId}` },
          });
        }
        return withAppDefinitionLock(appId, async () => {
          const lockedExisting = getApp(appId);
          if (!lockedExisting) {
            return toolErr(`App ${appId} not found.`, {
              data: { appId, url: `/apps/${appId}` },
            });
          }
          const parsed = parseAppDefinition(input.definition);
          if (!parsed.success) {
            return toolErr("Invalid app definition.", {
              details: JSON.stringify({ issues: parsed.issues }, null, 2),
              data: { issues: parsed.issues },
            });
          }
          let app: ReturnType<typeof updateApp>;
          let migration: AppMigrationReport;
          try {
            const migrated = await migrateAppSchema({
              appId,
              previousDefinition: lockedExisting.definitionError
                ? undefined
                : lockedExisting.definition,
              nextDefinition: parsed.definition,
              migration: input.migration,
              snapshot: () => {
                try {
                  snapshotApp(appId, requestInfo.agentId);
                } catch {
                  throw new AppSnapshotFailure();
                }
              },
              writeDefinition: () =>
                updateApp(appId, {
                  name: input.name,
                  description: input.description,
                  definition: parsed.definition,
                }),
            });
            app = migrated.result;
            migration = migrated.migration;
          } catch (error) {
            if (error instanceof AppSchemaMigrationError) {
              return toolErr("Invalid app schema migration.", {
                details: JSON.stringify({ issues: error.issues }, null, 2),
                data: { issues: error.issues },
              });
            }
            if (error instanceof AppSnapshotFailure) {
              return toolErr("Failed to snapshot app; update was not applied.");
            }
            return toolErr("Failed to apply app schema migration; update was not applied.", {
              details: unexpectedMigrationDetails(error),
            });
          }
          if (!app) return toolErr("Failed to save app.");
          const url = `/apps/${app.id}`;
          return toolOk(`App "${app.name}" saved.`, {
            details: `App: ${url}`,
            data: { appId: app.id, url, migration },
          });
        });
      }

      if (input.migration)
        return toolErr("migration requires appId; new apps have no rows to migrate.");
      const parsed = parseAppDefinition(input.definition);
      if (!parsed.success) {
        return toolErr("Invalid app definition.", {
          details: JSON.stringify({ issues: parsed.issues }, null, 2),
          data: { issues: parsed.issues },
        });
      }
      const app = createApp({
        name: input.name,
        description: input.description,
        definition: parsed.definition,
      });
      if (!app) return toolErr("Failed to save app.");
      const url = `/apps/${app.id}`;
      return toolOk(`App "${app.name}" saved.`, {
        details: `App: ${url}`,
        data: { appId: app.id, url },
      });
    },
  );
};
