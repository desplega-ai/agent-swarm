import { z } from "zod";

export const argsSchema = z.object({
  parentTaskId: z.string().describe("Parent task id whose children to collect"),
  scanLimit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("How many recent tasks to scan for children (default 100)"),
});

/** List all child tasks of a parent with their status and output; returns {children, allDone} for fan-out aggregation. */
export default async function getChildOutputs(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const { parentTaskId, scanLimit = 100 } = parsed.data;

  // Slim task_list rows omit `parentTaskId` and `output`, so scan recent task
  // ids and hydrate each candidate via task_get (chunked to bound fan-out).
  const res: any = await ctx.swarm.task_list({ limit: scanLimit });
  const all: any[] = res?.data?.tasks ?? res?.tasks ?? (Array.isArray(res) ? res : []);
  const ids: string[] = all.map((t: any) => t.id).filter(Boolean);

  const children: any[] = [];
  const CHUNK = 10;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const details = await Promise.all(
      ids.slice(i, i + CHUNK).map((taskId) => ctx.swarm.task_get({ taskId })),
    );
    for (const d of details) {
      const t = d?.data ?? d ?? {};
      if (t.parentTaskId === parentTaskId) {
        children.push({
          id: t.id,
          status: t.status,
          agentId: t.agentId ?? null,
          output: t.output ?? null,
        });
      }
    }
  }

  return {
    children,
    allDone:
      children.length > 0 &&
      children.every((t: any) => ["completed", "failed", "cancelled"].includes(t.status)),
  };
}
