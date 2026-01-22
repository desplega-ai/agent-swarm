import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createTaskExtended,
  getActiveTaskCount,
  getAgentById,
  getDb,
  getEpicById,
  hasCapacity,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

export const registerSendTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "send-task",
    {
      title: "Send a task",
      description:
        "Sends a task to a specific agent, creates an unassigned task for the pool, or offers a task for acceptance.",
      inputSchema: z.object({
        agentId: z
          .uuid()
          .optional()
          .describe("The agent to assign/offer task to. Omit to create unassigned task for pool."),
        task: z.string().min(1).describe("The task description to send."),
        offerMode: z
          .boolean()
          .default(false)
          .describe("If true, offer the task instead of direct assign (agent must accept/reject)."),
        taskType: z
          .string()
          .max(50)
          .optional()
          .describe("Task type (e.g., 'bug', 'feature', 'review')."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags for filtering (e.g., ['urgent', 'frontend'])."),
        priority: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Priority 0-100 (default: 50)."),
        dependsOn: z.array(z.uuid()).optional().describe("Task IDs this task depends on."),
        epicId: z.string().uuid().optional().describe("Epic to associate this task with."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
      }),
    },
    async (
      { agentId, task, offerMode, taskType, tags, priority, dependsOn, epicId },
      requestInfo,
      _meta,
    ) => {
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

      if (agentId === requestInfo.agentId) {
        return {
          content: [
            {
              type: "text",
              text: "Cannot send a task to yourself, are you drunk?",
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Cannot send a task to yourself, are you drunk?",
          },
        };
      }

      // Validate epicId if provided
      if (epicId) {
        const epic = getEpicById(epicId);
        if (!epic) {
          return {
            content: [{ type: "text", text: `Epic not found: ${epicId}` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Epic not found: ${epicId}`,
            },
          };
        }
      }

      const txn = getDb().transaction(() => {
        // Build tags with epic tag if epicId is provided
        const finalTags = epicId ? [...(tags || []), `epic:${getEpicById(epicId)?.name}`] : tags;

        // If no agentId, create an unassigned task for the pool
        if (!agentId) {
          const newTask = createTaskExtended(task, {
            creatorAgentId: requestInfo.agentId,
            taskType,
            tags: finalTags,
            priority,
            dependsOn,
            epicId,
          });

          return {
            success: true,
            message: `Created unassigned task "${newTask.id}" in the pool.`,
            task: newTask,
          };
        }

        const agent = getAgentById(agentId);

        if (!agent) {
          return {
            success: false,
            message: `Agent with ID "${agentId}" not found.`,
          };
        }

        if (agent.isLead) {
          return {
            success: false,
            message: `Cannot assign tasks to the lead agent "${agent.name}", wtf?`,
          };
        }

        // For direct assignment (not offer), check if agent has capacity
        if (!offerMode && !hasCapacity(agentId)) {
          const activeCount = getActiveTaskCount(agentId);
          return {
            success: false,
            message: `Agent "${agent.name}" is at capacity (${activeCount}/${agent.maxTasks ?? 1} tasks). Use offerMode: true to offer the task instead, or wait for a task to complete.`,
          };
        }

        if (offerMode) {
          // Offer the task to the agent (they must accept/reject)
          const newTask = createTaskExtended(task, {
            offeredTo: agentId,
            creatorAgentId: requestInfo.agentId,
            taskType,
            tags: finalTags,
            priority,
            dependsOn,
            epicId,
          });

          return {
            success: true,
            message: `Task "${newTask.id}" offered to agent "${agent.name}". They must accept or reject it.`,
            task: newTask,
          };
        }

        // Direct assignment
        const newTask = createTaskExtended(task, {
          agentId,
          creatorAgentId: requestInfo.agentId,
          taskType,
          tags: finalTags,
          priority,
          dependsOn,
          epicId,
        });

        return {
          success: true,
          message: `Task "${newTask.id}" sent to agent "${agent.name}".`,
          task: newTask,
        };
      });

      const result = txn();

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
