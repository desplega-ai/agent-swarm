import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getTaskById } from "@/be/db";
import { requestSteering, SteeringRequestError } from "@/be/steering";
import { can } from "@/rbac";
import { assertOwnsTask, ownerCtx, type ToolCtx } from "@/tools/task-tool-ctx";
import {
  createToolRegistrar,
  type SwarmToolResult,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";
import {
  OnUnsupportedSchema,
  SteerModeSchema,
  SteerOutcomeSchema,
  type SteerResult,
} from "@/types";

export const steerTaskInputSchema = z.object({
  taskId: z.uuid().describe("The ID of the running task to steer."),
  message: z.string().min(1).describe("The message to send to the task."),
  mode: SteerModeSchema.default("queue").describe("Deliver at a turn boundary or interrupt."),
  onUnsupported: OnUnsupportedSchema.describe(
    "Whether an unsupported mode should degrade or return an error.",
  ),
});

/** User and agent MCP surfaces accept the same steering request. */
export const steerTaskUserInputSchema = steerTaskInputSchema;

export const steerTaskOutputSchema = swarmToolOutputSchema({
  // Plain string, NOT .uuid(): agents may join with custom IDs (AGENT_ID env /
  // join-swarm agentId), and a UUID constraint here makes the response fail MCP
  // output validation after the handler already ran.
  yourAgentId: z.string().optional(),
  outcome: SteerOutcomeSchema.optional(),
  effectiveMode: SteerModeSchema.optional(),
  degradedFrom: SteerModeSchema.optional(),
  steeringMessageId: z.string().optional(),
  promotedTaskId: z.string().optional(),
});

type SteerTaskArgs = z.input<typeof steerTaskInputSchema>;

function resultMessage(result: SteerResult): string {
  if (result.outcome === "steered") return "Steered task immediately.";
  if (result.outcome === "promoted") return "Promoted to a follow-up task.";
  if (result.degradedFrom) {
    return "Queued for delivery (requested steer; claude supports queue only).";
  }
  return "Queued for delivery.";
}

export async function steerTaskHandler(
  ctx: ToolCtx,
  { taskId, message, mode = "queue", onUnsupported = "degrade" }: SteerTaskArgs,
): Promise<SwarmToolResult> {
  if (ctx.kind === "owner" && !ctx.agentId) {
    return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
  }

  const agentId = ctx.kind === "owner" ? ctx.agentId : undefined;
  const task = await getTaskById(taskId);
  if (!task) {
    return toolErr(`Task "${taskId}" not found.`, { data: { yourAgentId: agentId } });
  }

  if (ctx.kind === "owner") {
    const callerAgent = await getAgentById(ctx.agentId!);
    if (!callerAgent) {
      return toolErr("Caller agent not found.", { data: { yourAgentId: agentId } });
    }

    const decision = can({
      principal: { kind: "agent", agentId: callerAgent.id, isLead: callerAgent.isLead },
      verb: "task.steer.any",
      resource: {
        kind: "task",
        taskId: task.id,
        creatorAgentId: task.creatorAgentId,
      },
      source: "mcp",
    });
    if (!decision.allow) {
      return toolErr("Only the lead or task creator can steer tasks.", {
        data: { yourAgentId: agentId },
      });
    }
  } else {
    const ownershipError = assertOwnsTask(ctx, task, "task.steer.own");
    if (ownershipError) return ownershipError;
  }

  try {
    const result = await requestSteering({
      taskId,
      message,
      mode,
      onUnsupported,
      source: "mcp",
      createdByKind: ctx.kind === "owner" ? "agent" : "user",
      createdByAgentId: ctx.kind === "owner" ? ctx.agentId : undefined,
      createdByUserId: ctx.kind === "user" ? ctx.userId : undefined,
    });
    const humanMessage = resultMessage(result);
    const data = {
      yourAgentId: agentId,
      ...result,
    };

    return toolOk(humanMessage, { details: JSON.stringify(data), data });
  } catch (error) {
    const messageText =
      error instanceof SteeringRequestError
        ? error.message
        : `Failed to steer task: ${error instanceof Error ? error.message : String(error)}`;
    return toolErr(messageText, { data: { yourAgentId: agentId } });
  }
}

export const registerSteerTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "steer-task",
    {
      title: "Steer Task",
      description:
        'Send a message to a task that is already running. `mode:"steer"` is honored on pi and claude-managed; claude, devin, opencode and codex support queue only (codex delivery lands at the next tool-call boundary via its lifecycle hooks). Pass `onUnsupported:"fail"` to get an error instead of a downgrade.',
      annotations: { destructiveHint: true },
      inputSchema: steerTaskInputSchema,
      outputSchema: steerTaskOutputSchema,
    },
    async (args, info, _meta) => steerTaskHandler(ownerCtx(info), args),
  );
};
