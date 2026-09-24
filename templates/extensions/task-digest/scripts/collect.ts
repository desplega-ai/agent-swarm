import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

export const argsSchema = z.object({
  hours: z
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .optional()
    .describe("Look back this many hours (default 24)"),
});

type TaskRow = { agentId?: string | null };
type SdkResult = { success?: boolean; status?: number; data?: { tasks?: TaskRow[] } };

async function listTasks(
  ctx: ScriptContext,
  status: "completed" | "failed",
  since: string,
): Promise<TaskRow[]> {
  const res = (await ctx.swarm.task_list({
    status,
    createdAfter: since,
    limit: 500,
  })) as SdkResult;
  if (res?.success === false) throw new Error(`task_list ${status} failed (${res.status})`);
  return Array.isArray(res?.data?.tasks) ? res.data.tasks : [];
}

/** Count tasks completed and failed in the last N hours, grouped by agent. */
export default async function collect(args: z.input<typeof argsSchema>, ctx: ScriptContext) {
  const parsed = argsSchema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `invalid args: ${parsed.error.message}` };
  const hours = parsed.data.hours ?? 24;
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();

  const completed = await listTasks(ctx, "completed", since);
  const failed = await listTasks(ctx, "failed", since);

  const byAgent: Record<string, { completed: number; failed: number }> = {};
  for (const [status, tasks] of [
    ["completed", completed],
    ["failed", failed],
  ] as const) {
    for (const task of tasks) {
      const agent = task.agentId || "(unassigned)";
      byAgent[agent] ??= { completed: 0, failed: 0 };
      byAgent[agent][status]++;
    }
  }

  return {
    ok: true,
    since,
    completed: completed.length,
    failed: failed.length,
    byAgent,
    summary: `${completed.length} completed, ${failed.length} failed in the last ${hours}h`,
  };
}
