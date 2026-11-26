import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  AppDefinitionOpSchema,
  applyAppDefinitionOps,
  applyAppDefinitionPatch,
} from "@/apps/definition";
import { AppMigrationSchema, ForceElementBreakSchema } from "@/apps/schema-migrate";
import { commitAppDefinitionWrite } from "@/apps/write";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { appWriteOutputShape, appWriteToolResult } from "@/tools/app-write-response";
import { createToolRegistrar, swarmToolOutputSchema, toolErr } from "@/tools/utils";

export const registerAppPatchTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-patch",
    {
      title: "Patch an app",
      description:
        "Partially update an app, including zero-model pure-UI apps. userConfig defines versioned field schema while per-user values live outside definitions, survive rollback, and never need migration directives; userConfig.<field> entries are atomic. Pages may bind a declared field read-only at exactly /user/<field>; pure and bound reusable elements must receive that value through a prop. Reusable elements are private by default: pure elements read declared props, allow $item/$index inside repeats, may expose one leaf ElementSlot, and cannot invoke actions; bound elements may use the defining app's queries/actions, while exported bound elements cannot navigate. Prop kinds include enum with a required non-empty enum values array. Pages or elements reuse them with literal ElementRef targets, and cross-app refs require export: true. RFC 7396 merge-patch applies with this element rule: a patch value containing ONLY the elements key merges node-by-node; any other key present (mode/root/props/export) makes it a full element replace — restate every field you want kept. Page elements/params, actions, model columns, and userConfig fields are atomic; null deletes. Breaking a referenced export is blocked and names consumers unless forceElementBreak explicitly names it. ops applies JSON-pointer add/replace/remove/test instead; to change one page or element node prefer app-patch-node. Returns a compact summary (changed paths, issues, warnings, migration); includeApp adds the whole app, dryRun stores nothing.",
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
        ops: z
          .array(AppDefinitionOpSchema)
          .min(1)
          .max(200)
          .optional()
          .describe(
            'JSON-pointer ops instead of a merge patch: [{op: "add"|"replace"|"remove"|"test", path: "/pages/main/elements/title/props/text", value?}]. Applied in order; the first failing op (a failed test included) stores nothing and is reported at ops[<i>].',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe("Validate and plan the write, report changed paths and issues, store nothing."),
        includeApp: z
          .boolean()
          .optional()
          .describe(
            "Also return the whole stored app. Off by default: the response is the compact write summary.",
          ),
      }),
      outputSchema: swarmToolOutputSchema(appWriteOutputShape),
    },
    async (input, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }
      const agent = await getAgentById(requestInfo.agentId);
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

      if (input.definition !== undefined && input.ops !== undefined) {
        return toolErr("Give definition or ops, not both.");
      }
      const startedAt = performance.now();
      const ops = input.ops;
      const result = await commitAppDefinitionWrite({
        appId: input.appId,
        writerAgentId: requestInfo.agentId,
        name: input.name,
        description: input.description,
        nextDefinition: (stored) =>
          ops
            ? applyAppDefinitionOps(stored, ops)
            : applyAppDefinitionPatch(stored, input.definition ?? {}),
        migration: input.migration,
        forceElementBreak: input.forceElementBreak,
        dryRun: input.dryRun,
      });
      return appWriteToolResult(result, {
        startedAt,
        includeApp: input.includeApp,
        verb: "patched",
      });
    },
  );
};
