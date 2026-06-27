import { z } from "zod";

export const argsSchema = z.object({
  nowIso: z.string().optional().describe("Triage clock override (default: current time)"),
  failureLookbackMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Look back this many minutes for real failures (default 60)"),
  stuckMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Flag in-progress tasks older than this on offline agents (default 5)"),
  deployWindowMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Window around now for merged agent-swarm PRs (default 15)"),
  repo: z
    .string()
    .optional()
    .describe("Optional GitHub repository in 'owner/name' form for restart/deploy PR detection"),
});

const BENIGN_FAILURE_RE = /^(superseded_workflow_task|cancelled|reboot-sweep)$/i;

function rowsToObjects(res: any): any[] {
  const p = res?.data ?? res;
  const cols: string[] = p?.columns ?? [];
  return (p?.rows ?? []).map((r: any) =>
    Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : r,
  );
}

async function query(ctx: any, sql: string, params?: unknown[]): Promise<any[]> {
  try {
    return rowsToObjects(await ctx.swarm.db_query({ sql, params }));
  } catch (error) {
    return [{ unavailable: error instanceof Error ? error.message : String(error) }];
  }
}

function taskPreview(task: unknown): string {
  return String(task || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function summarizeTask(row: any): any {
  return {
    id: row.id,
    status: row.status,
    taskType: row.taskType || null,
    agentId: row.agentId || null,
    agentName: row.agentName || null,
    scheduleId: row.scheduleId || null,
    parentTaskId: row.parentTaskId || null,
    failureReason: row.failureReason || null,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    taskPreview: taskPreview(row.task),
  };
}

async function recentMergedPrs(
  ctx: any,
  repo: string | undefined,
  nowMs: number,
  windowMinutes: number,
): Promise<any> {
  if (!repo) return { skipped: "repo not provided" };
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { error: "repo must be in 'owner/name' form" };

  const windowMs = windowMinutes * 60 * 1000;
  try {
    const response = await ctx.stdlib.fetch(
      "https://api.github.com/repos/" +
        repo +
        "/pulls?state=closed&sort=updated&direction=desc&per_page=20",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "agent-swarm-boot-triage",
        },
      },
    );
    if (!response.ok) return { error: `GitHub API ${response.status}` };
    const prs = (await response.json()) as any[];
    return prs
      .filter((pr) => pr?.merged_at)
      .map((pr) => {
        const mergedAtMs = Date.parse(pr.merged_at);
        return {
          repo,
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          mergedAt: pr.merged_at,
          minutesFromRestart: Math.round((mergedAtMs - nowMs) / 60000),
        };
      })
      .filter((pr) => Math.abs(pr.minutesFromRestart * 60000) <= windowMs);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Read-only post-restart triage snapshot for the heartbeat.boot-triage prompt. */
export default async function bootTriage(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args || {});
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };

  const now = parsed.data.nowIso ? new Date(parsed.data.nowIso) : new Date();
  const nowMs = now.getTime();
  const failureLookbackMinutes = parsed.data.failureLookbackMinutes || 60;
  const stuckMinutes = parsed.data.stuckMinutes || 5;
  const deployWindowMinutes = parsed.data.deployWindowMinutes || 15;
  const repo = parsed.data.repo;

  const mergedPrs = await recentMergedPrs(ctx, repo, nowMs, deployWindowMinutes);

  const recentFailureRows = await query(
    ctx,
    `SELECT t.id, t.task, t.status, t.taskType, t.agentId, a.name as agentName,
            t.scheduleId, t.parentTaskId, t.failureReason, t.createdAt, t.lastUpdatedAt
     FROM agent_tasks t
     LEFT JOIN agents a ON a.id = t.agentId
     WHERE t.status = 'failed'
       AND datetime(t.lastUpdatedAt) >= datetime(?, ?)
     ORDER BY datetime(t.lastUpdatedAt) DESC
     LIMIT 50`,
    [now.toISOString(), `-${failureLookbackMinutes} minutes`],
  );
  const recentlyFailedTasks = recentFailureRows
    .filter((row) => !row.unavailable)
    .filter((row) => !BENIGN_FAILURE_RE.test(String(row.failureReason || "")))
    .map(summarizeTask);

  const stuckOfflineRows = await query(
    ctx,
    `SELECT t.id, t.task, t.status, t.taskType, t.agentId, a.name as agentName,
            t.scheduleId, t.parentTaskId, t.failureReason, t.createdAt, t.lastUpdatedAt
     FROM agent_tasks t
     JOIN agents a ON a.id = t.agentId
     WHERE t.status = 'in_progress'
       AND a.status = 'offline'
       AND datetime(t.lastUpdatedAt) <= datetime(?, ?)
     ORDER BY datetime(t.lastUpdatedAt) ASC
     LIMIT 50`,
    [now.toISOString(), `-${stuckMinutes} minutes`],
  );
  const stuckInProgressOnOfflineAgents = stuckOfflineRows
    .filter((row) => !row.unavailable)
    .map(summarizeTask);

  const orphanRows = await query(
    ctx,
    `SELECT t.id, t.task, t.status, t.taskType, t.agentId, a.name as agentName,
            t.scheduleId, t.parentTaskId, t.failureReason, t.createdAt, t.lastUpdatedAt
     FROM agent_tasks t
     JOIN agents a ON a.id = t.agentId
     WHERE t.status IN ('pending', 'offered')
       AND a.status = 'offline'
     ORDER BY datetime(t.lastUpdatedAt) ASC
     LIMIT 50`,
  );
  const orphanedPendingOrOfferedOnOfflineWorkers = orphanRows
    .filter((row) => !row.unavailable)
    .map(summarizeTask);

  const supersededRows = await query(
    ctx,
    `SELECT p.id, p.task, p.status, p.taskType, p.agentId, a.name as agentName,
            p.scheduleId, p.parentTaskId, p.failureReason, p.createdAt, p.lastUpdatedAt
     FROM agent_tasks p
     LEFT JOIN agents a ON a.id = p.agentId
     WHERE p.status = 'superseded'
       AND datetime(p.lastUpdatedAt) >= datetime(?, ?)
       AND NOT EXISTS (
         SELECT 1
         FROM agent_tasks c
         WHERE c.parentTaskId = p.id
           AND c.taskType = 'resume'
           AND c.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       )
     ORDER BY datetime(p.lastUpdatedAt) DESC
     LIMIT 50`,
    [now.toISOString(), `-${failureLookbackMinutes} minutes`],
  );
  const supersededTasksMissingResumeChild = supersededRows
    .filter((row) => !row.unavailable)
    .map(summarizeTask);

  return {
    generatedAt: now.toISOString(),
    windows: {
      failureLookbackMinutes,
      stuckMinutes,
      deployWindowMinutes,
    },
    deployRestartDetection: {
      source: repo ? "github:" + repo : null,
      mergedPrsWithinWindow: Array.isArray(mergedPrs) ? mergedPrs : [],
      skipped: Array.isArray(mergedPrs) ? null : mergedPrs.skipped || null,
      error: Array.isArray(mergedPrs) ? null : mergedPrs.error,
    },
    recentlyFailedTasks,
    stuckInProgressOnOfflineAgents,
    orphanedPendingOrOfferedOnOfflineWorkers,
    supersededTasksMissingResumeChild,
    summary: {
      mergedPrsWithinWindow: Array.isArray(mergedPrs) ? mergedPrs.length : 0,
      recentlyFailedTasks: recentlyFailedTasks.length,
      stuckInProgressOnOfflineAgents: stuckInProgressOnOfflineAgents.length,
      orphanedPendingOrOfferedOnOfflineWorkers: orphanedPendingOrOfferedOnOfflineWorkers.length,
      supersededTasksMissingResumeChild: supersededTasksMissingResumeChild.length,
    },
  };
}
