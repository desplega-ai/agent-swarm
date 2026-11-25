import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { MAX_ACTION_RUN_WAIT_SECONDS, resolveActionRunState } from "../apps/action-run-status";
import { getAgentById } from "../be/db";
import { can } from "../rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "./utils";

export function registerAppActionStatusTool(server: McpServer) {
  createToolRegistrar(server)(
    "app-action-status",
    {
      title: "Read or wait on an app action run",
      description:
        "Read the run an `app-action-run` call returned (`run.id`). A script action's run settles when it and every run its script launched or called have finished; a task action's run settles with its task. `waitSeconds` (up to 25) holds the call until the run settles. Use it instead of sleep loops on app rows.",
      annotations: { readOnlyHint: true },
      rbac: { permission: "app.use" },
      inputSchema: z.object({
        appId: z.string().min(1),
        runId: z.string().min(1).describe("The `run.id` from app-action-run."),
        waitSeconds: z
          .number()
          .min(0)
          .max(MAX_ACTION_RUN_WAIT_SECONDS)
          .optional()
          .describe("Hold the call up to this many seconds (max 25) until the run settles."),
      }),
      outputSchema: swarmToolOutputSchema({
        run: z.unknown().optional(),
      }),
    },
    async ({ appId, runId, waitSeconds }, info) => {
      if (!info.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      const agent = await getAgentById(info.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: info.agentId, isLead: agent?.isLead ?? false },
        verb: "app.use",
        resource: { kind: "app", appId },
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);
      const run = await resolveActionRunState(appId, runId, waitSeconds);
      if (!run) return toolErr(`No action run ${runId} on app ${appId}.`);
      return toolOk(
        run.settled
          ? `Run ${run.id} ${run.state}.`
          : `Run ${run.id} still running. Next: ${run.next}`,
        { data: { run } },
      );
    },
  );
}
