import { z } from "zod";

export const argsSchema = z.object({
  taskId: z.string().describe("Task id to wait on (e.g. a subtask created via `delegate`)"),
  budgetSec: z
    .number()
    .positive()
    .optional()
    .describe("Max seconds to wait inside this call, capped at 25 (default 20)"),
});

/** Wait (bounded, max ~25s) for a task to reach a terminal state; returns {done, status, output} — call again while done=false. */
export default async function waitForTask(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { done: false, error: "invalid args: " + parsed.error.message };
  const { taskId, budgetSec = 20 } = parsed.data;

  // Scripts are hard-killed at ~30s — stay safely under, and let callers chain calls.
  const budgetMs = Math.min(budgetSec, 25) * 1000;
  const started = Date.now();
  let last: { status: string | null; output: string | null } | null = null;
  while (Date.now() - started < budgetMs) {
    const t: any = await ctx.swarm.task_get({ taskId });
    const d = t?.data ?? t ?? {};
    last = { status: d.status ?? null, output: d.output ?? null };
    if (["completed", "failed", "cancelled", "skipped"].includes(String(last.status))) {
      return { done: true, ...last };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { done: false, ...(last ?? {}), note: "budget exhausted — call wait-for-task again" };
}
