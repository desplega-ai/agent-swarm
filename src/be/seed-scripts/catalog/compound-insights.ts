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
  includeScriptCandidates: z
    .boolean()
    .optional()
    .describe("Include high-frequency tool-triplet candidates for future seed scripts (default true)"),
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

function asNumber(value: any): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function percent(part: number, total: number): number {
  return total > 0 ? round1((part / total) * 100) : 0;
}

function extractToolName(content: string): string | null {
  const match = content.match(/"type"\s*:\s*"tool_use"[\s\S]*?"name"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

function toolSlug(tool: string): string {
  return tool
    .replace(/^mcp__/, "")
    .replace(/__/g, "-")
    .replace(/_/g, "-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function decodeFloat32Blob(value: any): Float32Array | null {
  if (!value) return null;
  let bytes: Uint8Array | null = null;
  if (value instanceof Uint8Array) bytes = value;
  else if (Array.isArray(value)) bytes = Uint8Array.from(value);
  else if (typeof value === "object" && Array.isArray(value.data)) bytes = Uint8Array.from(value.data);
  else if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
      bytes = Uint8Array.from(Object.values(value) as number[]);
    }
  }
  if (!bytes || bytes.byteLength < 4 || bytes.byteLength % 4 !== 0) return null;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
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
  const includeScriptCandidates = parsed.data.includeScriptCandidates !== false;
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

  // Memory health (whole store, by scope + source). Pollution markers are
  // SQL-light counts plus JS-side embedding similarity where available; prod
  // SQLite does not expose a scalar cosine_similarity() function.
  if (includeMemoryHealth) {
    const memRows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT scope, source, count(*) as cnt,
                     sum(case when accessCount = 0 then 1 else 0 end) as zeroAccess,
                     sum(case when sourceTaskId IS NOT NULL OR sourcePath IS NOT NULL then 1 else 0 end) as referenced
              FROM agent_memory GROUP BY scope, source`,
      }),
    );
    const totalMem = memRows.reduce((s: number, r: any) => s + (r.cnt ?? 0), 0);
    const bySource: any = {};
    for (const r of memRows) {
      bySource[r.source] ??= {
        total: 0,
        percentOfStore: 0,
        zeroAccess: 0,
        zeroAccessPercent: 0,
        referenced: 0,
      };
      bySource[r.source].total += asNumber(r.cnt);
      bySource[r.source].zeroAccess += asNumber(r.zeroAccess);
      bySource[r.source].referenced += asNumber(r.referenced);
    }
    for (const source of Object.keys(bySource)) {
      bySource[source].percentOfStore = percent(bySource[source].total, totalMem);
      bySource[source].zeroAccessPercent = percent(bySource[source].zeroAccess, bySource[source].total);
    }

    const autoSnapshotSources = ["session_summary", "task_completion"];
    const autoSnapshotTotal = autoSnapshotSources.reduce(
      (sum, source) => sum + (bySource[source]?.total ?? 0),
      0,
    );
    const popularButUseless = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT id, name, source, accessCount, alpha, beta,
                     round(alpha / nullif(alpha + beta, 0), 3) as usefulness,
                     substr(content, 1, 180) as preview
              FROM agent_memory
              WHERE source IN ('session_summary','task_completion')
                AND accessCount >= 5
                AND alpha <= beta
              ORDER BY accessCount DESC, beta DESC LIMIT 10`,
      }),
    ).map((r: any) => ({
      id: r.id,
      name: r.name,
      source: r.source,
      accessCount: asNumber(r.accessCount),
      usefulness: Number(r.usefulness ?? 0),
      preview: r.preview,
    }));
    const zeroAccessStaleRefRows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT source, count(*) as count
              FROM agent_memory
              WHERE accessCount = 0
                AND (sourceTaskId IS NOT NULL OR sourcePath IS NOT NULL)
                AND createdAt < datetime('now','-${days} days')
              GROUP BY source ORDER BY count DESC`,
      }),
    );

    const similarityRows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT id, name, source, accessCount, embedding
              FROM agent_memory
              WHERE source IN ('session_summary','task_completion')
                AND embedding IS NOT NULL
              ORDER BY accessCount DESC LIMIT 30`,
      }),
    );
    let strongestAutoSnapshotPair: any = null;
    const vectors = similarityRows
      .map((r: any) => ({ ...r, vector: decodeFloat32Blob(r.embedding) }))
      .filter((r: any) => r.vector);
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        const similarity = cosineSimilarity(vectors[i].vector, vectors[j].vector);
        if (!strongestAutoSnapshotPair || similarity > strongestAutoSnapshotPair.similarity) {
          strongestAutoSnapshotPair = {
            similarity: round1(similarity * 100) / 100,
            a: { id: vectors[i].id, name: vectors[i].name, source: vectors[i].source },
            b: { id: vectors[j].id, name: vectors[j].name, source: vectors[j].source },
          };
        }
      }
    }

    insights.memoryHealth = {
      total: totalMem,
      byScope: memRows.reduce((m: any, r: any) => {
        m[r.scope] = (m[r.scope] ?? 0) + r.cnt;
        return m;
      }, {}),
      bySource,
      pollution: {
        autoSnapshotSources,
        autoSnapshotTotal,
        autoSnapshotPercent: percent(autoSnapshotTotal, totalMem),
        popularButUselessAutoSnapshots: popularButUseless,
        zeroAccessStaleRefs: {
          total: zeroAccessStaleRefRows.reduce((sum: number, r: any) => sum + asNumber(r.count), 0),
          bySource: zeroAccessStaleRefRows.reduce((m: any, r: any) => {
            m[r.source] = asNumber(r.count);
            return m;
          }, {}),
        },
        similarityCheck: {
          sqliteCosineSimilarityAvailable: false,
          path: "js",
          sampledAutoSnapshots: vectors.length,
          strongestAutoSnapshotPair,
        },
      },
    };
  }

  // Evolution/self-scripting candidates: high-frequency consecutive tool
  // triplets are good prompts for a future seed script.
  if (includeScriptCandidates) {
    const rows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `WITH raw AS (
                 SELECT sessionId, iteration, lineNumber, content,
                        json_extract(content, '$.tool_name') as jsonToolName
                 FROM session_logs
                 WHERE createdAt > ${w}
                   AND (content LIKE '%"type":"tool_use"%' OR json_extract(content, '$.tool_name') IS NOT NULL)
               )
               SELECT sessionId, iteration, lineNumber, jsonToolName, content
               FROM raw ORDER BY sessionId, iteration, lineNumber LIMIT 100`,
      }),
    );
    const bySession = new Map<string, string[]>();
    for (const row of rows) {
      const tool = row.jsonToolName || extractToolName(String(row.content ?? ""));
      if (!tool) continue;
      const key = String(row.sessionId ?? "unknown");
      const tools = bySession.get(key) ?? [];
      tools.push(tool);
      bySession.set(key, tools);
    }
    const counts = new Map<string, { tools: string[]; count: number }>();
    for (const tools of bySession.values()) {
      for (let i = 0; i <= tools.length - 3; i++) {
        const triplet = tools.slice(i, i + 3);
        const key = triplet.join(" -> ");
        const current = counts.get(key) ?? { tools: triplet, count: 0 };
        current.count += 1;
        counts.set(key, current);
      }
    }
    insights.scriptCandidates = [...counts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((r) => ({
        tools: r.tools,
        count: r.count,
        suggestedName: r.tools.map(toolSlug).filter(Boolean).slice(0, 3).join("-").slice(0, 80),
      }));
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
