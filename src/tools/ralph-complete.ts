import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { completeTask, getTaskById } from "@/be/db";
import { clearCheckpoint, writeCheckpoint } from "@/ralph/state";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

export const registerRalphCompleteTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "ralph-complete",
    {
      title: "Complete Ralph task",
      description:
        "Signal completion of a Ralph iterative task with evidence that the completion promise was met.",
      inputSchema: z.object({
        taskId: z.uuid().describe("The ID of the Ralph task to complete"),
        summary: z.string().min(10).describe("Summary of what was accomplished"),
        promiseEvidence: z
          .string()
          .min(10)
          .describe("Evidence that the completion promise was met"),
        artifactPaths: z
          .array(z.string())
          .optional()
          .describe("Key artifact paths created/modified"),
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

      const task = getTaskById(taskId);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task with ID "${taskId}" not found.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Task with ID "${taskId}" not found.`,
          },
        };
      }

      // Verify this is a Ralph task
      if (task.taskType !== "ralph") {
        return {
          content: [
            {
              type: "text",
              text: `Task "${taskId}" is not a Ralph task (taskType: ${task.taskType || "none"}).`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Task "${taskId}" is not a Ralph task (taskType: ${task.taskType || "none"}).`,
          },
        };
      }

      // Verify task is assigned to this agent
      if (task.agentId !== requestInfo.agentId) {
        return {
          content: [{ type: "text", text: `Task "${taskId}" is not assigned to you.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Task "${taskId}" is not assigned to you.`,
          },
        };
      }

      // Verify task is in progress
      if (task.status !== "in_progress") {
        return {
          content: [
            { type: "text", text: `Task "${taskId}" is not in progress (status: ${task.status}).` },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Task "${taskId}" is not in progress (status: ${task.status}).`,
          },
        };
      }

      // Build completion output
      const output = JSON.stringify(
        {
          summary,
          promiseEvidence,
          artifactPaths: artifactPaths || [],
          ralphPromise: task.ralphPromise,
          iterations: task.ralphIterations,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      );

      // Write completion checkpoint so runner knows to stop
      await writeCheckpoint({
        taskId,
        iteration: task.ralphIterations || 0,
        contextFull: false,
        timestamp: new Date().toISOString(),
        checkpointReason: "manual", // Signals intentional completion
      });

      // Complete the task
      const completedTask = completeTask(taskId, output);
      if (!completedTask) {
        return {
          content: [{ type: "text", text: `Failed to complete task "${taskId}".` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to complete task "${taskId}".`,
          },
        };
      }

      // Clear the checkpoint file
      await clearCheckpoint(taskId);

      const message = `Ralph task "${taskId}" completed successfully after ${task.ralphIterations || 0} iterations.`;

      return {
        content: [{ type: "text", text: message }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message,
          task: completedTask,
        },
      };
    },
  );
};
