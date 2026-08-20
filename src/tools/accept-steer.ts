import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getSteeringMessageById, getTaskById, markSteeringHandled } from "@/be/db";
import { assertOwnsTask, ownerCtx, type ToolCtx } from "@/tools/task-tool-ctx";
import {
  createToolRegistrar,
  type SwarmToolResult,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";
import type { SteeringMessage } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";

export const acceptSteerInputSchema = z.object({
  steeringMessageId: z.uuid().describe("The steering message ID to acknowledge."),
  note: z
    .string()
    .max(500)
    .optional()
    .describe("Optional short note describing how the steering was incorporated."),
});

const looseSteeringMessageSchema = z.looseObject({
  id: z.string().optional(),
  taskId: z.string().optional(),
  body: z.string().optional(),
  mode: z.string().optional(),
  status: z.string().optional(),
  deliveredMode: z.string().optional(),
  source: z.string().optional(),
  createdByKind: z.string().optional(),
  createdByUserId: z.string().optional(),
  createdByAgentId: z.string().optional(),
  promotedTaskId: z.string().optional(),
  createdAt: z.string().optional(),
  deliveredAt: z.string().optional(),
  handledAt: z.string().optional(),
  handledNote: z.string().optional(),
});

export const acceptSteerOutputSchema = swarmToolOutputSchema({
  // Plain string, NOT .uuid(): agents may join with custom IDs (AGENT_ID env /
  // join-swarm agentId), and a UUID constraint here makes the acknowledgement
  // response fail output validation after the write already applied.
  yourAgentId: z.string().optional(),
  steeringMessage: looseSteeringMessageSchema.optional(),
});

type AcceptSteerArgs = z.infer<typeof acceptSteerInputSchema>;

/**
 * MCP tools run inside the API server, which owns the DB (see CLAUDE.md's
 * architecture invariants) — so this reads and writes directly rather than
 * looping back over HTTP. The earlier HTTP round-trip resolved its own server
 * through `MCP_BASE_URL`, which points at the *public* origin in most
 * deployments; acknowledgement then hit the wrong swarm and 404'd.
 *
 * Authorization derives the task from the steering message itself, so the
 * caller does not need to supply (or match) `X-Source-Task-Id`.
 */
export async function acceptSteerHandler(
  ctx: ToolCtx,
  { steeringMessageId, note }: AcceptSteerArgs,
): Promise<SwarmToolResult> {
  if (ctx.kind !== "owner" || !ctx.agentId) {
    return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
  }

  const steering = await getSteeringMessageById(steeringMessageId);
  if (!steering) {
    return toolErr(`Steering message "${steeringMessageId}" not found.`, {
      data: { yourAgentId: ctx.agentId },
    });
  }

  const task = await getTaskById(steering.taskId);
  if (!task) {
    return toolErr(`Task "${steering.taskId}" for this steering message no longer exists.`, {
      data: { yourAgentId: ctx.agentId },
    });
  }

  // Assignment is the real authorization for acknowledgement: only the agent
  // actually running the task may say it acted on the message. `assertOwnsTask`
  // alone is not enough — it routes through RBAC, which grants-all under the
  // default legacy policy, so this check must be explicit.
  if (task.agentId !== ctx.agentId) {
    return toolErr(
      `Forbidden: steering message "${steeringMessageId}" belongs to a task assigned to another agent.`,
      { data: { yourAgentId: ctx.agentId } },
    );
  }

  const ownershipError = assertOwnsTask(ctx, task, "task.read.own");
  if (ownershipError) return ownershipError;

  // Idempotent: re-acknowledging an already-handled message is a success, so a
  // retrying agent doesn't get an error it will try to "fix".
  if (steering.status === "handled") {
    const message = `Steering message "${steeringMessageId}" was already acknowledged.`;
    const data = {
      yourAgentId: ctx.agentId,
      steeringMessage: steering satisfies SteeringMessage,
    };
    return toolOk(message, { details: JSON.stringify(data), data });
  }

  const safeNote = note ? scrubSecrets(note) : undefined;
  const updated = await markSteeringHandled(steeringMessageId, safeNote);
  if (!updated) {
    return toolErr(`Steering message cannot be acknowledged from status "${steering.status}".`, {
      data: { yourAgentId: ctx.agentId },
    });
  }

  const message = safeNote
    ? `Steering message "${steeringMessageId}" acknowledged as handled. Note: ${safeNote}`
    : `Steering message "${steeringMessageId}" acknowledged as handled.`;
  const data = {
    yourAgentId: ctx.agentId,
    steeringMessage: updated satisfies SteeringMessage,
  };
  return toolOk(message, { details: JSON.stringify(data), data });
}

export const registerAcceptSteerTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "accept-steer",
    {
      title: "Accept Steering",
      description:
        "Acknowledge a live steering message after you have incorporated it into your current task. Pass the ID from the `[steering <id>]` marker on the message.",
      annotations: { destructiveHint: false },
      inputSchema: acceptSteerInputSchema,
      outputSchema: acceptSteerOutputSchema,
    },
    async (args, info, _meta) => acceptSteerHandler(ownerCtx(info), args),
  );
};
