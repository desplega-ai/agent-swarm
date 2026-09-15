import { z } from "zod";

export const argsSchema = z.object({
  agentName: z.string().describe("Target agent's name (case-insensitive) — resolved to its id"),
  routingReason: z.enum(["skill", "continuity", "overflow", "human_pinned", "reroute_fault"]),
  routingNote: z.string().max(200).refine((note) => note.trim().length >= 10, {
    message: "routingNote must contain at least 10 characters after trim",
  }),
  task: z.string().describe("Full task prompt for the target agent"),
  parentTaskId: z
    .string()
    .optional()
    .describe("Your current task id — links the subtask as a child (recommended)"),
  priority: z.number().int().optional().describe("Task priority (higher = sooner)"),
  tags: z.array(z.string()).optional().describe("Tags for the created task"),
});

/** Delegate a task to a swarm agent by NAME — resolves name to id, sends the task, returns the created taskId. */
export default async function delegate(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "invalid args: " + parsed.error.message };
  const { agentName, task, routingReason, routingNote, parentTaskId, priority, tags } = parsed.data;

  const res: any = await ctx.swarm.swarm_get({ includeFull: true });
  const agents: any[] = res?.data?.agents ?? res?.agents ?? [];
  const agent = agents.find((a: any) => (a.name ?? "").toLowerCase() === agentName.toLowerCase());
  if (!agent) {
    return { ok: false, error: `agent '${agentName}' not found`, known: agents.map((a: any) => a.name) };
  }

  const sent: any = await ctx.swarm.task_send({
    agentId: agent.id,
    routingReason,
    routingNote,
    task,
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(priority != null ? { priority } : {}),
    ...(tags ? { tags } : {}),
  });
  const taskId = sent?.data?.task?.id ?? sent?.data?.id ?? sent?.id ?? null;
  return { ok: taskId != null, taskId, agentId: agent.id, agentName: agent.name };
}
