import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { runAppAction } from "../apps/action-runner";
import { AppNameSchema } from "../apps/definition";
import { appDefinitionNeedsRepair, getApp } from "../apps/store";
import { getAgentById } from "../be/db";
import { can } from "../rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "./utils";

export function registerAppActionRunTool(server: McpServer) {
  createToolRegistrar(server)(
    "app-action-run",
    {
      title: "Run an app action",
      description:
        "Run a declared app action as an agent. Scripts and extensions cannot invoke this tool.",
      // An action runs a script, a sync, or a task: it can write rows and reach external sources.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      rbac: { permission: "app.use" },
      inputSchema: z.object({
        appId: z.string().min(1),
        action: AppNameSchema,
        input: z.record(z.string(), z.unknown()).optional(),
      }),
      outputSchema: swarmToolOutputSchema({
        ok: z.boolean().optional(),
        result: z.unknown().optional(),
        stdout: z.string().optional(),
        error: z.string().optional(),
        durationMs: z.number().optional(),
        taskId: z.string().optional(),
        status: z.string().optional(),
      }),
    },
    async ({ appId, action, input }, info) => {
      if (info.callOrigin === "script-sdk" || info.callOrigin === "extension")
        return toolErr("Scripts and extensions cannot run app actions.");
      if (!info.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      const agent = await getAgentById(info.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: info.agentId, isLead: agent?.isLead ?? false },
        verb: "app.use",
        resource: { kind: "app", appId },
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);
      const app = await getApp(appId);
      if (!app) return toolErr("App not found.");
      if (appDefinitionNeedsRepair(app))
        return toolErr("App definition needs repair.", { data: { issues: app.definitionError } });
      const output = await runAppAction({
        app,
        name: action,
        input,
        actor: `agent:${info.agentId}`,
        caller: { kind: "agent", id: info.agentId, ...(agent?.name ? { name: agent.name } : {}) },
      });
      if (output.status !== 200)
        return toolErr(output.body.error ?? "Action failed.", { data: output.body });
      return toolOk("Action invoked.", { data: output.body });
    },
  );
}
