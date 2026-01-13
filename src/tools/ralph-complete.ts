import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { completeTask, getAgentById, getDb, getTaskById, updateAgentStatus } from "@/be/db";
import { clearCheckpoint } from "@/ralph/state";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

export const registerRalphCompleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "ralph-complete",
    {
      title: "Complete Ralph task",
      description:
        "Signal completion of a Ralph-type iterative task with evidence that the completion promise was met. Only works for tasks with taskType='ralph'.",
      inputSchema: z.object({
        taskId: z.uuid().describe("The ID of the Ralph task to complete."),
        summary: z.string().min(10).describe("Summary of what was accomplished (min 10 chars)."),
        promiseEvidence: z
          .string()
          .min(10)
          .describe("Evidence that the completion promise was met (min 10 chars)."),
        artifactPaths: z
          .array(z.string())
          .optional()
          .describe("Key artifact paths created/modified during the task."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
      }),
    },
    async ({ taskId, summary, promiseEvidence, artifactPaths }, requestInfo, _meta) => {
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

      const txn = getDb().transaction(() => {
        const agent = getAgentById(requestInfo.agentId ?? "");

        if (!agent) {
          return {
            success: false,
            message: `Agent with ID "${requestInfo.agentId}" not found in the swarm.`,
          };
        }

        const existingTask = getTaskById(taskId);

        if (!existingTask) {
          return {
            success: false,
            message: `Task with ID "${taskId}" not found.`,
          };
        }

        // Validate this is a Ralph task
        if (existingTask.taskType !== "ralph") {
          return {
            success: false,
            message: `Task "${taskId}" is not a Ralph task (taskType="${existingTask.taskType}"). ralph-complete only works for Ralph tasks.`,
          };
        }

        // Validate the task is assigned to this agent
        if (existingTask.agentId !== requestInfo.agentId) {
          return {
            success: false,
            message: `Task "${taskId}" is not assigned to you. Only the assigned agent can complete a Ralph task.`,
          };
        }

        // Validate the task is in progress
        if (existingTask.status !== "in_progress") {
          return {
            success: false,
            message: `Task "${taskId}" is not in progress (status="${existingTask.status}"). Cannot complete a task that is not being worked on.`,
          };
        }

        // Build structured output
        const structuredOutput = {
          summary,
          promiseEvidence,
          artifactPaths: artifactPaths ?? [],
          iterations: existingTask.ralphIterations ?? 0,
          completedAt: new Date().toISOString(),
        };

        // Complete the task
        const result = completeTask(taskId, JSON.stringify(structuredOutput, null, 2));

        if (result) {
          // Set agent back to idle
          updateAgentStatus(requestInfo.agentId, "idle");

          return {
            success: true,
            message: `Ralph task "${taskId}" completed successfully after ${structuredOutput.iterations} iterations.`,
            task: result,
          };
        }

        return {
          success: false,
          message: `Failed to complete task "${taskId}".`,
        };
      });

      const result = txn();

      // Clear any checkpoint file outside transaction (async operation)
      if (result.success) {
        await clearCheckpoint(taskId);
      }

      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          ...result,
        },
      };
    },
  );
};
