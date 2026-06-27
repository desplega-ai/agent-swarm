import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createToolRegistrar, ownerCtx, type ToolCtx } from "@swarm/mcp-tool";
import { getAllTasks } from "@swarm/storage";
import type { AgentTask, AgentTaskSummary } from "@swarm/types";
import { AgentTaskStatusSchema } from "@swarm/types";
import * as z from "zod";

const TaskSummarySchema = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  // Slim rows (default) carry `taskPreview` (~300 chars); `includeFull` rows
  // carry the full `task` text. Exactly one is present.
  task: z.string().optional(),
  taskPreview: z.string().optional(),
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

export const getTasksInputSchema = z.object({
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
  scheduleId: z
    .string()
    .uuid()
    .optional()
    .describe("Filter by schedule ID to find tasks created by a specific schedule."),
  includeHeartbeat: z
    .boolean()
    .optional()
    .describe("Include heartbeat/system tasks in results (excluded by default)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max tasks to return (default: 25, max: 100)."),
  includeFull: z
    .boolean()
    .optional()
    .describe("Return the full `task` text instead of a ~300-char `taskPreview`. Default false."),
});

export const getTasksOutputSchema = z.object({
  yourAgentId: z.string().uuid().optional(),
  tasks: z.array(TaskSummarySchema),
});

type GetTasksArgs = z.infer<typeof getTasksInputSchema>;

export async function getTasksHandler(
  ctx: ToolCtx,
  {
    status,
    mineOnly,
    unassigned,
    offeredToMe,
    readyOnly,
    taskType,
    tags,
    search,
    scheduleId,
    includeHeartbeat,
    limit,
    includeFull,
  }: GetTasksArgs,
): Promise<CallToolResult> {
  const agentId = ctx.kind === "owner" ? ctx.agentId : undefined;

  // Build filters. User context is hard-scoped by requestedByUserId and ignores
  // agent-specific shortcuts like mineOnly/offeredToMe.
  const taskFilters = {
    status,
    agentId: ctx.kind === "owner" && mineOnly ? (agentId ?? undefined) : undefined,
    unassigned: ctx.kind === "owner" ? unassigned : undefined,
    offeredTo: ctx.kind === "owner" && offeredToMe ? (agentId ?? undefined) : undefined,
    readyOnly,
    taskType,
    tags,
    search,
    scheduleId,
    includeHeartbeat,
    limit,
    requestedByUserId: ctx.kind === "user" ? ctx.userId : undefined,
  };
  // Default to slim rows (full `task` text → ~300-char `taskPreview`).
  const tasks: Array<AgentTask | AgentTaskSummary> = includeFull
    ? getAllTasks(taskFilters)
    : getAllTasks(taskFilters, { slim: true });

  // Slim rows carry a truncated `task`; surface it as `taskPreview` so the
  // agent knows it is truncated. `includeFull` returns the full `task`.
  const taskSummaries = tasks.map((t) => ({
    id: t.id,
    agentId: t.agentId,
    ...(includeFull ? { task: t.task } : { taskPreview: t.task }),
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
  if (ctx.kind === "owner" && mineOnly) filters.push("mine only");
  if (ctx.kind === "owner" && unassigned) filters.push("unassigned");
  if (ctx.kind === "owner" && offeredToMe) filters.push("offered to me");
  if (readyOnly) filters.push("ready only");
  if (taskType) filters.push(`type='${taskType}'`);
  if (tags?.length) filters.push(`tags=[${tags.join(", ")}]`);
  if (search) filters.push(`search='${search}'`);
  if (scheduleId) filters.push(`scheduleId='${scheduleId}'`);

  const filterMsg = filters.length > 0 ? ` (${filters.join(", ")})` : "";
  const structuredContent = {
    yourAgentId: agentId,
    tasks: taskSummaries,
  };

  return {
    content: [
      {
        type: "text",
        text: `Found ${taskSummaries.length} task(s)${filterMsg}.`,
      },
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
  };
}

export const registerGetTasksTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-tasks",
    {
      title: "Get tasks",
      description:
        "Returns a list of tasks in the swarm with various filters. Sorted by priority (desc) then lastUpdatedAt (desc). Each row carries a `taskPreview` (~300 chars) — enough to pool-triage; pass includeFull:true (or call `get-task-details` by id) for the full `task` text.",
      annotations: { readOnlyHint: true },
      inputSchema: getTasksInputSchema,
      outputSchema: getTasksOutputSchema,
    },
    async (args, info, _meta) => getTasksHandler(ownerCtx(info), args),
  );
};
