import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { applyAppDefinitionPatch, parseAppDefinition } from "@/apps/definition";
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
        migration: AppMigrationSchema.optional().describe(
          "Explicit per-column directives for lossy schema changes (set, from/map/else, coerce/else, or purge).",
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
      return withAppDefinitionLock(input.appId, async () => {
        const lockedExisting = getApp(input.appId);
        if (!lockedExisting) return toolErr(`App ${input.appId} not found.`);
        if (appDefinitionNeedsRepair(lockedExisting)) {
          return toolErr("Definition needs repair.", {
            data: { issues: lockedExisting.definitionError },
          });
        }

        const patch = applyAppDefinitionPatch(lockedExisting.definition, input.definition ?? {});
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

        let app: ReturnType<typeof updateApp>;
        let migration: AppMigrationReport;
        try {
          const migrated = await migrateAppSchema({
            appId: input.appId,
            previousDefinition: lockedExisting.definition,
            nextDefinition: parsed.definition,
            migration: input.migration,
            snapshot: () => {
              try {
                snapshotApp(input.appId, requestInfo.agentId);
              } catch {
                throw new AppSnapshotFailure();
              }
            },
            writeDefinition: () =>
              updateApp(input.appId, {
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
            return toolErr("Failed to snapshot app; patch was not applied.");
          }
          return toolErr("Failed to apply app schema migration; patch was not applied.", {
            details: unexpectedMigrationDetails(error),
          });
        }
        if (!app) return toolErr(`App ${input.appId} not found.`);

        const url = `/apps/${app.id}`;
        return toolOk(`App "${app.name}" patched.`, {
          details: JSON.stringify({ appId: app.id, url, app, migration }, null, 2),
          data: { appId: app.id, url, app, migration },
        });
      });
    },
  );
};
