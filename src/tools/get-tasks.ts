import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAllTasks } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskStatusSchema } from "@/types";

const TaskSummarySchema = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  task: z.string(),
  status: AgentTaskStatusSchema,
  taskType: z.string().optional(),
  tags: z.array(z.string()),
  priority: z.number(),
  dependsOn: z.array(z.string()),
  offeredTo: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  finishedAt: z.string().optional(),
  progress: z.string().optional(),
});

export const registerGetTasksTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-tasks",
    {
      title: "Get tasks",
      description:
        "Returns a list of tasks in the swarm with various filters. Sorted by priority (desc) then lastUpdatedAt (desc).",
      inputSchema: z.object({
        status: AgentTaskStatusSchema.optional().describe(
          "Filter by task status (unassigned, offered, pending, in_progress, completed, failed).",
        ),
        mineOnly: z.boolean().optional().describe("Only return tasks assigned to you."),
        unassigned: z.boolean().optional().describe("Only return unassigned tasks in the pool."),
        offeredToMe: z
          .boolean()
          .optional()
          .describe("Only return tasks offered to you (awaiting accept/reject)."),
        readyOnly: z.boolean().optional().describe("Only return tasks whose dependencies are met."),
        taskType: z.string().optional().describe("Filter by task type (e.g., 'bug', 'feature')."),
        tags: z.array(z.string()).optional().describe("Filter by any matching tag."),
        search: z.string().optional().describe("Search in task description."),
      }),
      outputSchema: z.object({
        tasks: z.array(TaskSummarySchema),
      }),
    },
    async (
      { status, mineOnly, unassigned, offeredToMe, readyOnly, taskType, tags, search },
      requestInfo,
      _meta,
    ) => {
      const agentId = requestInfo.agentId;

      // Build filters
      const tasks = getAllTasks({
        status,
        agentId: mineOnly ? (agentId ?? undefined) : undefined,
        unassigned,
        offeredTo: offeredToMe ? (agentId ?? undefined) : undefined,
        readyOnly,
        taskType,
        tags,
        search,
      });

      const taskSummaries = tasks.map((t) => ({
        id: t.id,
        agentId: t.agentId,
        task: t.task,
        status: t.status,
        taskType: t.taskType,
        tags: t.tags,
        priority: t.priority,
        dependsOn: t.dependsOn,
        offeredTo: t.offeredTo,
        createdAt: t.createdAt,
        lastUpdatedAt: t.lastUpdatedAt,
        finishedAt: t.finishedAt,
        progress: t.progress,
      }));

      // Build filter description for message
      const filters: string[] = [];
      if (status) filters.push(`status='${status}'`);
      if (mineOnly) filters.push("mine only");
      if (unassigned) filters.push("unassigned");
      if (offeredToMe) filters.push("offered to me");
      if (readyOnly) filters.push("ready only");
      if (taskType) filters.push(`type='${taskType}'`);
      if (tags?.length) filters.push(`tags=[${tags.join(", ")}]`);
      if (search) filters.push(`search='${search}'`);

      const filterMsg = filters.length > 0 ? ` (${filters.join(", ")})` : "";

      return {
        content: [
          {
            type: "text",
            text: `Found ${taskSummaries.length} task(s)${filterMsg}.`,
          },
        ],
        structuredContent: {
          yourAgentId: agentId,
          tasks: taskSummaries,
        },
      };
    },
  );
};
