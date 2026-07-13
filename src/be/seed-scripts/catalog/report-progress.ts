import { z } from "zod";

export const argsSchema = z.object({
  taskId: z.string().describe("Your task id (not ambient — pass it explicitly)"),
  note: z.string().describe("Short progress note (what you did / what's next)"),
});

/** Post an in-progress note on a task without changing its terminal state. */
export default async function reportProgress(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "invalid args: " + parsed.error.message };
  const { taskId, note } = parsed.data;
  // Non-terminal updates persist the `progress` field; `output` is ignored until completion.
  await ctx.swarm.task_storeProgress({ taskId, status: "in_progress", progress: note });
  return { ok: true };
}
