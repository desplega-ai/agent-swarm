import { z } from "zod";

export const argsSchema = z.object({
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Look back this many days (default 7)"),
  failureThreshold: z
    .number()
    .optional()
    .describe("Flag schedules with failure rate above this (0-1, default 0.2)"),
});

/** Per-schedule health check: failure rates and flagging unhealthy schedules. */
export default async function scheduleHealth(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const days = parsed.data.days || 7;
  const threshold = parsed.data.failureThreshold ?? 0.2;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Get schedules
  const schedRes: any = await ctx.swarm.schedule_list({});
  const schedPayload = schedRes?.data ?? schedRes;
  const schedules: any[] = schedPayload?.schedules ?? [];

  if (!schedules.length) return { days, schedules: [], flagged: [] };

  // Get recent tasks to correlate with schedules
  const taskRes: any = await ctx.swarm.task_list({ createdAfter: since, limit: 2000 });
  const taskPayload = taskRes?.data ?? taskRes;
  const tasks: any[] = taskPayload?.tasks ?? [];

  // Group by scheduleId
  const bySchedule = new Map<string, { total: number; failed: number; completed: number }>();
  for (const t of tasks) {
    if (!t.scheduleId) continue;
    const entry = bySchedule.get(t.scheduleId) ?? { total: 0, failed: 0, completed: 0 };
    entry.total++;
    if (t.status === "failed") entry.failed++;
    if (t.status === "completed") entry.completed++;
    bySchedule.set(t.scheduleId, entry);
  }

  const results = schedules.map((s: any) => {
    const stats = bySchedule.get(s.id) ?? { total: 0, failed: 0, completed: 0 };
    const failureRate = stats.total > 0 ? stats.failed / stats.total : 0;
    return {
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      targetAgentId: s.targetAgentId,
      runs: stats.total,
      failed: stats.failed,
      completed: stats.completed,
      failureRate: Math.round(failureRate * 1000) / 1000,
      flagged: stats.total >= 3 && failureRate > threshold,
    };
  });

  const flagged = results.filter((r: any) => r.flagged);

  return {
    days,
    threshold,
    totalSchedules: schedules.length,
    flaggedCount: flagged.length,
    schedules: results.sort((a: any, b: any) => b.failureRate - a.failureRate),
    flagged,
  };
}
