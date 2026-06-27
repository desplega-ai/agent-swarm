import { z } from "zod";
import { publishCatalogReportPage } from "./catalog-report";

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
  includeScriptUsage: z
    .boolean()
    .optional()
    .describe("Include actual script run, creation, and edit metrics (default true)"),
  includeCostAndTokens: z
    .boolean()
    .optional()
    .describe("Include session cost and token metrics with honesty rails (default true)"),
  includeByAgent: z
    .boolean()
    .optional()
    .describe("Include per-agent task/completion/failure breakdown (default true)"),
  publishPage: z.boolean().optional().describe("Publish an authed HTML page (default true)"),
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

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? null;
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

function summarizeScriptUsage(rows: any[], creationRows: any[], editRows: any[], toolRows: any[]) {
  const terminalStatuses = new Set(["completed", "failed", "cancelled", "aborted_limit"]);
  const failureStatuses = new Set(["failed", "cancelled", "aborted_limit"]);
  const durations = rows
    .map((r) => asNumber(r.durationMs))
    .filter((duration) => duration > 0);
  const byScript = new Map<
    string,
    {
      scriptName: string;
      runs: number;
      completed: number;
      failed: number;
      successRate: number;
      durationP50Ms: number | null;
      durationP95Ms: number | null;
      inline: number;
      workflow: number;
      durations: number[];
    }
  >();

  for (const row of rows) {
    const name = String(row.scriptName || "(inline source)");
    const current =
      byScript.get(name) ??
      {
        scriptName: name,
        runs: 0,
        completed: 0,
        failed: 0,
        successRate: 0,
        durationP50Ms: null,
        durationP95Ms: null,
        inline: 0,
        workflow: 0,
        durations: [],
      };
    current.runs += 1;
    if (row.kind === "inline") current.inline += 1;
    if (row.kind === "workflow") current.workflow += 1;
    if (row.status === "completed") current.completed += 1;
    if (failureStatuses.has(String(row.status))) current.failed += 1;
    const duration = asNumber(row.durationMs);
    if (duration > 0) current.durations.push(duration);
    byScript.set(name, current);
  }

  const perScript = [...byScript.values()]
    .map((script) => ({
      scriptName: script.scriptName,
      runs: script.runs,
      completed: script.completed,
      failed: script.failed,
      successRate: percent(script.completed, script.runs),
      durationP50Ms: percentile(script.durations, 50),
      durationP95Ms: percentile(script.durations, 95),
      inline: script.inline,
      workflow: script.workflow,
    }))
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 20);

  const creationsByScope: Record<string, number> = {};
  let creations = 0;
  let scratchCreations = 0;
  for (const row of creationRows) {
    const count = asNumber(row.count);
    if (asNumber(row.isScratch) === 1) {
      scratchCreations += count;
    } else {
      creations += count;
      creationsByScope[String(row.scope || "unknown")] =
        (creationsByScope[String(row.scope || "unknown")] ?? 0) + count;
    }
  }

  const editsByScope: Record<string, number> = {};
  let edits = 0;
  for (const row of editRows) {
    const count = asNumber(row.count);
    edits += count;
    editsByScope[String(row.scope || "unknown")] =
      (editsByScope[String(row.scope || "unknown")] ?? 0) + count;
  }

  return {
    source: {
      authoritativeRuns: "script_runs",
      mcpCallSignal: "session_logs tool_use for script tools",
      reconciliation:
        "`script-run` via MCP calls /api/scripts/run, which records kind='inline' rows in script_runs; launch-script-run/workflows record kind='workflow'. session_logs counts agent tool calls and must not be added to script_runs totals.",
    },
    runs: {
      total: rows.length,
      inline: rows.filter((r) => r.kind === "inline").length,
      workflow: rows.filter((r) => r.kind === "workflow").length,
      completed: rows.filter((r) => r.status === "completed").length,
      failed: rows.filter((r) => failureStatuses.has(String(r.status))).length,
      runningOrPaused: rows.filter((r) => !terminalStatuses.has(String(r.status))).length,
      successRate: percent(
        rows.filter((r) => r.status === "completed").length,
        rows.length,
      ),
      durationP50Ms: percentile(durations, 50),
      durationP95Ms: percentile(durations, 95),
      perScript,
    },
    creations: {
      totalNonScratch: creations,
      scratch: scratchCreations,
      byScope: creationsByScope,
    },
    edits: {
      total: edits,
      byScope: editsByScope,
    },
    mcpToolCalls: toolRows.map((r) => ({ tool: r.tool, calls: asNumber(r.calls) })),
  };
}

function summarizeCostAndTokens(rows: any[]) {
  const trustedSources = new Set(["harness", "pricing-table"]);
  const trustedRows = rows.filter((r) => trustedSources.has(String(r.costSource)));
  const unpricedRows = rows.filter((r) => String(r.costSource) === "unpriced");
  const trustedTaskRows = trustedRows.filter((r) => r.taskId);
  const trustedTaskIds = new Set(trustedTaskRows.map((r) => String(r.taskId)));
  const trustedTaskSpend = trustedTaskRows.reduce((sum, r) => sum + asNumber(r.totalCostUsd), 0);
  const nonTaskRows = rows.filter((r) => !r.taskId);
  const totalSpend = rows.reduce((sum, r) => sum + asNumber(r.totalCostUsd), 0);
  const trustedSpend = trustedRows.reduce((sum, r) => sum + asNumber(r.totalCostUsd), 0);

  const sumToken = (field: string) =>
    rows.reduce((sum, r) => (r[field] === null || r[field] === undefined ? sum : sum + asNumber(r[field])), 0);
  const unknownCount = (field: string) =>
    rows.filter((r) => r[field] === null || r[field] === undefined).length;

  const groupBy = (field: string) => {
    const grouped = new Map<
      string,
      {
        key: string;
        rows: number;
        spendUsd: number;
        trustedSpendUsd: number;
        unpricedRows: number;
      }
    >();
    for (const row of rows) {
      const key = String(row[field] || "unknown");
      const current =
        grouped.get(key) ?? {
          key,
          rows: 0,
          spendUsd: 0,
          trustedSpendUsd: 0,
          unpricedRows: 0,
        };
      current.rows += 1;
      current.spendUsd += asNumber(row.totalCostUsd);
      if (trustedSources.has(String(row.costSource))) current.trustedSpendUsd += asNumber(row.totalCostUsd);
      if (String(row.costSource) === "unpriced") current.unpricedRows += 1;
      grouped.set(key, current);
    }
    return [...grouped.values()]
      .map((r) => ({
        ...r,
        spendUsd: round4(r.spendUsd),
        trustedSpendUsd: round4(r.trustedSpendUsd),
      }))
      .sort((a, b) => b.spendUsd - a.spendUsd);
  };

  return {
    source: {
      table: "session_costs",
      providerDerivation:
        "provider is derived from agents.harness_provider, then agents.provider, because session_costs does not carry a provider column",
      headlineAvgCostRule:
        "avgCostPerTaskUsd excludes unpriced rows and rows with null taskId; null-task sessions are reported separately",
    },
    rows: rows.length,
    taskCountForHeadlineAvg: trustedTaskIds.size,
    avgCostPerTaskUsd:
      trustedTaskIds.size > 0 ? round4(trustedTaskSpend / trustedTaskIds.size) : null,
    totalSpendUsd: round4(totalSpend),
    trustedSpendUsd: round4(trustedSpend),
    trustedRows: trustedRows.length,
    trustedRowPercent: percent(trustedRows.length, rows.length),
    unpricedRows: unpricedRows.length,
    unpricedSpendUsd: round4(unpricedRows.reduce((sum, r) => sum + asNumber(r.totalCostUsd), 0)),
    nonTaskSessionRows: nonTaskRows.length,
    nonTaskSessionSpendUsd: round4(
      nonTaskRows.reduce((sum, r) => sum + asNumber(r.totalCostUsd), 0),
    ),
    tokenTotals: {
      inputTokens: sumToken("inputTokens"),
      outputTokens: sumToken("outputTokens"),
      cacheReadTokens: sumToken("cacheReadTokens"),
      cacheWriteTokens: sumToken("cacheWriteTokens"),
      reasoningOutputTokens: sumToken("reasoningOutputTokens"),
      thinkingTokens: sumToken("thinkingTokens"),
    },
    unknownCounts: {
      cacheWriteTokens: unknownCount("cacheWriteTokens"),
      numTurns: unknownCount("numTurns"),
    },
    byModel: groupBy("model"),
    byAgent: groupBy("agentName"),
    byProvider: groupBy("provider"),
    byCostSource: groupBy("costSource"),
  };
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
  const includeScriptUsage = parsed.data.includeScriptUsage !== false;
  const includeCostAndTokens = parsed.data.includeCostAndTokens !== false;
  const includeByAgent = parsed.data.includeByAgent !== false;
  const publishPage = parsed.data.publishPage !== false;

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

  // Actual script usage. Authoritative run counts come from `script_runs`;
  // session_logs tool_use rows are a separate MCP-call signal for reconciliation
  // and are intentionally not added to run totals.
  if (includeScriptUsage) {
    const runRows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `WITH journal_durations AS (
                 SELECT runId, sum(durationMs) AS journalDurationMs
                 FROM script_run_journal
                 WHERE durationMs IS NOT NULL
                 GROUP BY runId
               )
               SELECT sr.scriptName, sr.kind, sr.status, sr.startedAt, sr.finishedAt,
                      COALESCE(
                        jd.journalDurationMs,
                        CASE
                          WHEN sr.finishedAt IS NOT NULL
                          THEN CAST((julianday(sr.finishedAt) - julianday(sr.startedAt)) * 86400000 AS INTEGER)
                          ELSE NULL
                        END
                      ) AS durationMs
               FROM script_runs sr
               LEFT JOIN journal_durations jd ON jd.runId = sr.id
               WHERE sr.startedAt > ${w}
               ORDER BY sr.startedAt DESC`,
      }),
    );
    const creationRows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT scope, isScratch, count(*) AS count
              FROM scripts
              WHERE createdAt > ${w}
              GROUP BY scope, isScratch`,
      }),
    );
    const editRows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT s.scope, count(*) AS count
              FROM script_versions sv
              JOIN scripts s ON s.id = sv.scriptId
              WHERE sv.changedAt > ${w} AND sv.version > 1
              GROUP BY s.scope`,
      }),
    );
    const scriptToolRows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `WITH tu AS (
                 SELECT substr(content, instr(content,'"type":"tool_use"')) AS tail,
                        json_extract(content, '$.tool_name') as jsonToolName
                 FROM session_logs
                 WHERE createdAt > ${w}
                   AND (content LIKE '%script-run%'
                     OR content LIKE '%launch-script-run%'
                     OR content LIKE '%get-script-run%'
                     OR content LIKE '%list-script-runs%')
               ),
               nm AS (
                 SELECT COALESCE(
                          jsonToolName,
                          CASE
                            WHEN instr(tail,'"name":"') > 0
                            THEN substr(substr(tail, instr(tail,'"name":"')+8), 1, instr(substr(tail, instr(tail,'"name":"')+8), '"')-1)
                            ELSE NULL
                          END
                        ) AS tool
                 FROM tu
               )
               SELECT tool, count(*) AS calls
               FROM nm
               WHERE tool IS NOT NULL AND tool LIKE '%script%'
               GROUP BY tool
               ORDER BY calls DESC`,
      }),
    );
    insights.scriptUsage = summarizeScriptUsage(runRows, creationRows, editRows, scriptToolRows);
  }

  // Cost and token accounting. `costSource='unpriced'` rows are excluded from
  // the headline per-task average, and null taskId rows are reported separately.
  if (includeCostAndTokens) {
    const costRows = rowsToObjects(
      await ctx.swarm.db_query({
        sql: `SELECT sc.taskId, sc.agentId, COALESCE(a.name, sc.agentId, 'unknown') AS agentName,
                     COALESCE(a.harness_provider, a.provider, 'unknown') AS provider,
                     sc.totalCostUsd, sc.inputTokens, sc.outputTokens, sc.cacheReadTokens,
                     sc.cacheWriteTokens, sc.reasoningOutputTokens, sc.thinkingTokens,
                     sc.numTurns, sc.model, sc.costSource
              FROM session_costs sc
              LEFT JOIN agents a ON a.id = sc.agentId
              WHERE sc.createdAt > ${w}`,
      }),
    );
    insights.costAndTokens = summarizeCostAndTokens(costRows);
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

  if (publishPage) {
    const failureFindings = (insights.failureClusters || []).map((cluster: any) => ({
      id: `failure.${String(cluster.reason || "unknown").slice(0, 48)}`,
      severity: cluster.count >= 5 ? "high" : cluster.count >= 2 ? "medium" : "low",
      summary: `${cluster.count} real failure(s): ${cluster.reason}`,
      action: "Review the repeated failure mode and decide whether to fix, retry, or add a temporary watch item.",
      samples: [cluster],
    }));
    const scheduleFindings = (insights.scheduleHealth || []).map((schedule: any) => ({
      id: `schedule.${schedule.id}`,
      severity: schedule.failureRate >= 50 ? "high" : "medium",
      summary: `${schedule.name} has ${schedule.failureRate}% real-failure rate.`,
      action: "Inspect recent schedule tasks and repair, retarget, or disable the schedule.",
      samples: [schedule],
    }));
    const memoryPollution = insights.memoryHealth?.pollution;
    const memoryFindings = memoryPollution?.autoSnapshotPercent
      ? [
          {
            id: "memory.auto-snapshot-share",
            severity: memoryPollution.autoSnapshotPercent >= 40 ? "high" : "medium",
            summary: `Automatic snapshots are ${memoryPollution.autoSnapshotPercent}% of memory.`,
            action: "Review memory gates and prune low-use automatic snapshots before adding more.",
            samples: [memoryPollution],
          },
        ]
      : [];
    const scriptFindings = (insights.scriptCandidates || []).map((candidate: any) => ({
      id: `script-candidate.${candidate.suggestedName || "unnamed"}`,
      severity: candidate.count >= 3 ? "medium" : "low",
      summary: `${candidate.count} repeated tool triplet(s): ${candidate.tools.join(" -> ")}`,
      action: "Consider turning this repeated workflow into a reusable seeded script.",
      samples: [candidate],
    }));
    const scriptUsageFindings = insights.scriptUsage
      ? [
          {
            id: "script-usage.actual-runs",
            severity: "low",
            summary: `${insights.scriptUsage.runs.total} actual script run(s): ${insights.scriptUsage.runs.inline} one-off, ${insights.scriptUsage.runs.workflow} recurring/workflow.`,
            action: "Use script_runs as the authoritative run count; use session_logs only as an MCP-call reconciliation signal.",
            samples: [insights.scriptUsage],
          },
        ]
      : [];
    const costFindings = insights.costAndTokens
      ? [
          {
            id: "cost-and-tokens.headline",
            severity:
              insights.costAndTokens.unpricedRows > 0 || insights.costAndTokens.nonTaskSessionRows > 0
                ? "medium"
                : "low",
            summary: `$${insights.costAndTokens.totalSpendUsd} total session spend; avg task cost $${insights.costAndTokens.avgCostPerTaskUsd ?? "n/a"} over trusted task rows.`,
            action: "Keep unpriced and null-task session spend separate from the headline per-task average.",
            samples: [insights.costAndTokens],
          },
        ]
      : [];

    insights.page = await publishCatalogReportPage(
      {
        title: "Compound Insights Audit",
        slug: "compound-insights",
        description: "Swarm-wide daily ops snapshot for compounding and reliability review.",
        generatedAt: insights.generatedAt,
        lede: `Swarm-wide ${days}-day snapshot: ${insights.taskSummary.total} task(s), ${insights.taskSummary.completionRate}% completion rate, ${insights.taskSummary.failureRate}% failure rate.`,
        metrics: [
          ["Tasks", insights.taskSummary.total],
          ["Completed", insights.taskSummary.completed],
          ["Failed", insights.taskSummary.failed],
          ["Failure clusters", insights.failureClusters?.length || 0],
          ["Script runs", insights.scriptUsage?.runs?.total ?? 0],
          ["Total spend", insights.costAndTokens?.totalSpendUsd ?? 0],
        ],
        sections: [
          {
            key: "failures",
            goal: "Expose repeated real failure modes without counting bookkeeping noise.",
            findingCount: failureFindings.length,
            checks: insights.taskSummary,
            findings: failureFindings,
          },
          {
            key: "schedules",
            goal: "Keep schedule failures visible before daily work compounds stale assumptions.",
            findingCount: scheduleFindings.length,
            checks: { unhealthySchedules: scheduleFindings.length },
            findings: scheduleFindings,
          },
          {
            key: "memory",
            goal: "Detect memory bloat and low-use automatic snapshots.",
            findingCount: memoryFindings.length,
            checks: insights.memoryHealth
              ? {
                  total: insights.memoryHealth.total,
                  autoSnapshotPercent: memoryPollution?.autoSnapshotPercent ?? 0,
                  sampledAutoSnapshots:
                    memoryPollution?.similarityCheck?.sampledAutoSnapshots ?? 0,
                }
              : {},
            findings: memoryFindings,
          },
          {
            key: "script-candidates",
            goal: "Find repeated tool chains worth compressing into reusable scripts.",
            findingCount: scriptFindings.length,
            checks: { candidates: scriptFindings.length },
            findings: scriptFindings,
          },
          {
            key: "script-usage",
            goal: "Track actual one-off and recurring script execution without double-counting MCP tool-use logs.",
            findingCount: scriptUsageFindings.length,
            checks: insights.scriptUsage ?? {},
            findings: scriptUsageFindings,
          },
          {
            key: "cost-and-tokens",
            goal: "Track per-task cost and token consumption while separating unpriced and non-task sessions.",
            findingCount: costFindings.length,
            checks: insights.costAndTokens ?? {},
            findings: costFindings,
          },
        ],
        appendix: insights,
      },
      ctx,
    );
  }

  return insights;
}
