import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  completeTask,
  getAgentById,
  getDb,
  getTaskById,
  updateAgentStatusFromCapacity,
} from "@/be/db";
import { clearCheckpoint } from "@/ralph/state";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

/**
 * Register the ralph-complete tool for agents to signal Ralph task completion.
 *
 * This tool allows agents working on Ralph (iterative) tasks to signal that
 * they have successfully fulfilled the completion promise. The tool validates
 * that the task is a Ralph task and that the caller is the assigned agent.
 */
export const registerRalphCompleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "ralph-complete",
    {
      title: "Complete a Ralph task",
      description:
        "Signal completion of a Ralph (iterative) task. Use this when you have fulfilled the task's completion promise. Only works for tasks with taskType='ralph'.",
      inputSchema: z.object({
        taskId: z.uuid().describe("The ID of the Ralph task to complete."),
        summary: z
          .string()
          .min(10)
          .describe("Summary of what was accomplished (min 10 chars)."),
        promiseEvidence: z
          .string()
          .min(10)
          .describe("Evidence that the completion promise was met (min 10 chars)."),
        artifactPaths: z
          .array(z.string())
          .optional()
          .describe("Optional list of key artifact paths created during the task."),
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

        const task = getTaskById(taskId);

        if (!task) {
          return {
            success: false,
            message: `Task with ID "${taskId}" not found.`,
          };
        }

        // Validate this is a Ralph task
        if (task.taskType !== "ralph") {
          return {
            success: false,
            message: `Task "${taskId}" is not a Ralph task (taskType=${task.taskType ?? "undefined"}). Use store-progress instead.`,
          };
        }

        // Validate caller is the assigned agent
        if (task.agentId !== requestInfo.agentId) {
          return {
            success: false,
            message: `Task "${taskId}" is not assigned to you. Assigned to: ${task.agentId ?? "none"}.`,
          };
        }

        // Validate task is in progress
        if (task.status !== "in_progress") {
          return {
            success: false,
            message: `Task "${taskId}" is not in progress (status=${task.status}).`,
          };
        }

        // Build structured output
        const output = JSON.stringify(
          {
            summary,
            promiseEvidence,
            artifactPaths: artifactPaths ?? [],
            ralphIterations: task.ralphIterations,
            ralphPromise: task.ralphPromise,
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        );

        // Complete the task
        const result = completeTask(taskId, output);

        if (!result) {
          return {
            success: false,
            message: `Failed to complete task "${taskId}".`,
          };
        }

        // Update agent status based on capacity
        updateAgentStatusFromCapacity(requestInfo.agentId ?? "");

        return {
          success: true,
          message: `Ralph task "${taskId}" completed successfully after ${task.ralphIterations} iteration(s).`,
          task: result,
        };
      });

      const result = txn();

      // Clear checkpoint file if task was completed (outside transaction for async)
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
