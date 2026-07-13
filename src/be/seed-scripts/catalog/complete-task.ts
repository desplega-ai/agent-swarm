import { z } from "zod";

export const argsSchema = z.object({
  taskId: z.string().describe("Your task id (not ambient — pass it explicitly)"),
  output: z.string().describe("Final output / result for the task"),
  status: z
    .enum(["completed", "failed"])
    .optional()
    .describe("Terminal status (default completed)"),
});

/** Mark a task completed (or failed) with its final output — the one-call way to finish an assigned task from a script. */
export default async function completeTask(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "invalid args: " + parsed.error.message };
  const { taskId, output, status = "completed" } = parsed.data;
  // The failed path reads `failureReason`, not `output` — forward the text to
  // both so the caller's explanation survives either way.
  await ctx.swarm.task_storeProgress({
    taskId,
    status,
    output,
    ...(status === "failed" ? { failureReason: output } : {}),
  });
  return { ok: true, taskId, status };
}
