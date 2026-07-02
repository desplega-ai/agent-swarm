import { z } from "zod";
import { publishCatalogReportPage } from "./catalog-report";

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
  publishPage: z.boolean().optional().describe("Publish an authed HTML page (default true)"),
});

/** Per-schedule health check: failure rates and flagging unhealthy schedules. */
export default async function scheduleHealth(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const days = parsed.data.days || 7;
  const threshold = parsed.data.failureThreshold ?? 0.2;
  const publishPage = parsed.data.publishPage !== false;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Get schedules
  const schedRes: any = await ctx.swarm.schedule_list({});
  const schedPayload = schedRes?.data ?? schedRes;
  const schedules: any[] = schedPayload?.schedules ?? [];

  if (!schedules.length) {
    const result: any = { days, threshold, totalSchedules: 0, flaggedCount: 0, schedules: [], flagged: [] };
    if (publishPage) {
      result.page = await publishCatalogReportPage(
        {
          title: "Schedule Health Audit",
          slug: "schedule-health",
          description: "Per-schedule failure rate audit.",
          generatedAt: new Date().toISOString(),
          lede: "No schedules were returned for the selected window.",
          metrics: [
            ["Schedules", 0],
            ["Flagged", 0],
            ["Days", days],
            ["Threshold", threshold],
          ],
          sections: [
            {
              key: "schedule-health",
              goal: "Keep recurring schedules healthy and visible.",
              findingCount: 0,
              checks: { schedules: 0, flagged: 0 },
              findings: [],
            },
          ],
          appendix: result,
        },
        ctx,
      );
    }
    return result;
  }

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

  const result: any = {
    days,
    threshold,
    totalSchedules: schedules.length,
    flaggedCount: flagged.length,
    schedules: results.sort((a: any, b: any) => b.failureRate - a.failureRate),
    flagged,
  };

  if (publishPage) {
    result.page = await publishCatalogReportPage(
      {
        title: "Schedule Health Audit",
        slug: "schedule-health",
        description: "Per-schedule failure rate audit.",
        generatedAt: new Date().toISOString(),
        lede: `Checked ${schedules.length} schedule(s) over ${days} day(s); ${flagged.length} exceeded the configured failure threshold.`,
        metrics: [
          ["Schedules", schedules.length],
          ["Flagged", flagged.length],
          ["Days", days],
          ["Threshold", threshold],
        ],
        sections: [
          {
            key: "schedule-health",
            goal: "Keep recurring schedules healthy and visible.",
            findingCount: flagged.length,
            checks: {
              totalSchedules: schedules.length,
              flaggedSchedules: flagged.length,
              threshold,
              scannedTasks: tasks.length,
            },
            findings: flagged.map((schedule: any) => ({
              id: `schedule.${schedule.id}`,
              severity: schedule.failureRate >= 0.5 ? "high" : "medium",
              summary: `${schedule.name} failed ${schedule.failed}/${schedule.runs} recent run(s).`,
              action: "Review the latest failed tasks and disable, repair, or retarget this schedule.",
              samples: [schedule],
            })),
          },
        ],
        appendix: result,
      },
      ctx,
    );
  }

  return result;
}
