import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createApprovalRequest, getAgentCurrentTask } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

const QuestionSchema = z.object({
  id: z.string().describe("Unique ID for the question (used as key in responses)"),
  type: z
    .enum(["approval", "text", "single-select", "multi-select", "boolean"])
    .describe("Question type"),
  label: z.string().describe("The question text displayed to the user"),
  required: z.boolean().optional().describe("Whether this question is required (default: true)"),
  description: z.string().optional().describe("Optional help text"),
  placeholder: z.string().optional().describe("Placeholder text (for text type)"),
  multiline: z.boolean().optional().describe("Use textarea instead of input (for text type)"),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional()
    .describe("Options (for single-select/multi-select types)"),
  minSelections: z.number().int().min(0).optional().describe("Min selections (for multi-select)"),
  maxSelections: z.number().int().min(1).optional().describe("Max selections (for multi-select)"),
  defaultValue: z.boolean().optional().describe("Default value (for boolean type)"),
});

export const registerRequestHumanInputTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "request-human-input",
    {
      title: "Request human input",
      annotations: { destructiveHint: false },
      description:
        "Create an approval request that pauses until a human responds. " +
        "Supports multiple question types: approval (yes/no), text, single-select, " +
        "multi-select, and boolean. Returns the request ID and URL for the human to respond.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Title of the approval request"),
        questions: z.array(QuestionSchema).min(1).describe("Questions to ask the human"),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Timeout in seconds (auto-rejects on timeout)"),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        requestId: z.string().uuid().optional(),
        url: z.string().optional(),
      }),
    },
    async ({ title, questions, timeoutSeconds }, requestInfo) => {
      if (!requestInfo.agentId) {
        return {
          content: [
            {
              type: "text",
              text: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
          },
        };
      }

      // Resolve sourceTaskId: prefer header, fall back to agent's current in-progress task.
      // The X-Source-Task-Id header may be missing when the per-session MCP config wasn't
      // created (e.g. .mcp.json not found, session resumed, or lead agent on a non-task trigger).
      let sourceTaskId = requestInfo.sourceTaskId;
      if (!sourceTaskId && requestInfo.agentId) {
        const currentTask = getAgentCurrentTask(requestInfo.agentId);
        if (currentTask) {
          sourceTaskId = currentTask.id;
        }
      }

      const id = crypto.randomUUID();
      const request = createApprovalRequest({
        id,
        title,
        questions,
        approvers: { policy: "any" },
        sourceTaskId: sourceTaskId ?? undefined,
        timeoutSeconds,
      });

      const appUrl = process.env.APP_URL || "http://localhost:5274";
      const url = `${appUrl}/approval-requests/${request.id}`;

      return {
        content: [
          {
            type: "text",
            text: `Created approval request "${id}". Human can respond at: ${url}`,
          },
        ],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Approval request created. Respond at: ${url}`,
          requestId: request.id,
          url,
        },
      };
    },
  );
};
