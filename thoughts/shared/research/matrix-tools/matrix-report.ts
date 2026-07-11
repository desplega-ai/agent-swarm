// Build metrics.json from /tmp/matrix/<group>-<n>/ snapshots.
// Groups: [provider-]mode[-seeds]  e.g. scripts-only-2 (legacy claude), pi-full-1, claude-scripts-only-seeds-3
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";

const ROOT = "/tmp/matrix";
const DIR_RE = /^(?:(claude|pi|opencode)-)?(scripts-only|full)(-seeds)?-(\d+)$/;

type RunMetrics = {
  group: string; provider: string; mode: string; seeds: boolean; runId: string;
  result: string; wallMin: number | null; costUsd: number; sessions: number;
  outputTokens: number; toolCalls: Record<string, number>; totalToolCalls: number;
  errors: number; probes: number; seedCalls: number;
  perTask: Array<{ id: string; agent: string; kind: string; status: string; ctxTokens: number | null; toolCalls: number; errors: number }>;
};

const SCRIPT_TOOLS = /script-run|script-upsert|script-search|script-query-types|launch-script-run|get-script-run|list-script-runs|script-delete/;
const PROBE_PAT = /Object\.keys\(ctx|argCount|ctxKeys|swarmKeys|shapes?\s*[:=(]|globalKeys|ctxType/;
const SEED_NAMES = new Set(["delegate", "wait-for-task", "get-child-outputs", "complete-task", "report-progress", "swarm-overview"]);

const SWARM_TOOLS = /^(get-task-details|store-progress|send-task|get-tasks|poll-task|task-action|cancel-task|post-message|read-messages|memory-search|memory-get|memory-edit|memory-delete|memory_rate|get-swarm|my-agent-info|join-swarm|request-human-input|kv-|get-repos|update-repo|list-schedules|get-metrics|resolve-user|slack-|list-workflows|skill-)/;

function categorize(rawName: string): string {
  const name = rawName.replace(/^mcp__agent-swarm(-user)?__/, "").replace(/^swarm_/, "");
  if (rawName === "ToolSearch") return "ToolSearch";
  if (SCRIPT_TOOLS.test(name)) return "script tools";
  if (SWARM_TOOLS.test(name)) return "swarm MCP tools";
  if (/^bash$/i.test(name)) return "Bash";
  return "other";
}

function analyzeRun(dir: string): RunMetrics | null {
  const m0 = dir.match(DIR_RE);
  if (!m0) return null;
  const sumPath = `${ROOT}/${dir}/summary.json`;
  if (!existsSync(sumPath)) return null;
  const summary = JSON.parse(readFileSync(sumPath, "utf8"));
  const provider = summary.provider ?? m0[1] ?? "claude";
  const mode = m0[2];
  const seeds = Boolean(summary.seeds ?? m0[3]);
  const group = `${provider}/${mode}${seeds ? "+seeds" : ""}`;
  const tasks: any[] = existsSync(`${ROOT}/${dir}/tasks.json`) ? JSON.parse(readFileSync(`${ROOT}/${dir}/tasks.json`, "utf8")) : [];

  const m: RunMetrics = {
    group, provider, mode, seeds, runId: m0[4], result: summary.result ?? "?",
    wallMin: summary.parentWallMs ? +(summary.parentWallMs / 60000).toFixed(1) : null,
    costUsd: summary.costs?.totalCostUsd ?? 0, sessions: summary.costs?.totalSessions ?? 0,
    outputTokens: summary.costs?.totalOutputTokens ?? 0,
    toolCalls: {}, totalToolCalls: 0, errors: 0, probes: 0, seedCalls: 0, perTask: [],
  };
  const NAMES: Record<string, string> = {
    "7a1e0000-0000-4000-8000-000000000001": "lead",
    "7a1e0000-0000-4000-8000-000000000002": "analyst",
    "7a1e0000-0000-4000-8000-000000000003": "marketer",
  };

  for (const t of tasks) {
    const logPath = `${ROOT}/${dir}/logs-${t.id.slice(0, 8)}.json`;
    const kind = t.parentTaskId == null ? "parent" : (t.task ?? "").startsWith("Worker task completed") ? "review" : "work";
    const pt = { id: t.id.slice(0, 8), agent: NAMES[t.agentId] ?? "?", kind, status: t.status, ctxTokens: null as number | null, toolCalls: 0, errors: 0 };
    if (existsSync(logPath)) {
      const raw = JSON.parse(readFileSync(logPath, "utf8"));
      const entries: any[] = raw.logs ?? raw.sessionLogs ?? raw ?? [];
      let lastUsage: any = null;
      for (const e of Array.isArray(entries) ? entries : []) {
        let c: any; try { c = JSON.parse(e.content); } catch { continue; }
        // claude stream-json format
        if (c.type === "assistant" && Array.isArray(c.message?.content)) {
          for (const b of c.message.content) {
            if (b.type === "tool_use") {
              m.toolCalls[categorize(b.name ?? "?")] = (m.toolCalls[categorize(b.name ?? "?")] ?? 0) + 1;
              m.totalToolCalls++; pt.toolCalls++;
              const src = typeof b.input?.source === "string" ? b.input.source : "";
              if (src && PROBE_PAT.test(src)) m.probes++;
              if (typeof b.input?.name === "string" && SEED_NAMES.has(b.input.name)) m.seedCalls++;
            }
          }
          if (c.message?.usage) lastUsage = c.message.usage;
        }
        if (c.type === "user" && Array.isArray(c.message?.content)) {
          for (const b of c.message.content) if (b.type === "tool_result" && b.is_error) { m.errors++; pt.errors++; }
        }
        // opencode event stream: tool_start / tool_end / context_usage
        if (e.cli === "opencode" && c) {
          if (c.type === "tool_start" && c.toolName) {
            m.toolCalls[categorize(String(c.toolName))] = (m.toolCalls[categorize(String(c.toolName))] ?? 0) + 1;
            m.totalToolCalls++; pt.toolCalls++;
            const src = JSON.stringify(c.args ?? {});
            if (PROBE_PAT.test(src)) m.probes++;
            const argName = c.args?.name;
            if (typeof argName === "string" && SEED_NAMES.has(argName)) m.seedCalls++;
          }
          if (c.type === "tool_end" && typeof c.result === "string" && /not found|error:|failed/i.test(c.result.slice(0, 120))) { m.errors++; pt.errors++; }
          if (c.type === "context_usage" && c.contextUsedTokens) {
            pt.ctxTokens = c.contextUsedTokens;
          }
        }
        // pi tool errors surface as text results: "Tool X not found"
        if (e.cli === "pi" && c.type === "assistant" && Array.isArray(c.message?.content)) {
          for (const b of c.message.content) {
            if (b.type === "tool_result") {
              const txt = JSON.stringify(b.content ?? "").slice(0, 200);
              if (/not found|error/i.test(txt)) { m.errors++; pt.errors++; }
            }
          }
        }
      }
      if (pt.ctxTokens == null && lastUsage) {
        pt.ctxTokens = (lastUsage.input_tokens ?? lastUsage.input ?? 0) + (lastUsage.cache_read_input_tokens ?? lastUsage.cache_read ?? 0) + (lastUsage.cache_creation_input_tokens ?? lastUsage.cache_write ?? 0) + (lastUsage.output_tokens ?? lastUsage.output ?? 0);
      }
      // provider-uniform context metric recorded by the runner on the task row
      if (t.peakContextTokens) pt.ctxTokens = t.peakContextTokens;
    }
    m.perTask.push(pt);
  }
  return m;
}

function delegatedOk(m: RunMetrics): boolean {
  // Real delegation = both workers got a non-review task (parent linkage optional:
  // weak models in code-mode sometimes create children without parentTaskId).
  const workAgents = new Set(m.perTask.filter((t) => t.kind !== "review" && t.agent !== "lead").map((t) => t.agent));
  return workAgents.has("analyst") && workAgents.has("marketer");
}

const runs = readdirSync(ROOT).filter((d) => DIR_RE.test(d)).sort().map(analyzeRun).filter((r): r is RunMetrics => r != null);

const groups = [...new Set(runs.map((r) => r.group))];
const agg = groups.map((g) => {
  const all = runs.filter((r) => r.group === g);
  const ok = all.filter((r) => r.result === "completed");
  const mean = (f: (r: RunMetrics) => number) => (ok.length ? +(ok.reduce((s, r) => s + f(r), 0) / ok.length).toFixed(2) : 0);
  const workCtx = ok.flatMap((r) => r.perTask.filter((t) => t.kind === "work" && t.ctxTokens).map((t) => t.ctxTokens!));
  const leadCtx = ok.flatMap((r) => r.perTask.filter((t) => t.kind === "parent" && t.ctxTokens).map((t) => t.ctxTokens!));
  return {
    group: g, provider: all[0].provider, mode: all[0].mode, seeds: all[0].seeds,
    attempts: all.length, completed: ok.length, delegatedOk: ok.filter(delegatedOk).length,
    meanCost: mean((r) => r.costUsd), meanWallMin: mean((r) => r.wallMin ?? 0),
    meanToolCalls: mean((r) => r.totalToolCalls), meanErrors: mean((r) => r.errors),
    meanProbes: mean((r) => r.probes), meanSeedCalls: mean((r) => r.seedCalls),
    meanWorkerCtx: workCtx.length ? Math.round(workCtx.reduce((a, b) => a + b, 0) / workCtx.length) : 0,
    meanLeadCtx: leadCtx.length ? Math.round(leadCtx.reduce((a, b) => a + b, 0) / leadCtx.length) : 0,
    meanOutputTokens: mean((r) => r.outputTokens),
  };
});

const data = { runs, agg, generatedAt: new Date().toISOString() };
writeFileSync("/tmp/matrix/metrics.json", JSON.stringify(data, null, 2));
for (const a of agg) console.log(`${a.group}: ${a.completed}/${a.attempts} ok, $${a.meanCost} mean, ${a.meanWallMin}min, ${a.meanToolCalls} calls, ${a.meanErrors} errs, seedCalls=${a.meanSeedCalls}`);
console.log(`runs: ${runs.map((r) => `${r.group}#${r.runId}(${r.result})`).join(", ")}`);
