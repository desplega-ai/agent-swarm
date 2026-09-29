import { z } from "zod";
import { publishCatalogReportPage } from "./catalog-report";

export const argsSchema = z.object({
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Look back this many days for failed tasks (default 7)"),
  groupBy: z
    .enum(["reason", "agent", "schedule"])
    .optional()
    .describe("Cluster failures by failure reason, agent, or schedule (default reason)"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max failed tasks to scan (default 500)"),
  publishPage: z.boolean().optional().describe("Publish an authed HTML page (default true)"),
});

const REASON_PATTERNS: any[] = [
  { key: "sigterm/killed", re: /sigterm|sigkill|killed|143|137/i },
  { key: "timeout", re: /time?d?\s*out|timeout|deadline/i },
  { key: "context-window", re: /context (window|limit|saturat)|peakcontext|compact/i },
  { key: "not-found", re: /not found|404|missing|no such/i },
  { key: "auth/credentials", re: /unauthorized|401|403|credential|token|forbidden/i },
  { key: "ci/checks-failed", re: /ci|check.?s? fail|lint|tsc|test.?s? fail/i },
  { key: "network", re: /network|econn|fetch failed|socket|dns|502|503|504/i },
  { key: "cancelled", re: /cancel|aborted/i },
];

function reasonCluster(reason: string): string {
  const r = (reason || "").trim();
  if (!r) return "(no reason given)";
  for (const p of REASON_PATTERNS) {
    if (p.re.test(r)) return p.key;
  }
  return r.toLowerCase().slice(0, 48);
}

/** Cluster recently failed swarm tasks by reason, agent, or schedule. */
export default async function taskFailureAudit(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const days = parsed.data.days || 7;
  const groupBy = parsed.data.groupBy || "reason";
  const limit = parsed.data.limit || 500;
  const publishPage = parsed.data.publishPage !== false;

  const since = new Date(Date.now() - days * 86400000).toISOString();
  const res: any = await ctx.swarm.task_list({
    status: "failed",
    createdAfter: since,
    limit,
  });
  if (res && res.success === false) {
    return { error: "task_list failed with status " + res.status };
  }
  const payload: any = res && res.data ? res.data : res;
  const tasks: any = payload && Array.isArray(payload.tasks) ? payload.tasks : [];

  const failureReasons = new Map<string, string>();
  if (groupBy === "reason") {
    const missingDetails = tasks.filter((task: any) => !task.failureReason && task.id);
    const batchSize = 10;
    for (let i = 0; i < missingDetails.length; i += batchSize) {
      const batch = missingDetails.slice(i, i + batchSize);
      const details = await Promise.all(
        batch.map((task: any) => ctx.swarm.task_get({ taskId: task.id })),
      );
      for (let j = 0; j < details.length; j++) {
        const response: any = details[j];
        const detail: any = response?.data ?? response;
        if (response?.success === false || detail?.success === false) {
          return { error: "task_get failed with status " + response?.status };
        }
        failureReasons.set(batch[j].id, detail?.failureReason || "");
      }
    }
  }

  const groups: any = {};
  for (const t of tasks) {
    let key: string;
    if (groupBy === "agent") key = t.agentId || "(unassigned)";
    else if (groupBy === "schedule") key = t.scheduleId || "(not scheduled)";
    else key = reasonCluster(failureReasons.get(t.id) || t.failureReason || "");
    if (!groups[key]) groups[key] = { key, count: 0, taskIds: [], sampleReason: "" };
    groups[key].count++;
    if (groups[key].taskIds.length < 5) groups[key].taskIds.push(t.id);
    const failureReason = failureReasons.get(t.id) || t.failureReason;
    if (!groups[key].sampleReason && failureReason) {
      groups[key].sampleReason = String(failureReason).slice(0, 200);
    }
  }

  const rows: any[] = Object.keys(groups)
    .map((k: string) => groups[k])
    .sort((a: any, b: any) => b.count - a.count);

  const result: any = {
    days,
    groupBy,
    totalFailed: tasks.length,
    clusterCount: rows.length,
    groups: rows,
  };

  if (publishPage) {
    result.page = await publishCatalogReportPage(
      {
        title: "Task Failure Audit",
        slug: "task-failure-audit",
        description: "Clustered audit of recently failed swarm tasks.",
        generatedAt: new Date().toISOString(),
        lede: `Clustered ${tasks.length} failed task(s) over ${days} day(s) by ${groupBy}.`,
        metrics: [
          ["Failed tasks", tasks.length],
          ["Clusters", rows.length],
          ["Days", days],
          ["Limit", limit],
        ],
        sections: [
          {
            key: "failure-clusters",
            goal: "Surface repeated failure modes before they become operational drift.",
            findingCount: rows.length,
            checks: { totalFailed: tasks.length, clusterCount: rows.length, groupBy },
            findings: rows.map((group: any) => ({
              id: `failure.${group.key}`,
              severity: group.count >= 5 ? "high" : group.count >= 2 ? "medium" : "low",
              summary: `${group.count} failed task(s) in ${group.key}.`,
              action: "Inspect the sample task IDs and decide whether this needs a fix, retry, or HEARTBEAT watch item.",
              samples: [
                {
                  key: group.key,
                  count: group.count,
                  taskIds: group.taskIds,
                  sampleReason: group.sampleReason,
                },
              ],
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
