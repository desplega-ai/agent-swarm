import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { AppNodePatchSchema, applyAppNodePatch } from "@/apps/definition-edit";
import { commitAppDefinitionWrite } from "@/apps/write";
import { getAgentById } from "@/be/db";
import { can } from "@/rbac";
import { appWriteOutputShape, appWriteToolResult } from "@/tools/app-write-response";
import { createToolRegistrar, swarmToolOutputSchema, toolErr } from "@/tools/utils";

export const registerAppPatchNodeTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-patch-node",
    {
      title: "Patch one app node",
      description:
        "Edit one node of a page (page) or reusable element (element) without resending the definition, like patch-workflow-node. props merges one level into the node's props (null deletes a prop); set replaces node keys whole (type, props, children, on, visible, repeat, watch); remove deletes the node, unlinks it from its parent and drops its now-unreachable subtree; create adds nodeId under create.parentId at create.index. The result is validated like app-patch and snapshotted. A missing node returns the closest node ids. Returns a compact summary (changed paths, issues, warnings); includeApp adds the whole app, dryRun stores nothing. Read the node first with app-get {path}, or the tree with app-get {outline: true}.",
      annotations: { destructiveHint: false },
      rbac: { permission: "app.manage" },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID to patch."),
        ...AppNodePatchSchema.shape,
        dryRun: z
          .boolean()
          .optional()
          .describe("Validate the edit and report changed paths and issues, store nothing."),
        includeApp: z
          .boolean()
          .optional()
          .describe("Also return the whole stored app. Off by default."),
      }),
      outputSchema: swarmToolOutputSchema(appWriteOutputShape),
    },
    async ({ appId, dryRun, includeApp, ...patch }, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }
      const agent = await getAgentById(requestInfo.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: requestInfo.agentId, isLead: agent?.isLead ?? false },
        verb: "app.manage",
        resource: { kind: "app", appId },
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);

      const startedAt = performance.now();
      const result = await commitAppDefinitionWrite({
        appId,
        writerAgentId: requestInfo.agentId,
        nextDefinition: (stored) => applyAppNodePatch(stored, patch),
        dryRun,
      });
      return appWriteToolResult(result, {
        startedAt,
        includeApp,
        verb: `node "${patch.nodeId}" patched`,
      });
    },
  );
};
