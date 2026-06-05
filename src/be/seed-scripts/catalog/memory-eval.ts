import { z } from "zod";
import { publishCatalogReportPage } from "./catalog-report";

export const argsSchema = z.object({
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Look back this many days for retrieval/rating data (default 30)"),
  freshDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Memories younger than this are 'fresh' (default 14)"),
  usefulnessThreshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("α/(α+β) cutoff for 'useful' (default 0.6)"),
  publishPage: z.boolean().optional().describe("Publish an authed HTML page (default true)"),
  writeAgentFs: z.boolean().optional().describe("Write markdown report to agent-fs (default true)"),
});

function rowsToObjects(res: any): any[] {
  const p = res?.data ?? res;
  const cols: string[] = p?.columns ?? [];
  return (p?.rows ?? []).map((r: any) =>
    Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : r,
  );
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default async function memoryEval(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args || {});
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };

  const days = parsed.data.days || 30;
  const freshDays = parsed.data.freshDays || 14;
  const usefulnessThreshold = parsed.data.usefulnessThreshold ?? 0.6;
  const publishPage = parsed.data.publishPage !== false;
  const writeAgentFs = parsed.data.writeAgentFs !== false;

  const w = `datetime('now','-${days} days')`;
  const now = new Date().toISOString();

  const report: any = { generatedAt: now, days, freshDays, usefulnessThreshold };

  // ─── Axis 1: Carry-forward context ───────────────────────────────────
  // For tasks with a contextKey, what fraction retrieve ≥1 useful memory
  // written by a prior task in the same contextKey chain?

  const axis1FollowUps = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT t.id as taskId, t.contextKey
            FROM agent_tasks t
            WHERE t.contextKey IS NOT NULL
              AND t.status = 'completed'
              AND t.createdAt > ${w}
              AND EXISTS (
                SELECT 1 FROM agent_tasks prior
                WHERE prior.contextKey = t.contextKey
                  AND prior.id != t.id
                  AND prior.createdAt < t.createdAt
              )`,
    }),
  );

  let axis1HitCount = 0;
  const axis1Total = axis1FollowUps.length;

  if (axis1Total > 0) {
    const axis1Hits = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT DISTINCT mr.taskId
              FROM memory_retrieval mr
              JOIN agent_memory m ON mr.memoryId = m.id
              JOIN agent_tasks current_task ON mr.taskId = current_task.id
              WHERE current_task.contextKey IS NOT NULL
                AND current_task.status = 'completed'
                AND current_task.createdAt > ${w}
                AND m.sourceTaskId IS NOT NULL
                AND m.alpha / nullif(m.alpha + m.beta, 0) > ${usefulnessThreshold}
                AND EXISTS (
                  SELECT 1 FROM agent_tasks prior
                  WHERE prior.contextKey = current_task.contextKey
                    AND prior.id = m.sourceTaskId
                    AND prior.createdAt < current_task.createdAt
                )
                AND EXISTS (
                  SELECT 1 FROM agent_tasks earlier
                  WHERE earlier.contextKey = current_task.contextKey
                    AND earlier.id != current_task.id
                    AND earlier.createdAt < current_task.createdAt
                )`,
      }),
    );
    axis1HitCount = axis1Hits.length;
  }

  report.axis1 = {
    name: "Carry-forward context",
    description:
      "Fraction of contextKey-chained follow-up tasks that retrieve ≥1 useful memory from a prior task in the same chain.",
    followUpTasks: axis1Total,
    tasksWithUsefulCarryForward: axis1HitCount,
    score: pct(axis1HitCount, axis1Total),
    softTarget: 60,
    unit: "%",
  };

  // ─── Axis 2: Follow preferences & constraints ───────────────────────
  // Retrieval rate + usefulness scores for file_index memories from
  // CLAUDE.md / IDENTITY.md / SOUL.md / TOOLS.md paths.

  const prefMemories = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT id, name, sourcePath, alpha, beta, accessCount,
                   CASE WHEN (alpha + beta) > 0 THEN round(alpha / (alpha + beta), 4) ELSE 0.5 END as usefulness
            FROM agent_memory
            WHERE source = 'file_index'
              AND (sourcePath LIKE '%CLAUDE.md'
                OR sourcePath LIKE '%IDENTITY.md'
                OR sourcePath LIKE '%SOUL.md'
                OR sourcePath LIKE '%TOOLS.md')`,
    }),
  );

  const prefTotal = prefMemories.length;
  const prefWithAccess = prefMemories.filter((m: any) => (m.accessCount ?? 0) > 0).length;
  const prefUsefulnessValues = prefMemories.map((m: any) => Number(m.usefulness ?? 0.5));
  const prefAvgUsefulness =
    prefUsefulnessValues.length > 0
      ? round2(prefUsefulnessValues.reduce((s: number, v: number) => s + v, 0) / prefUsefulnessValues.length)
      : 0;
  const prefTotalAccess = prefMemories.reduce((s: number, m: any) => s + (m.accessCount ?? 0), 0);

  const prefRatings = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT mr.source as raterSource, count(*) as cnt,
                   round(avg(mr.signal), 4) as avgSignal
            FROM memory_rating mr
            JOIN agent_memory m ON mr.memoryId = m.id
            WHERE m.source = 'file_index'
              AND (m.sourcePath LIKE '%CLAUDE.md'
                OR m.sourcePath LIKE '%IDENTITY.md'
                OR m.sourcePath LIKE '%SOUL.md'
                OR m.sourcePath LIKE '%TOOLS.md')
            GROUP BY mr.source`,
    }),
  );

  const prefByPath = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT
              CASE
                WHEN sourcePath LIKE '%CLAUDE.md' THEN 'CLAUDE.md'
                WHEN sourcePath LIKE '%IDENTITY.md' THEN 'IDENTITY.md'
                WHEN sourcePath LIKE '%SOUL.md' THEN 'SOUL.md'
                WHEN sourcePath LIKE '%TOOLS.md' THEN 'TOOLS.md'
                ELSE 'other'
              END as fileType,
              count(*) as cnt,
              sum(accessCount) as totalAccess,
              round(avg(CASE WHEN (alpha + beta) > 0 THEN alpha / (alpha + beta) ELSE 0.5 END), 4) as avgUsefulness
            FROM agent_memory
            WHERE source = 'file_index'
              AND (sourcePath LIKE '%CLAUDE.md'
                OR sourcePath LIKE '%IDENTITY.md'
                OR sourcePath LIKE '%SOUL.md'
                OR sourcePath LIKE '%TOOLS.md')
            GROUP BY fileType`,
    }),
  );

  report.axis2 = {
    name: "Follow preferences & constraints",
    description:
      "Retrieval rate and LlmRater scores for file_index memories from CLAUDE.md/IDENTITY.md/SOUL.md/TOOLS.md (the 'preference memories').",
    totalPreferenceMemories: prefTotal,
    memoriesEverRetrieved: prefWithAccess,
    retrievalRate: pct(prefWithAccess, prefTotal),
    totalRetrievals: prefTotalAccess,
    avgUsefulness: prefAvgUsefulness,
    raterBreakdown: prefRatings.map((r: any) => ({
      rater: r.raterSource,
      ratings: r.cnt,
      avgSignal: Number(r.avgSignal ?? 0),
    })),
    byFile: prefByPath.map((r: any) => ({
      file: r.fileType,
      memories: r.cnt,
      totalAccess: r.totalAccess ?? 0,
      avgUsefulness: Number(r.avgUsefulness ?? 0),
    })),
    softTarget: "High retrieval rate + usefulness > 0.6 on preference memories",
    unit: "composite",
  };

  // ─── Axis 3: Stay current over time ──────────────────────────────────
  // Distribution of *retrieved* memories across freshness buckets.

  const freshW = `datetime('now','-${freshDays} days')`;

  const axis3Buckets = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT
              CASE
                WHEN m.createdAt > ${freshW} THEN 'fresh'
                WHEN m.expiresAt IS NOT NULL AND m.expiresAt < datetime('now') THEN 'expired'
                WHEN m.accessedAt < datetime('now','-${freshDays} days') AND m.accessCount > 0 THEN 'aging'
                WHEN m.accessCount = 0 AND m.createdAt < ${freshW} THEN 'stranded'
                ELSE 'aging'
              END as bucket,
              count(DISTINCT mr.memoryId) as uniqueMemories,
              count(*) as retrievals
            FROM memory_retrieval mr
            JOIN agent_memory m ON mr.memoryId = m.id
            WHERE mr.retrievedAt > ${w}
            GROUP BY bucket`,
    }),
  );

  const bucketMap: Record<string, { uniqueMemories: number; retrievals: number }> = {};
  let totalRetrievedMemories = 0;
  let totalRetrievals = 0;
  for (const b of axis3Buckets) {
    const mem = Number(b.uniqueMemories ?? 0);
    const ret = Number(b.retrievals ?? 0);
    bucketMap[b.bucket] = { uniqueMemories: mem, retrievals: ret };
    totalRetrievedMemories += mem;
    totalRetrievals += ret;
  }

  const freshMem = bucketMap.fresh?.uniqueMemories ?? 0;
  const freshScore = pct(freshMem, totalRetrievedMemories);

  const staleRefCount = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT count(DISTINCT mr.memoryId) as cnt
            FROM memory_retrieval mr
            JOIN agent_memory m ON mr.memoryId = m.id
            WHERE mr.retrievedAt > ${w}
              AND m.expiresAt IS NOT NULL
              AND m.expiresAt < datetime('now')`,
    }),
  );

  report.axis3 = {
    name: "Stay current over time",
    description:
      "Distribution of retrieved memories across freshness buckets. Target: >80% of retrieved memories are fresh.",
    window: `${days} days`,
    freshDays,
    totalUniqueMemoriesRetrieved: totalRetrievedMemories,
    totalRetrievals,
    buckets: {
      fresh: {
        label: `Created within last ${freshDays} days`,
        uniqueMemories: freshMem,
        retrievals: bucketMap.fresh?.retrievals ?? 0,
        pctOfRetrieved: freshScore,
      },
      aging: {
        label: `Older than ${freshDays} days, still active`,
        uniqueMemories: bucketMap.aging?.uniqueMemories ?? 0,
        retrievals: bucketMap.aging?.retrievals ?? 0,
        pctOfRetrieved: pct(bucketMap.aging?.uniqueMemories ?? 0, totalRetrievedMemories),
      },
      stranded: {
        label: "Old, never accessed",
        uniqueMemories: bucketMap.stranded?.uniqueMemories ?? 0,
        retrievals: bucketMap.stranded?.retrievals ?? 0,
        pctOfRetrieved: pct(bucketMap.stranded?.uniqueMemories ?? 0, totalRetrievedMemories),
      },
      expired: {
        label: "Past TTL / expired",
        uniqueMemories: bucketMap.expired?.uniqueMemories ?? 0,
        retrievals: bucketMap.expired?.retrievals ?? 0,
        pctOfRetrieved: pct(bucketMap.expired?.uniqueMemories ?? 0, totalRetrievedMemories),
      },
    },
    staleReferentCount: Number(staleRefCount[0]?.cnt ?? 0),
    freshScore,
    softTarget: 80,
    unit: "%",
  };

  // ─── Store totals ────────────────────────────────────────────────────

  const totalMemoryRows = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT count(*) as total,
                   sum(CASE WHEN accessCount > 0 THEN 1 ELSE 0 END) as accessed,
                   sum(CASE WHEN expiresAt IS NOT NULL AND expiresAt < datetime('now') THEN 1 ELSE 0 END) as expired
            FROM agent_memory`,
    }),
  );

  const storeTotals = totalMemoryRows[0] ?? {};

  report.storeSnapshot = {
    totalMemories: Number(storeTotals.total ?? 0),
    memoriesEverAccessed: Number(storeTotals.accessed ?? 0),
    expiredMemories: Number(storeTotals.expired ?? 0),
  };

  // ─── Markdown report ─────────────────────────────────────────────────

  const md = buildMarkdownReport(report);

  if (writeAgentFs) {
    try {
      const today = now.slice(0, 10);
      await ctx.swarm.agent_fs_write({
        path: `docs/memory-eval-${today}.md`,
        content: md,
        message: `Memory eval baseline report ${today}`,
        org: "648a5f3c-35c8-4f11-8673-b89de52cd6bd",
      });
    } catch (_e) {
      report.agentFsError = "agent_fs_write failed — report still available in page + return value";
    }
  }

  // ─── Publish page ────────────────────────────────────────────────────

  if (publishPage) {
    report.page = await publishCatalogReportPage(
      {
        title: "Memory Eval — 3-Axis Baseline",
        slug: "memory-eval",
        description: `3-axis memory quality baseline: carry-forward ${report.axis1.score}%, preferences usefulness ${report.axis2.avgUsefulness}, freshness ${report.axis3.freshScore}%.`,
        generatedAt: now,
        lede: `${days}-day memory eval across ${report.storeSnapshot.totalMemories} memories. Axis 1 (carry-forward): ${report.axis1.score}% · Axis 2 (preferences): avg usefulness ${report.axis2.avgUsefulness} · Axis 3 (freshness): ${report.axis3.freshScore}% fresh.`,
        metrics: [
          ["Carry-forward", `${report.axis1.score}%`],
          ["Pref Usefulness", report.axis2.avgUsefulness],
          ["Freshness", `${report.axis3.freshScore}%`],
          ["Total Memories", report.storeSnapshot.totalMemories],
        ],
        sections: [
          {
            key: "axis1-carry-forward",
            label: "Axis 1",
            goal: "Carry-forward context: do follow-up tasks retrieve useful memories from prior tasks in the same thread?",
            findingCount: report.axis1.followUpTasks > 0 ? 1 : 0,
            checks: {
              followUpTasks: report.axis1.followUpTasks,
              tasksWithCarryForward: report.axis1.tasksWithUsefulCarryForward,
              score: `${report.axis1.score}%`,
              softTarget: `${report.axis1.softTarget}%`,
            },
            findings:
              report.axis1.followUpTasks > 0
                ? [
                    {
                      id: "axis1.carry-forward-rate",
                      severity:
                        report.axis1.score >= 60 ? "low" : report.axis1.score >= 30 ? "medium" : "high",
                      summary: `${report.axis1.score}% of ${report.axis1.followUpTasks} follow-up tasks retrieved a useful carry-forward memory (soft target: ${report.axis1.softTarget}%).`,
                      action:
                        report.axis1.score < 60
                          ? "Investigate whether memories from prior tasks in a thread are being written and embedded correctly."
                          : "Score meets soft target. Monitor for regression after architecture changes.",
                    },
                  ]
                : [],
          },
          {
            key: "axis2-preferences",
            label: "Axis 2",
            goal: "Follow preferences & constraints: are identity/config memories retrieved and rated useful?",
            findingCount: report.axis2.byFile.length,
            checks: {
              preferenceMemories: report.axis2.totalPreferenceMemories,
              everRetrieved: `${report.axis2.retrievalRate}%`,
              avgUsefulness: report.axis2.avgUsefulness,
              totalRetrievals: report.axis2.totalRetrievals,
            },
            findings: report.axis2.byFile.map((f: any) => ({
              id: `axis2.file.${f.file}`,
              severity: f.avgUsefulness < 0.5 ? "medium" : "low",
              summary: `${f.file}: ${f.memories} memories, ${f.totalAccess} retrievals, avg usefulness ${round2(f.avgUsefulness)}.`,
              action:
                f.avgUsefulness < 0.5
                  ? "Low usefulness suggests these memories are being retrieved but not helpful — check chunking and embedding quality."
                  : "Healthy retrieval pattern.",
            })),
          },
          {
            key: "axis3-freshness",
            label: "Axis 3",
            goal: "Stay current over time: are retrieved memories fresh, or are stale/expired memories polluting results?",
            findingCount: 1,
            checks: {
              freshScore: `${report.axis3.freshScore}%`,
              softTarget: `${report.axis3.softTarget}%`,
              totalRetrieved: report.axis3.totalUniqueMemoriesRetrieved,
              staleReferents: report.axis3.staleReferentCount,
            },
            findings: [
              {
                id: "axis3.freshness-distribution",
                severity:
                  report.axis3.freshScore >= 80
                    ? "low"
                    : report.axis3.freshScore >= 50
                      ? "medium"
                      : "high",
                summary: `${report.axis3.freshScore}% of retrieved memories are fresh (<${freshDays}d). Aging: ${report.axis3.buckets.aging.pctOfRetrieved}%, Stranded: ${report.axis3.buckets.stranded.pctOfRetrieved}%, Expired: ${report.axis3.buckets.expired.pctOfRetrieved}%.`,
                action:
                  report.axis3.freshScore < 80
                    ? "Stale memories are diluting retrieval quality. Prioritize TTL enforcement and the Memory Curator job."
                    : "Freshness meets target. Continue monitoring.",
                samples: Object.entries(report.axis3.buckets).map(([k, v]: [string, any]) => ({
                  bucket: k,
                  uniqueMemories: v.uniqueMemories,
                  retrievals: v.retrievals,
                  pctOfRetrieved: `${v.pctOfRetrieved}%`,
                })),
              },
            ],
          },
        ],
        appendix: report,
      },
      ctx,
    );
  }

  return report;
}

function buildMarkdownReport(r: any): string {
  const lines: string[] = [];
  const ln = (s = "") => lines.push(s);

  ln(`# Memory Eval — 3-Axis Baseline Report`);
  ln(`> Generated: ${r.generatedAt} · Window: ${r.days} days`);
  ln();
  ln(`## Summary`);
  ln();
  ln(`| Axis | Score | Soft Target |`);
  ln(`|------|-------|-------------|`);
  ln(`| 1 — Carry-forward context | **${r.axis1.score}%** | ${r.axis1.softTarget}% |`);
  ln(`| 2 — Preferences avg usefulness | **${r.axis2.avgUsefulness}** | >0.6 |`);
  ln(`| 3 — Freshness (% fresh retrieved) | **${r.axis3.freshScore}%** | ${r.axis3.softTarget}% |`);
  ln();
  ln(`**Store:** ${r.storeSnapshot.totalMemories} total memories, ${r.storeSnapshot.memoriesEverAccessed} ever accessed, ${r.storeSnapshot.expiredMemories} expired.`);
  ln();

  ln(`---`);
  ln(`## Axis 1 — Carry-forward Context`);
  ln();
  ln(`*${r.axis1.description}*`);
  ln();
  ln(`- Follow-up tasks in window: **${r.axis1.followUpTasks}**`);
  ln(`- Tasks with useful carry-forward: **${r.axis1.tasksWithUsefulCarryForward}**`);
  ln(`- Score: **${r.axis1.score}%** (soft target: ${r.axis1.softTarget}%)`);
  ln();

  ln(`---`);
  ln(`## Axis 2 — Follow Preferences & Constraints`);
  ln();
  ln(`*${r.axis2.description}*`);
  ln();
  ln(`- Preference memories in store: **${r.axis2.totalPreferenceMemories}**`);
  ln(`- Ever retrieved: **${r.axis2.memoriesEverRetrieved}** (${r.axis2.retrievalRate}%)`);
  ln(`- Total retrievals: **${r.axis2.totalRetrievals}**`);
  ln(`- Avg usefulness: **${r.axis2.avgUsefulness}**`);
  ln();
  ln(`### By File`);
  ln();
  ln(`| File | Memories | Total Access | Avg Usefulness |`);
  ln(`|------|----------|--------------|----------------|`);
  for (const f of r.axis2.byFile) {
    ln(`| ${f.file} | ${f.memories} | ${f.totalAccess} | ${round2(f.avgUsefulness)} |`);
  }
  ln();
  if (r.axis2.raterBreakdown.length > 0) {
    ln(`### Rater Breakdown`);
    ln();
    ln(`| Rater | Ratings | Avg Signal |`);
    ln(`|-------|---------|------------|`);
    for (const rb of r.axis2.raterBreakdown) {
      ln(`| ${rb.rater} | ${rb.ratings} | ${round2(rb.avgSignal)} |`);
    }
    ln();
  }

  ln(`---`);
  ln(`## Axis 3 — Stay Current Over Time`);
  ln();
  ln(`*${r.axis3.description}*`);
  ln();
  ln(`- Window: **${r.axis3.window}** · Fresh threshold: **${r.axis3.freshDays} days**`);
  ln(`- Unique memories retrieved: **${r.axis3.totalUniqueMemoriesRetrieved}**`);
  ln(`- Fresh score: **${r.axis3.freshScore}%** (soft target: ${r.axis3.softTarget}%)`);
  ln(`- Stale referents (expired but still retrieved): **${r.axis3.staleReferentCount}**`);
  ln();
  ln(`### Freshness Buckets`);
  ln();
  ln(`| Bucket | Unique Memories | Retrievals | % of Retrieved |`);
  ln(`|--------|-----------------|------------|----------------|`);
  for (const [k, v] of Object.entries(r.axis3.buckets) as [string, any][]) {
    ln(`| ${k} (${v.label}) | ${v.uniqueMemories} | ${v.retrievals} | ${v.pctOfRetrieved}% |`);
  }
  ln();

  return lines.join("\n");
}
