import { z } from "zod";
import { publishCatalogReportPage } from "./catalog-report";

const MAX_TASK_SCAN_LIMIT = 500;

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
    .max(MAX_TASK_SCAN_LIMIT)
    .optional()
    .describe("Max failed tasks to scan (default 500, max 500)"),
  publishPage: z.boolean().optional().describe("Publish an authed HTML page (default true)"),
});

const REASON_PATTERNS: any[] = [
  { key: "sigterm/killed", re: /sigterm|sigkill|killed|143|137/i },
  { key: "timeout", re: /time?d?\s*out|timeout|deadline/i },
  { key: "context-window", re: /context (window|limit|saturat)|peakcontext|compact/i },
  { key: "reboot-sweep", re: /reboot sweep/i },
  { key: "not-found", re: /not found|404|missing|no such/i },
  { key: "auth/credentials", re: /unauthorized|401|403|credential|token|forbidden/i },
  { key: "ci/checks-failed", re: /\bci\b|check.?s? fail|lint|tsc|test.?s? fail/i },
  { key: "network", re: /network|econn|fetch failed|socket|dns|502|503|504/i },
  { key: "cancelled", re: /cancel|aborted/i },
];

function sanitizeUntrustedReasonSample(reason: unknown): string {
  return String(reason)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function rowsToObjects(result: any): any[] {
  const payload = result?.data ?? result;
  const columns: string[] = payload?.columns ?? [];
  return (payload?.rows ?? []).map((row: any) =>
    Array.isArray(row) ? Object.fromEntries(columns.map((column, i) => [column, row[i]])) : row,
  );
}

function reasonCluster(reason: string): string {
  const r = (reason || "").trim();
  if (!r) return "(no reason given)";
  for (const p of REASON_PATTERNS) {
    if (p.re.test(r)) return p.key;
  }
  return "other";
}

/** Cluster recently failed swarm tasks by reason, agent, or schedule. */
export default async function taskFailureAudit(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const days = parsed.data.days || 7;
  const groupBy = parsed.data.groupBy || "reason";
  const limit = Math.min(parsed.data.limit ?? MAX_TASK_SCAN_LIMIT, MAX_TASK_SCAN_LIMIT);
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
  // Projected for every groupBy mode: task_list omits failureReason, and
  // schedule/agent groups still need a populated sample.
  const tasksNeedingReason = tasks.filter((task: any) => !task.failureReason && task.id);
  const taskIds = tasksNeedingReason.map((task: any) => task.id as string);
  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => "?").join(", ");
    const reasonResult: any = await ctx.swarm.db_query({
      sql: `SELECT id, failureReason FROM agent_tasks WHERE id IN (${placeholders})`,
      params: taskIds,
    });
    const reasonPayload: any = reasonResult?.data ?? reasonResult;
    if (
      reasonResult?.success === false ||
      reasonPayload?.success === false ||
      reasonPayload?.error
    ) {
      return { error: "failure reason projection failed with status " + reasonResult?.status };
    }
    if (reasonPayload?.truncated) {
      return {
        error: `failure reason projection truncated (${reasonPayload.rows?.length ?? 0} of ${reasonPayload.total ?? "unknown"} rows)`,
      };
    }
    for (const row of rowsToObjects(reasonResult)) {
      if (typeof row?.id === "string" && typeof row.failureReason === "string") {
        failureReasons.set(row.id, row.failureReason);
      }
    }
  }

  const groups: any = {};
  for (const t of tasks) {
    let key: string;
    if (groupBy === "agent") key = t.agentId || "(unassigned)";
    else if (groupBy === "schedule") key = t.scheduleId || "(not scheduled)";
    else key = reasonCluster(failureReasons.get(t.id) || t.failureReason || "");
    if (!groups[key]) groups[key] = { key, count: 0, taskIds: [], untrustedWorkerTextSample: "" };
    groups[key].count++;
    if (groups[key].taskIds.length < 5) groups[key].taskIds.push(t.id);
    const failureReason = failureReasons.get(t.id) || t.failureReason;
    if (!groups[key].untrustedWorkerTextSample && failureReason) {
      groups[key].untrustedWorkerTextSample = sanitizeUntrustedReasonSample(failureReason);
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
                  untrustedWorkerTextSample: group.untrustedWorkerTextSample,
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
