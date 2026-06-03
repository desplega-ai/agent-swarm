import { z } from "zod";

export const argsSchema = z.object({
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Look back this many days (default 3)"),
  includeToolUsage: z.boolean().optional().describe("Include tool usage histogram (default true)"),
  includeScheduleHealth: z
    .boolean()
    .optional()
    .describe("Include schedule health flags (default true)"),
  includeMemoryHealth: z
    .boolean()
    .optional()
    .describe("Include memory health stats (default true)"),
});

/** Daily compounding insights — compressed JSON for Phase 0 evolution. */
export default async function compoundInsights(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const days = parsed.data.days || 3;
  const includeToolUsage = parsed.data.includeToolUsage !== false;
  const includeScheduleHealth = parsed.data.includeScheduleHealth !== false;
  const includeMemoryHealth = parsed.data.includeMemoryHealth !== false;

  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Task summary
  const taskRes: any = await ctx.swarm.task_list({ createdAfter: since, limit: 2000 });
  const taskPayload = taskRes?.data ?? taskRes;
  const tasks: any[] = taskPayload?.tasks ?? [];

  const statusCounts: Record<string, number> = {};
  const failureClusters: Record<string, number> = {};
  for (const t of tasks) {
    statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
    if (t.status === "failed" && t.failureReason) {
      const reason = String(t.failureReason).slice(0, 60).toLowerCase();
      failureClusters[reason] = (failureClusters[reason] ?? 0) + 1;
    }
  }
  const totalTasks = tasks.length;
  const completed = statusCounts["completed"] ?? 0;
  const failed = statusCounts["failed"] ?? 0;

  const insights: any = {
    days,
    generatedAt: new Date().toISOString(),
    taskSummary: {
      total: totalTasks,
      completed,
      failed,
      completionRate: totalTasks > 0 ? Math.round((completed / totalTasks) * 1000) / 10 : 0,
      failureRate: totalTasks > 0 ? Math.round((failed / totalTasks) * 1000) / 10 : 0,
      statusCounts,
    },
    failureClusters: Object.entries(failureClusters)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
  };

  // Schedule health
  if (includeScheduleHealth) {
    const schedRes: any = await ctx.swarm.schedule_list({});
    const schedPayload = schedRes?.data ?? schedRes;
    const schedules: any[] = schedPayload?.schedules ?? [];
    const bySchedule = new Map<string, { total: number; failed: number }>();
    for (const t of tasks) {
      if (!t.scheduleId) continue;
      const e = bySchedule.get(t.scheduleId) ?? { total: 0, failed: 0 };
      e.total++;
      if (t.status === "failed") e.failed++;
      bySchedule.set(t.scheduleId, e);
    }
    insights.scheduleHealth = schedules
      .map((s: any) => {
        const stats = bySchedule.get(s.id) ?? { total: 0, failed: 0 };
        const rate = stats.total > 0 ? stats.failed / stats.total : 0;
        return { name: s.name, id: s.id, runs: stats.total, failureRate: Math.round(rate * 100) };
      })
      .filter((s: any) => s.runs >= 2 && s.failureRate > 20)
      .sort((a: any, b: any) => b.failureRate - a.failureRate);
  }

  // Tool usage (top 20)
  if (includeToolUsage) {
    const query = `
      SELECT tool_name, count(*) as calls
      FROM session_logs
      WHERE tool_name IS NOT NULL AND created_at > datetime('now', '-${days} days')
      GROUP BY tool_name ORDER BY calls DESC LIMIT 20
    `;
    const toolRes: any = await ctx.swarm.db_query({ query });
    const toolPayload = toolRes?.data ?? toolRes;
    insights.toolUsage = (toolPayload?.rows ?? []).map((r: any) => ({
      tool: r.tool_name,
      calls: r.calls,
    }));
  }

  // Memory health
  if (includeMemoryHealth) {
    const memQuery = `
      SELECT scope, source, count(*) as cnt
      FROM agent_memory
      GROUP BY scope, source
    `;
    const memRes: any = await ctx.swarm.db_query({ query: memQuery });
    const memPayload = memRes?.data ?? memRes;
    const memRows = memPayload?.rows ?? [];
    const totalMem = memRows.reduce((s: number, r: any) => s + (r.cnt ?? 0), 0);
    insights.memoryHealth = {
      total: totalMem,
      byScope: memRows.reduce((m: any, r: any) => {
        m[r.scope] = (m[r.scope] ?? 0) + r.cnt;
        return m;
      }, {}),
      bySource: memRows.reduce((m: any, r: any) => {
        m[r.source] = (m[r.source] ?? 0) + r.cnt;
        return m;
      }, {}),
    };
  }

  return insights;
}
