import { z } from "zod";

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
  backfillDays: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Backfill this many past daily points on first run (default 14; 0 to skip)"),
  publishPage: z.boolean().optional().describe("Publish an authed HTML page (default true)"),
  writeAgentFs: z.boolean().optional().describe("Write markdown report to agent-fs (default true)"),
});

const KV_NS = "memory-eval";
const KV_KEY = "history";

type DailyPoint = {
  date: string;
  axis1Score: number;
  axis1Total: number;
  axis1Hits: number;
  axis2AvgUsefulness: number | null;
  axis2Retrievals: number | null;
  axis2PrefCount: number | null;
  axis3FreshScore: number;
  axis3TotalRetrieved: number;
  axis3ExpiredPct: number;
  totalMemories: number;
  searchableMemories: number;
  expiredMemories: number;
  backfilled: boolean;
};

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

function esc(value: unknown): string {
  const s = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function computeBackfillPoint(
  ctx: any,
  refDate: string,
  days: number,
  freshDays: number,
  usefulnessThreshold: number,
): Promise<DailyPoint> {
  const w = `datetime('${refDate}','-${days} days')`;
  const ref = `'${refDate}'`;
  const freshW = `datetime('${refDate}','-${freshDays} days')`;

  const axis1TotalRows = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT count(*) as cnt FROM agent_tasks t
            WHERE t.contextKey IS NOT NULL AND t.status = 'completed'
              AND t.createdAt > ${w} AND t.createdAt <= ${ref}
              AND EXISTS (
                SELECT 1 FROM agent_tasks p
                WHERE p.contextKey = t.contextKey AND p.id != t.id AND p.createdAt < t.createdAt
              )`,
    }),
  );
  const a1Total = Number(axis1TotalRows[0]?.cnt ?? 0);

  let a1Hits = 0;
  if (a1Total > 0) {
    const axis1HitRows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT count(DISTINCT mr.taskId) as cnt FROM memory_retrieval mr
              JOIN agent_memory m ON mr.memoryId = m.id
              JOIN agent_tasks ct ON mr.taskId = ct.id
              WHERE ct.contextKey IS NOT NULL AND ct.status = 'completed'
                AND ct.createdAt > ${w} AND ct.createdAt <= ${ref}
                AND m.sourceTaskId IS NOT NULL
                AND m.alpha / nullif(m.alpha + m.beta, 0) > ${usefulnessThreshold}
                AND EXISTS (
                  SELECT 1 FROM agent_tasks p
                  WHERE p.contextKey = ct.contextKey AND p.id = m.sourceTaskId AND p.createdAt < ct.createdAt
                )
                AND EXISTS (
                  SELECT 1 FROM agent_tasks e
                  WHERE e.contextKey = ct.contextKey AND e.id != ct.id AND e.createdAt < ct.createdAt
                )`,
      }),
    );
    a1Hits = Number(axis1HitRows[0]?.cnt ?? 0);
  }

  const axis3Rows = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT
              CASE
                WHEN m.createdAt > ${freshW} THEN 'fresh'
                WHEN m.expiresAt IS NOT NULL AND m.expiresAt < ${ref} THEN 'expired'
                ELSE 'other'
              END as bucket,
              count(DISTINCT mr.memoryId) as uniqueMemories
            FROM memory_retrieval mr
            JOIN agent_memory m ON mr.memoryId = m.id
            WHERE mr.retrievedAt > ${w} AND mr.retrievedAt <= ${ref}
            GROUP BY bucket`,
    }),
  );

  let totalRetrieved = 0;
  let freshMem = 0;
  let expiredMem = 0;
  for (const r of axis3Rows) {
    const n = Number(r.uniqueMemories ?? 0);
    totalRetrieved += n;
    if (r.bucket === "fresh") freshMem = n;
    if (r.bucket === "expired") expiredMem = n;
  }

  const storeRows = rowsToObjects(
    await ctx.swarm.db_query({
      sql: `SELECT
              count(*) as total,
              sum(CASE WHEN expiresAt IS NULL OR expiresAt > ${ref} THEN 1 ELSE 0 END) as searchable,
              sum(CASE WHEN expiresAt IS NOT NULL AND expiresAt <= ${ref} THEN 1 ELSE 0 END) as expired
            FROM agent_memory WHERE createdAt <= ${ref}`,
    }),
  );
  const store = storeRows[0] ?? {};

  return {
    date: refDate,
    axis1Score: pct(a1Hits, a1Total),
    axis1Total: a1Total,
    axis1Hits: a1Hits,
    axis2AvgUsefulness: null,
    axis2Retrievals: null,
    axis2PrefCount: null,
    axis3FreshScore: pct(freshMem, totalRetrieved),
    axis3TotalRetrieved: totalRetrieved,
    axis3ExpiredPct: pct(expiredMem, totalRetrieved),
    totalMemories: Number(store.total ?? 0),
    searchableMemories: Number(store.searchable ?? 0),
    expiredMemories: Number(store.expired ?? 0),
    backfilled: true,
  };
}

function reportToDailyPoint(date: string, report: any): DailyPoint {
  return {
    date,
    axis1Score: report.axis1.score,
    axis1Total: report.axis1.followUpTasks,
    axis1Hits: report.axis1.tasksWithUsefulCarryForward,
    axis2AvgUsefulness: report.axis2.avgUsefulness,
    axis2Retrievals: report.axis2.totalRetrievals,
    axis2PrefCount: report.axis2.totalPreferenceMemories,
    axis3FreshScore: report.axis3.freshScore,
    axis3TotalRetrieved: report.axis3.totalUniqueMemoriesRetrieved,
    axis3ExpiredPct: report.axis3.buckets.expired.pctOfRetrieved,
    totalMemories: report.storeSnapshot.totalMemories,
    searchableMemories: report.storeSnapshot.totalMemories - report.storeSnapshot.expiredMemories,
    expiredMemories: report.storeSnapshot.expiredMemories,
    backfilled: false,
  };
}

/** 3-axis memory quality evaluation with over-time trend tracking and KV-backed historical backfill. */
export default async function memoryEval(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args || {});
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };

  const days = parsed.data.days || 30;
  const freshDays = parsed.data.freshDays || 14;
  const usefulnessThreshold = parsed.data.usefulnessThreshold ?? 0.6;
  const backfillDays = parsed.data.backfillDays ?? 14;
  const publishPage = parsed.data.publishPage !== false;
  const writeAgentFs = parsed.data.writeAgentFs !== false;

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const report: any = { generatedAt: now, days, freshDays, usefulnessThreshold };

  // ─── Axis 1: Carry-forward context ───────────────────────────────────
  const w = `datetime('now','-${days} days')`;

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

  // ─── History persistence (KV) ───────────────────────────────────────

  let history: DailyPoint[] = [];
  try {
    const kvResult = await ctx.swarm.kv_get({ key: KV_KEY, namespace: KV_NS });
    const payload = kvResult?.data ?? kvResult;
    if (Array.isArray(payload?.value)) history = payload.value;
  } catch (_e) {
    // first run — no history yet
  }

  const todayPoint = reportToDailyPoint(today, report);

  if (backfillDays > 0) {
    const existingDates = new Set(history.map((p) => p.date));
    const toBackfill: string[] = [];
    for (let i = 1; i <= backfillDays; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      if (!existingDates.has(dateStr)) toBackfill.push(dateStr);
    }
    for (const dateStr of toBackfill) {
      try {
        const pt = await computeBackfillPoint(ctx, dateStr, days, freshDays, usefulnessThreshold);
        history.push(pt);
      } catch (_e) {
        // skip dates that fail
      }
    }
  }

  const idx = history.findIndex((p) => p.date === today);
  if (idx >= 0) history[idx] = todayPoint;
  else history.push(todayPoint);

  history.sort((a, b) => a.date.localeCompare(b.date));

  try {
    await ctx.swarm.kv_set({ key: KV_KEY, namespace: KV_NS, value: history });
  } catch (_e) {
    report.kvError = "kv_set failed — history not persisted this run";
  }

  report.historyPoints = history.length;

  // ─── Markdown report ─────────────────────────────────────────────────

  const md = buildMarkdownReport(report);

  if (writeAgentFs) {
    try {
      await ctx.swarm.agent_fs_write({
        path: `docs/memory-eval-${today}.md`,
        content: md,
        message: `Memory eval report ${today}`,
        org: "648a5f3c-35c8-4f11-8673-b89de52cd6bd",
      });
    } catch (_e) {
      report.agentFsError = "agent_fs_write failed — report still available in page + return value";
    }
  }

  // ─── Publish dashboard page ──────────────────────────────────────────

  if (publishPage) {
    const html = buildDashboardHtml(report, history);
    try {
      const response = await ctx.swarm.page_create({
        title: "Memory Eval — 3-Axis Dashboard",
        slug: "memory-eval",
        description: `3-axis memory quality dashboard: carry-forward ${report.axis1.score}%, preferences usefulness ${report.axis2.avgUsefulness}, freshness ${report.axis3.freshScore}%. ${history.length} data points.`,
        contentType: "text/html",
        authMode: "authed",
        body: html,
      });
      const payload = response?.data ?? response;
      report.page = {
        id: payload?.id ?? payload?.page?.id ?? null,
        appUrl: payload?.appUrl ?? payload?.app_url ?? null,
        apiUrl: payload?.apiUrl ?? payload?.api_url ?? null,
        version: payload?.version ?? payload?.page?.version ?? null,
      };
    } catch (_e) {
      report.pageError = "page_create failed";
    }
  }

  return report;
}

function buildMarkdownReport(r: any): string {
  const lines: string[] = [];
  const ln = (s = "") => lines.push(s);

  ln(`# Memory Eval — 3-Axis Report`);
  ln(`> Generated: ${r.generatedAt} · Window: ${r.days} days · History: ${r.historyPoints ?? 1} points`);
  ln();
  ln(`## Summary`);
  ln();
  ln(`| Axis | Score | Soft Target |`);
  ln(`|------|-------|-------------|`);
  ln(`| 1 — Carry-forward context | **${r.axis1.score}%** | ${r.axis1.softTarget}% |`);
  ln(`| 2 — Preferences avg usefulness | **${r.axis2.avgUsefulness}** | >0.6 |`);
  ln(`| 3 — Freshness (% fresh retrieved) | **${r.axis3.freshScore}%** | ${r.axis3.softTarget}% |`);
  ln();
  ln(
    `**Store:** ${r.storeSnapshot.totalMemories} total memories, ${r.storeSnapshot.memoriesEverAccessed} ever accessed, ${r.storeSnapshot.expiredMemories} expired.`,
  );
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

function buildDashboardHtml(report: any, history: DailyPoint[]): string {
  const fmtNum = (v: unknown) =>
    typeof v === "number" ? new Intl.NumberFormat("en-US").format(v) : String(v ?? "");
  const dataJson = JSON.stringify(history);

  const metricCards = [
    ["Carry-forward", `${report.axis1.score}%`],
    ["Pref Usefulness", report.axis2.avgUsefulness],
    ["Freshness", `${report.axis3.freshScore}%`],
    ["Total Memories", report.storeSnapshot.totalMemories],
  ]
    .map(
      ([label, value]) =>
        `<div class="metric"><strong>${esc(fmtNum(value))}</strong><span>${esc(label)}</span></div>`,
    )
    .join("");

  const findingSections = buildFindingsHtml(report);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f2ea">
  <title>Memory Eval — 3-Axis Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f2ea; --panel: #ffffff; --ink: #18181b; --muted: #5f6368;
      --line: #ded8cb; --accent: #255c99;
      --danger: #b42318; --danger-bg: #fff1f0;
      --warn: #b54708; --warn-bg: #fff7ed;
      --note: #175cd3; --note-bg: #eff6ff;
      --low: #067647; --low-bg: #ecfdf3;
      --radius: 8px;
      --shadow: 0 1px 2px rgba(24,24,27,.06), 0 14px 36px rgba(24,24,27,.07);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
      font-size: 16px; line-height: 1.55;
    }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }
    header { margin-bottom: 28px; }
    .eyebrow {
      margin: 0 0 8px; color: var(--muted); font-size: 13px; font-weight: 750;
      letter-spacing: .08em; text-transform: uppercase;
    }
    h1 { margin: 0; max-width: 860px; font-size: clamp(2rem,4vw,3rem); line-height: 1.05; }
    .lede { max-width: 780px; margin: 16px 0 0; color: var(--muted); font-size: 18px; }
    .metrics {
      display: grid; grid-template-columns: repeat(4, minmax(0,1fr));
      gap: 12px; margin: 32px 0;
    }
    .metric, .section, .chart-card, details {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: var(--radius); box-shadow: var(--shadow);
    }
    .metric { padding: 18px; }
    .metric strong { display: block; font-size: 32px; line-height: 1; font-variant-numeric: tabular-nums; }
    .metric span { display: block; margin-top: 8px; color: var(--muted); font-size: 13px; font-weight: 650; }
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 24px 0; }
    .chart-card { padding: 20px; }
    .chart-card h2 { margin: 0 0 4px; font-size: 17px; line-height: 1.3; }
    .chart-note { margin: 8px 0 0; color: var(--muted); font-size: 12px; font-style: italic; }
    .chart-wrap { position: relative; height: 240px; margin-top: 12px; }
    .section { margin-top: 18px; padding: 24px; }
    .section-grid { display: grid; grid-template-columns: 260px minmax(0,1fr); gap: 28px; }
    .section-kicker {
      margin: 0 0 12px; color: var(--accent); font-size: 13px; font-weight: 800;
      letter-spacing: .08em; text-transform: uppercase;
    }
    .check-list { display: grid; gap: 8px; }
    .check {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line);
    }
    .check span { color: var(--muted); font-size: 13px; }
    .check strong { font-size: 18px; font-variant-numeric: tabular-nums; }
    .section-head {
      display: flex; align-items: start; justify-content: space-between;
      gap: 16px; margin-bottom: 16px;
    }
    .section-head h2 { max-width: 680px; margin: 0; font-size: 24px; line-height: 1.2; }
    .section-head > span { flex: 0 0 auto; color: var(--muted); font-size: 13px; font-weight: 700; white-space: nowrap; }
    .findings { display: grid; gap: 12px; }
    .finding {
      border: 1px solid var(--line); border-left: 4px solid var(--note);
      border-radius: var(--radius); padding: 16px; background: #fffdf8;
    }
    .finding.danger { border-left-color: var(--danger); }
    .finding.warn { border-left-color: var(--warn); }
    .finding.low { border-left-color: var(--low); }
    .finding-head { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
    .finding-id { margin: 0 0 4px; color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }
    h3 { margin: 0; font-size: 17px; line-height: 1.3; }
    .pill {
      display: inline-flex; align-items: center; min-height: 26px; padding: 4px 9px;
      border-radius: 999px; font-size: 12px; font-weight: 800; text-transform: uppercase; white-space: nowrap;
    }
    .pill.danger { background: var(--danger-bg); color: var(--danger); }
    .pill.warn { background: var(--warn-bg); color: var(--warn); }
    .pill.note { background: var(--note-bg); color: var(--note); }
    .pill.low { background: var(--low-bg); color: var(--low); }
    .action { margin: 10px 0 0; color: var(--muted); }
    .sample-table { margin-top: 14px; overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
    table { width: 100%; min-width: 480px; border-collapse: collapse; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
    td { max-width: 360px; color: #27272a; font-size: 13px; overflow-wrap: anywhere; }
    tr:last-child td { border-bottom: 0; }
    details { margin-top: 24px; padding: 18px; }
    summary { cursor: pointer; font-weight: 800; }
    pre {
      margin: 16px 0 0; max-height: 560px; overflow: auto; padding: 16px;
      border-radius: var(--radius); background: #111827; color: #f9fafb;
      font-size: 12px; line-height: 1.45;
    }
    .backfill-legend {
      margin: 0 0 8px; padding: 8px 12px; background: var(--note-bg);
      border-radius: var(--radius); font-size: 13px; color: var(--note);
    }
    @media (max-width: 860px) {
      main { width: min(100% - 24px, 1120px); padding-top: 32px; }
      .metrics { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .chart-grid { grid-template-columns: 1fr; }
      .section-grid { grid-template-columns: 1fr; gap: 18px; }
    }
    @media (max-width: 520px) { .metrics { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Generated ${esc(report.generatedAt)}</p>
      <h1>Memory Eval — 3-Axis Dashboard</h1>
      <p class="lede">${esc(`${report.days}-day window · Axis 1 (carry-forward): ${report.axis1.score}% · Axis 2 (preferences): ${report.axis2.avgUsefulness} · Axis 3 (freshness): ${report.axis3.freshScore}% · ${history.length} data points`)}</p>
    </header>

    <section class="metrics" aria-label="Current scores">${metricCards}</section>

    <p class="backfill-legend">
      <strong>Chart legend:</strong> Solid lines = measured data. Dashed gray = soft target.
      Axes 1 &amp; 3 are backfilled from audit tables. Axis 2 (preferences) is forward-only — it queries current memory state and cannot be reconstructed historically.
    </p>

    <section class="chart-grid">
      <div class="chart-card">
        <h2>Axis 1 — Carry-forward Context (%)</h2>
        <div class="chart-wrap"><canvas id="c1"></canvas></div>
      </div>
      <div class="chart-card">
        <h2>Axis 2 — Preferences Usefulness</h2>
        <div class="chart-wrap"><canvas id="c2"></canvas></div>
        <p class="chart-note">Forward-only: cannot be reconstructed from historical data. Starts from first live run.</p>
      </div>
      <div class="chart-card">
        <h2>Axis 3 — Freshness Score (%)</h2>
        <div class="chart-wrap"><canvas id="c3"></canvas></div>
      </div>
      <div class="chart-card">
        <h2>Memory Corpus</h2>
        <div class="chart-wrap"><canvas id="c4"></canvas></div>
      </div>
    </section>

    ${findingSections}

    <details>
      <summary>Compressed JSON appendix</summary>
      <pre>${esc(JSON.stringify(report, null, 2))}</pre>
    </details>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <script>
  (function() {
    var H = ${dataJson};
    var labels = H.map(function(p){ return p.date.slice(5); });
    var fullLabels = H.map(function(p){ return p.date; });
    var baseOpts = {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: function(items) { return fullLabels[items[0].dataIndex] || ''; }
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 15 } },
        y: { beginAtZero: true, grid: { color: '#ded8cb40' }, ticks: { font: { size: 11 } } }
      },
      elements: { point: { radius: 3, hoverRadius: 5 }, line: { tension: 0.3, borderWidth: 2 } }
    };

    function targetDs(label, val, len) {
      return {
        label: label, data: Array(len).fill(val),
        borderColor: '#94a3b8', borderDash: [6,4], borderWidth: 1.5,
        pointRadius: 0, pointHoverRadius: 0, fill: false
      };
    }

    new Chart(document.getElementById('c1'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Carry-forward %', data: H.map(function(p){return p.axis1Score;}), borderColor: '#2563eb', backgroundColor: '#2563eb20', fill: true },
          targetDs('Target 60%', 60, H.length)
        ]
      },
      options: Object.assign({}, baseOpts, { scales: Object.assign({}, baseOpts.scales, { y: Object.assign({}, baseOpts.scales.y, { max: 100 }) }) })
    });

    new Chart(document.getElementById('c2'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Avg Usefulness', data: H.map(function(p){return p.axis2AvgUsefulness;}), borderColor: '#7c3aed', backgroundColor: '#7c3aed20', fill: true, spanGaps: false },
          targetDs('Target 0.6', 0.6, H.length)
        ]
      },
      options: Object.assign({}, baseOpts, { scales: Object.assign({}, baseOpts.scales, { y: Object.assign({}, baseOpts.scales.y, { max: 1, ticks: Object.assign({}, baseOpts.scales.y.ticks, { stepSize: 0.2 }) }) }) })
    });

    new Chart(document.getElementById('c3'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Freshness %', data: H.map(function(p){return p.axis3FreshScore;}), borderColor: '#059669', backgroundColor: '#05966920', fill: true },
          targetDs('Target 80%', 80, H.length)
        ]
      },
      options: Object.assign({}, baseOpts, { scales: Object.assign({}, baseOpts.scales, { y: Object.assign({}, baseOpts.scales.y, { max: 100 }) }) })
    });

    new Chart(document.getElementById('c4'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Total', data: H.map(function(p){return p.totalMemories;}), borderColor: '#2563eb', fill: false },
          { label: 'Searchable', data: H.map(function(p){return p.searchableMemories;}), borderColor: '#059669', fill: false },
          { label: 'Expired', data: H.map(function(p){return p.expiredMemories;}), borderColor: '#dc2626', fill: false }
        ]
      },
      options: baseOpts
    });
  })();
  </script>
</body>
</html>`;
}

function buildFindingsHtml(report: any): string {
  const severityTone = (s?: string) =>
    s === "critical" ? "danger" : s === "high" ? "warn" : s === "medium" ? "note" : "low";
  const fmtMetric = (v: unknown) =>
    typeof v === "number" ? new Intl.NumberFormat("en-US").format(v) : String(v ?? "");
  const humanLabel = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[-_.]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

  type Finding = { id: string; severity?: string; summary: string; action?: string; samples?: any[] };
  type Section = {
    key: string;
    label?: string;
    goal: string;
    findingCount?: number;
    checks?: Record<string, unknown>;
    findings?: Finding[];
  };

  const sections: Section[] = [
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
                severity: report.axis1.score >= 60 ? "low" : report.axis1.score >= 30 ? "medium" : "high",
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
            report.axis3.freshScore >= 80 ? "low" : report.axis3.freshScore >= 50 ? "medium" : "high",
          summary: `${report.axis3.freshScore}% of retrieved memories are fresh (<${report.axis3.freshDays}d). Aging: ${report.axis3.buckets.aging.pctOfRetrieved}%, Stranded: ${report.axis3.buckets.stranded.pctOfRetrieved}%, Expired: ${report.axis3.buckets.expired.pctOfRetrieved}%.`,
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
  ];

  return sections
    .map((section) => {
      const findings = (section.findings || [])
        .map(
          (f) => `<article class="finding ${esc(severityTone(f.severity))}">
          <div class="finding-head">
            <div>
              <p class="finding-id">${esc(f.id)}</p>
              <h3>${esc(f.summary)}</h3>
            </div>
            <span class="pill ${esc(severityTone(f.severity))}">${esc(f.severity || "low")}</span>
          </div>
          ${f.action ? `<p class="action">${esc(f.action)}</p>` : ""}
          ${renderSamples(f.samples)}
        </article>`,
        )
        .join("");
      const checks = Object.entries(section.checks || {})
        .map(
          ([label, value]) =>
            `<div class="check"><span>${esc(humanLabel(label))}</span><strong>${esc(fmtMetric(value))}</strong></div>`,
        )
        .join("");
      return `<section class="section">
      <div class="section-grid">
        <aside class="checks">
          <p class="section-kicker">${esc(section.label || humanLabel(section.key))}</p>
          <div class="check-list">${checks}</div>
        </aside>
        <div>
          <div class="section-head">
            <h2>${esc(section.goal)}</h2>
            <span>${esc(fmtMetric(section.findingCount ?? section.findings?.length ?? 0))} finding(s)</span>
          </div>
          <div class="findings">${findings || '<p class="empty">No actionable findings.</p>'}</div>
        </div>
      </div>
    </section>`;
    })
    .join("\n");
}

function renderSamples(samples?: unknown[]): string {
  if (!Array.isArray(samples) || samples.length === 0) return "";
  const normalized = samples.map((row) =>
    row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : { value: row },
  );
  const columns = Array.from(new Set(normalized.flatMap((row) => Object.keys(row).slice(0, 6)))).slice(0, 6);
  if (columns.length === 0) return "";
  const renderVal = (v: unknown) =>
    Array.isArray(v) ? v.map((i) => (typeof i === "object" ? JSON.stringify(i) : String(i ?? ""))).join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v ?? "");
  const rows = normalized
    .map((row) => `<tr>${columns.map((c) => `<td>${esc(renderVal(row[c]))}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="sample-table"><table>
    <thead><tr>${columns.map((c) => `<th>${esc(c.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()))}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}
