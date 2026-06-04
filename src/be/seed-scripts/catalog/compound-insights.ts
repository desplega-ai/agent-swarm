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
  includeMemoryHealth: z.boolean().optional().describe("Include memory health stats (default true)"),
  includeByAgent: z
    .boolean()
    .optional()
    .describe("Include per-agent task/completion/failure breakdown (default true)"),
});

/**
 * Failure reasons that are swarm bookkeeping, not real failures. Excluded from
 * failureClusters, scheduleHealth and byAgent failure counts (Lead Rule #16):
 * the run engine collapses redundant sibling tasks into these statuses, so
 * counting them produces phantom failure spikes.
 */
const EXCLUDED_FAIL = ["superseded_workflow_task", "cancelled"];

/**
 * `db_query` returns positional rows (`rows: unknown[][]`) plus a `columns`
 * array — NOT an array of objects. Zip them back into objects so callers can
 * read by column name.
 */
function rowsToObjects(res: any): any[] {
  const p = res?.data ?? res;
  const cols: string[] = p?.columns ?? [];
  return (p?.rows ?? []).map((r: any) =>
    Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : r,
  );
}

/**
 * Daily compounding insights — compressed JSON for Phase 0 evolution.
 *
 * Swarm-wide by design: every section aggregates across ALL agents via direct
 * read-only SQL (no per-agent scoping), so a single call replaces ~25 raw tool
 * roundtrips. Parametric via `days` + the `include*` flags.
 */
export default async function compoundInsights(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args || {});
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const days = parsed.data.days || 3;
  const includeToolUsage = parsed.data.includeToolUsage !== false;
  const includeScheduleHealth = parsed.data.includeScheduleHealth !== false;
  const includeMemoryHealth = parsed.data.includeMemoryHealth !== false;
  const includeByAgent = parsed.data.includeByAgent !== false;

  // `days` is a validated positive int, so it is safe to interpolate into the
  // SQLite datetime modifier. EXCLUDED_FAIL is a fixed constant list.
  const w = `datetime('now','-${days} days')`;
  const exclList = EXCLUDED_FAIL.map((r) => `'${r}'`).join(",");
  // A "real" failure = status failed AND not one of the bookkeeping reasons.
  const realFail = `t.status='failed' AND (t.failureReason IS NULL OR t.failureReason NOT IN (${exclList}))`;

  const insights: any = { days, generatedAt: new Date().toISOString() };

  // Task summary (all agents, direct SQL).
  const statusRows = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT status, count(*) as cnt FROM agent_tasks t WHERE t.createdAt > ${w} GROUP BY status`,
    }),
  );
  const statusCounts: Record<string, number> = {};
  let total = 0;
  for (const r of statusRows) {
    statusCounts[r.status] = r.cnt;
    total += r.cnt;
  }
  const completed = statusCounts.completed ?? 0;
  const failed = statusCounts.failed ?? 0;
  insights.taskSummary = {
    total,
    completed,
    failed,
    completionRate: total > 0 ? Math.round((completed / total) * 1000) / 10 : 0,
    failureRate: total > 0 ? Math.round((failed / total) * 1000) / 10 : 0,
    statusCounts,
  };

  // Failure clusters (real failures only, normalized to a 60-char lowercased prefix).
  insights.failureClusters = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT substr(lower(t.failureReason),1,60) as reason, count(*) as count
            FROM agent_tasks t
            WHERE ${realFail} AND t.failureReason IS NOT NULL AND t.createdAt > ${w}
            GROUP BY reason ORDER BY count DESC LIMIT 10`,
    }),
  );

  // Schedule health (>= 2 runs, > 20% real-failure rate).
  if (includeScheduleHealth) {
    const sh = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT s.name as name, s.id as id, count(t.id) as runs,
                     sum(case when ${realFail} then 1 else 0 end) as failed
              FROM scheduled_tasks s
              JOIN agent_tasks t ON t.scheduleId = s.id
              WHERE t.createdAt > ${w} AND t.status != 'cancelled'
              GROUP BY s.id, s.name HAVING runs >= 2`,
      }),
    );
    insights.scheduleHealth = sh
      .map((r: any) => ({
        name: r.name,
        id: r.id,
        runs: r.runs,
        failureRate: r.runs > 0 ? Math.round((r.failed / r.runs) * 100) : 0,
      }))
      .filter((r: any) => r.failureRate > 20)
      .sort((a: any, b: any) => b.failureRate - a.failureRate);
  }

  // Tool usage (top 25). Tool names live inside the `content` JSON of
  // session_logs (no dedicated column), so extract the name SQL-side: the
  // `'%"type":"tool_use"%'` filter excludes tool_result rows (which only carry
  // `tool_use_id`), and instr/substr pull the first tool name per log line.
  // Approximate: a log line with parallel tool_use blocks counts only its first.
  if (includeToolUsage) {
    insights.toolUsage = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `WITH tu AS (
                 SELECT substr(content, instr(content,'"type":"tool_use"')) AS tail
                 FROM session_logs
                 WHERE content LIKE '%"type":"tool_use"%' AND createdAt > ${w}
               ),
               nm AS (
                 SELECT substr(tail, instr(tail,'"name":"')+8) AS rest
                 FROM tu WHERE instr(tail,'"name":"') > 0
               )
               SELECT substr(rest,1,instr(rest,'"')-1) AS tool, count(*) AS calls
               FROM nm GROUP BY tool ORDER BY calls DESC LIMIT 25`,
      }),
    ).map((r: any) => ({ tool: r.tool, calls: r.calls }));
  }

  // Memory health (whole store, by scope + source).
  if (includeMemoryHealth) {
    const memRows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT scope, source, count(*) as cnt FROM agent_memory GROUP BY scope, source`,
      }),
    );
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

  // Per-agent breakdown — covers every agent that ran a task in the window.
  if (includeByAgent) {
    insights.byAgent = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT a.name as agent, count(*) as total,
                     sum(case when t.status='completed' then 1 else 0 end) as completed,
                     sum(case when ${realFail} then 1 else 0 end) as failed
              FROM agent_tasks t LEFT JOIN agents a ON a.id = t.agentId
              WHERE t.createdAt > ${w} AND t.agentId IS NOT NULL
              GROUP BY t.agentId, a.name ORDER BY total DESC LIMIT 30`,
      }),
    ).map((r: any) => ({
      agent: r.agent,
      total: r.total,
      completed: r.completed,
      failed: r.failed,
    }));
  }

  return insights;
}
