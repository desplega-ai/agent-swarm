import { z } from "zod";

export const argsSchema = z.object({
  taskId: z.string().describe("Task ID to fetch details for"),
  queries: z
    .array(z.string())
    .min(1)
    .describe("Search queries from the task description — 2-4 recommended"),
  scope: z
    .enum(["all", "agent", "swarm"])
    .optional()
    .describe("Memory scope filter (default all)"),
  memoryLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max memories per query before dedup (default 8)"),
});

function slimTask(task: any) {
  if (!task || typeof task !== "object") return null;
  return {
    id: task.id,
    status: task.status,
    description: task.task,
    dependsOn: task.dependsOn,
    slackChannelId: task.slackChannelId,
    slackThreadTs: task.slackThreadTs,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    agentId: task.agentId,
    output: task.output,
    failureReason: task.failureReason,
  };
}

/** Fetch slim task details plus deduped multi-query memories for task onboarding. */
export default async function taskContextGathering(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const { taskId, queries, scope = "all", memoryLimit = 8 } = parsed.data;

  const taskRes: any = await ctx.swarm.task_get({ taskId });
  const taskPayload = taskRes?.data ?? taskRes;
  if (taskPayload?.success === false) {
    return { error: taskPayload.message ?? "task_get failed", taskId };
  }

  const allResults: any[] = [];
  for (const query of queries) {
    const res: any = await ctx.swarm.memory_search({ query, scope, limit: memoryLimit });
    const payload = res?.data ?? res;
    const results = payload?.results ?? [];
    for (const memory of results) {
      allResults.push({ ...memory, querySource: query });
    }
  }

  const byId = new Map<string, any>();
  const hitCounts = new Map<string, number>();
  for (const memory of allResults) {
    const id = typeof memory.id === "string" ? memory.id : JSON.stringify(memory);
    hitCounts.set(id, (hitCounts.get(id) ?? 0) + 1);
    const existing = byId.get(id);
    const similarity = typeof memory.similarity === "number" ? memory.similarity : 0;
    const existingSimilarity =
      existing && typeof existing.similarity === "number" ? existing.similarity : -Infinity;
    if (!existing || similarity > existingSimilarity) byId.set(id, memory);
  }

  const memories = Array.from(byId.entries()).map(([id, memory]) => {
    const hits = hitCounts.get(id) ?? 1;
    const similarity = typeof memory.similarity === "number" ? memory.similarity : 0;
    return {
      ...memory,
      hits,
      compositeScore: similarity + 0.05 * hits,
    };
  });
  memories.sort((a: any, b: any) => b.compositeScore - a.compositeScore);

  return {
    task: slimTask(taskPayload?.task),
    requestedBy: taskPayload?.requestedBy,
    attachments: taskPayload?.attachments ?? [],
    queriesRun: queries.length,
    totalCandidates: allResults.length,
    uniqueMemories: memories.length,
    memories: memories.slice(0, memoryLimit * 2),
  };
}
