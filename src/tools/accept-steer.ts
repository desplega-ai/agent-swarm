import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { assertOwnsTask, ownerCtx, type ToolCtx } from "@/tools/task-tool-ctx";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema, type SteeringMessage, SteeringMessageSchema } from "@/types";
import { getApiKey } from "@/utils/api-key";
import { getMcpBaseUrl } from "@/utils/constants";
import { scrubSecrets } from "@/utils/secret-scrubber";

export const acceptSteerInputSchema = z.object({
  steeringMessageId: z.uuid().describe("The steering message ID to acknowledge."),
  note: z
    .string()
    .max(500)
    .optional()
    .describe("Optional short note describing how the steering was incorporated."),
});

export const acceptSteerOutputSchema = z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  steeringMessage: SteeringMessageSchema.optional(),
});

type AcceptSteerArgs = z.infer<typeof acceptSteerInputSchema>;

function errorResult(message: string, agentId?: string): CallToolResult {
  const safeMessage = scrubSecrets(message);
  return {
    isError: true,
    content: [{ type: "text", text: safeMessage }],
    structuredContent: {
      yourAgentId: agentId,
      success: false,
      message: safeMessage,
    },
  };
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // The fallback includes the status without echoing an untrusted response body.
  }
  return fallback;
}

export async function acceptSteerHandler(
  ctx: ToolCtx,
  { steeringMessageId, note }: AcceptSteerArgs,
): Promise<CallToolResult> {
  if (ctx.kind !== "owner" || !ctx.agentId) {
    return errorResult('Agent ID not found. Set the "X-Agent-ID" header.');
  }
  if (!ctx.sourceTaskId) {
    return errorResult('Source task ID not found. Set the "X-Source-Task-Id" header.', ctx.agentId);
  }

  const apiUrl = getMcpBaseUrl();
  const apiKey = getApiKey();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "X-Agent-ID": ctx.agentId,
  };

  try {
    const taskResponse = await fetch(
      `${apiUrl}/api/tasks/${encodeURIComponent(ctx.sourceTaskId)}`,
      { headers },
    );
    if (!taskResponse.ok) {
      const error = await responseError(
        taskResponse,
        `Task lookup failed (HTTP ${taskResponse.status}).`,
      );
      return errorResult(error, ctx.agentId);
    }

    const parsedTask = AgentTaskSchema.safeParse(await taskResponse.json());
    if (!parsedTask.success) {
      return errorResult("Task lookup returned an invalid response.", ctx.agentId);
    }
    const ownershipError = assertOwnsTask(ctx, parsedTask.data, "task.read.own");
    if (ownershipError) return ownershipError;

    const response = await fetch(
      `${apiUrl}/api/steering-messages/${encodeURIComponent(steeringMessageId)}/handled`,
      {
        method: "POST",
        headers,
      },
    );
    if (!response.ok) {
      const error = await responseError(
        response,
        `Steering acknowledgement failed (HTTP ${response.status}).`,
      );
      return errorResult(error, ctx.agentId);
    }

    const parsed = z.object({ message: SteeringMessageSchema }).safeParse(await response.json());
    if (!parsed.success) {
      return errorResult("Steering acknowledgement returned an invalid response.", ctx.agentId);
    }
    if (parsed.data.message.status !== "handled") {
      return errorResult(
        `Steering message cannot be acknowledged from status "${parsed.data.message.status}".`,
        ctx.agentId,
      );
    }

    const safeNote = note ? scrubSecrets(note) : undefined;
    const message = safeNote
      ? `Steering message "${steeringMessageId}" acknowledged as handled. Note: ${safeNote}`
      : `Steering message "${steeringMessageId}" acknowledged as handled.`;
    const structuredContent = {
      yourAgentId: ctx.agentId,
      success: true,
      message,
      steeringMessage: parsed.data.message satisfies SteeringMessage,
    };
    return {
      content: [
        { type: "text", text: message },
        { type: "text", text: JSON.stringify(structuredContent) },
      ],
      structuredContent,
    };
  } catch (error) {
    return errorResult(`Steering acknowledgement failed: ${(error as Error).message}`, ctx.agentId);
  }
}

export const registerAcceptSteerTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "accept-steer",
    {
      title: "Accept Steering",
      description:
        "Acknowledge a live steering message after you have incorporated it into your current task.",
      annotations: { destructiveHint: false },
      inputSchema: acceptSteerInputSchema,
      outputSchema: acceptSteerOutputSchema,
    },
    async (args, info, _meta) => acceptSteerHandler(ownerCtx(info), args),
  );
};
