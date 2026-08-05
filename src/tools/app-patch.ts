import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { applyAppDefinitionPatch, parseAppDefinition } from "@/apps/definition";
import {
  type AppMigrationReport,
  AppMigrationReportOutputSchema,
  AppMigrationSchema,
  AppSchemaMigrationError,
  AppSnapshotFailure,
  ForceElementBreakSchema,
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
        "Partially update an app, including zero-model pure-UI apps. userConfig defines versioned field schema while per-user values live outside definitions, survive rollback, and never need migration directives; userConfig.<field> entries are atomic. Pages may bind a declared field read-only at exactly /user/<field>; pure and bound reusable elements must receive that value through a prop. Reusable elements are private by default: pure elements read declared props, allow $item/$index inside repeats, may expose one leaf ElementSlot, and cannot invoke actions; bound elements may use the defining app's queries/actions, while exported bound elements cannot navigate. Prop kinds include enum with a required non-empty enum values array. Pages or elements reuse them with literal ElementRef targets, and cross-app refs require export: true. RFC 7396 merge-patch applies with this element rule: a patch value containing ONLY the elements key merges node-by-node; any other key present (mode/root/props/export) makes it a full element replace — restate every field you want kept. Page elements/params, actions, model columns, and userConfig fields are atomic; null deletes. Breaking a referenced export is blocked and names consumers unless forceElementBreak explicitly names it.",
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
            "Definition merge patch. Objects merge recursively; arrays and scalars replace; null deletes. For elements.<name>, a value containing ONLY the elements key merges node-by-node; any mode/root/props/export key makes it a full replace, so restate every field to keep. Page-element, param, action, and column entries replace atomically.",
          ),
        migration: AppMigrationSchema.optional().describe(
          "Explicit per-column directives for lossy schema changes (set, from/map/else, coerce/else, or purge).",
        ),
        forceElementBreak: ForceElementBreakSchema.optional().describe(
          "Exported element names whose known consumers may be broken by this patch. Use only to abandon those consumers explicitly.",
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
        resource: { kind: "app", appId: input.appId },
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
        const parsed = parseAppDefinition(patch.definition, {
          currentAppId: input.appId,
          resolveApp: getApp,
          writerAgentId: requestInfo.agentId,
          existingDefinition: lockedExisting.definition,
        });
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
            previousRawDefinition: lockedExisting.definition,
            nextDefinition: parsed.definition,
            migration: input.migration,
            forceElementBreak: input.forceElementBreak,
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
