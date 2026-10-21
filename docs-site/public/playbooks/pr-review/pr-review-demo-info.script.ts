import type { ScriptContext } from "swarm-sdk";

// pr-review-demo-info: what the PR review page shows besides a live run.
// - costs: review cost per PR across every run of the review workflow
// - with `pr`: the PR's commits, CI checks per commit, and the reviews (with cost) run on each commit
// Agent cost is read from session_costs at call time, so runs whose report
// finished before the session row landed still get a real number.

const WF = "<PR_REVIEW_WORKFLOW_ID>";
const RATE_PER_MTOK = 0.042;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export default async function (args: any, ctx: ScriptContext) {
  const repo: string = args?.repo || "desplega-ai/agent-swarm";
  const prNum = Number(args?.pr) || 0;
  const sw: any = ctx.swarm as any;

  const sql = `SELECT r.id, r.status, r.startedAt, r.finishedAt,
      json_extract(r.triggerData,'$.pr') AS pr,
      json_extract(r.triggerData,'$.repo') AS repo,
      json_extract(r.triggerData,'$.sha') AS tsha,
      json_extract(r.triggerData,'$.base') AS tbase,
      json_extract(s.output,'$.result.verdict') AS verdict,
      COALESCE(json_extract(s.output,'$.result.review.sha'), json_extract(s.output,'$.result.pr.headSha')) AS sha,
      COALESCE(json_extract(s.output,'$.result.review.mode'), 'full') AS mode,
      json_extract(s.output,'$.result.review.base') AS base,
      COALESCE(json_extract(s.output,'$.result.summary.jevCostUsd'), 0) AS jev,
      COALESCE(json_extract(s.output,'$.result.cost.clairicUsd'), 0) AS clairic,
      (SELECT COUNT(*) FROM json_each(s.output,'$.result.agentReviews')) AS agentTasks,
      (SELECT SUM(sc.totalCostUsd) FROM session_costs sc WHERE sc.taskId IN (SELECT json_extract(value,'$.taskId') FROM json_each(s.output,'$.result.agentReviews'))) AS agent,
      (SELECT COUNT(DISTINCT sc.taskId) FROM session_costs sc WHERE sc.taskId IN (SELECT json_extract(value,'$.taskId') FROM json_each(s.output,'$.result.agentReviews'))) AS agentCosted,
      (SELECT SUM(COALESCE(json_array_length(json_extract(value,'$.review.findings')),0)) FROM json_each(s.output,'$.result.agentReviews')) AS findings,
      json_extract(s.output,'$.result.summary.flagged') AS flagged,
      json_extract(s.output,'$.result.summary.batches') AS batches
    FROM workflow_runs r
    LEFT JOIN workflow_run_steps s ON s.runId = r.id AND s.nodeId = 'report' AND json_valid(s.output)
    WHERE r.workflowId = '${WF}' AND r.status IN ('completed','failed')
    ORDER BY r.startedAt DESC LIMIT 400`;
  const res: any = await sw.db_query({ sql });
  const cols: string[] = res?.data?.columns || [];
  const rows: any[] = (res?.data?.rows || []).map((row: any[]) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
  const runs = rows.filter((r) => !r.repo || r.repo === repo).map((r) => {
    const agentKnown = Number(r.agentTasks) === 0 || Number(r.agentCosted) === Number(r.agentTasks);
    const agent = r6(Number(r.agent || 0));
    const total = r6(Number(r.jev || 0) + Number(r.clairic || 0) + agent);
    return {
      runId: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
      pr: Number(r.pr), sha: r.sha || r.tsha || null, mode: r.mode, base: r.base || r.tbase || null,
      verdict: r.verdict, findings: Number(r.findings || 0), flagged: Number(r.flagged || 0), batches: Number(r.batches || 0),
      cost: { totalUsd: total, jevUsd: r6(Number(r.jev || 0)), clairicUsd: r6(Number(r.clairic || 0)), agentUsd: agent, agentTasks: Number(r.agentTasks || 0), agentKnown },
    };
  });

  const byPr: Record<string, any> = {};
  for (const r of runs) {
    const e = byPr[r.pr] || (byPr[r.pr] = { pr: r.pr, runs: 0, totalUsd: 0, last: null as any });
    e.runs++; e.totalUsd = r6(e.totalUsd + r.cost.totalUsd);
    if (!e.last) e.last = { runId: r.runId, verdict: r.verdict, findings: r.findings, at: r.startedAt, sha: r.sha };
  }

  let pr: any = null;
  if (prNum) {
    const tokenRedacted = sw.config.get("GITHUB_TOKEN");
    const tok = tokenRedacted ? (ctx.stdlib as any).Redacted.value(tokenRedacted) : "[REDACTED:GITHUB_TOKEN]";
    const headers: any = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agent-swarm-script", Authorization: "Bearer " + tok };
    const gh = async (path: string) => {
      const r: any = await (ctx.stdlib as any).fetch("https://api.github.com/repos/" + repo + path, { headers });
      if (!r.ok) throw new Error("GitHub " + r.status + " on " + path);
      return await r.json();
    };
    const [meta, commits]: any[] = await Promise.all([gh("/pulls/" + prNum), gh("/pulls/" + prNum + "/commits?per_page=100")]);
    const list = (commits as any[]).slice(-30);
    const ci = await Promise.all(list.map(async (c: any) => {
      try {
        const [cr, st]: any[] = await Promise.all([gh("/commits/" + c.sha + "/check-runs?per_page=100"), gh("/commits/" + c.sha + "/status").catch(() => ({ statuses: [] }))]);
        const checks: any[] = (cr.check_runs || []).map((x: any) => ({ name: x.name, status: x.status, conclusion: x.conclusion, url: x.html_url }));
        for (const s of st.statuses || []) checks.push({ name: s.context, status: s.state === "pending" ? "in_progress" : "completed", conclusion: s.state === "success" ? "success" : s.state === "pending" ? null : "failure", url: s.target_url });
        const failed = checks.filter((x) => x.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(x.conclusion)).length;
        const pending = checks.filter((x) => x.status !== "completed").length;
        const passed = checks.filter((x) => x.status === "completed" && ["success", "neutral", "skipped"].includes(x.conclusion)).length;
        return { state: failed ? "failing" : pending ? "pending" : checks.length ? "passing" : "none", total: checks.length, passed, failed, pending, checks };
      } catch (e: any) { return { state: "unknown", error: String(e?.message || e).slice(0, 120), total: 0, passed: 0, failed: 0, pending: 0, checks: [] }; }
    }));
    const prRuns = runs.filter((r) => r.pr === prNum);
    pr = {
      number: prNum, title: meta.title, url: meta.html_url, headSha: meta.head?.sha, baseRef: meta.base?.ref, state: meta.merged_at ? "merged" : meta.state,
      commitCount: (commits as any[]).length,
      commits: list.map((c: any, i: number) => ({
        sha: c.sha, short: c.sha.slice(0, 7), message: String(c.commit?.message || "").split("\n")[0], author: c.author?.login || c.commit?.author?.name, avatar: c.author?.avatar_url || null, date: c.commit?.author?.date,
        isHead: c.sha === meta.head?.sha, ci: ci[i], reviews: prRuns.filter((r) => r.sha === c.sha),
        costUsd: r6(prRuns.filter((r) => r.sha === c.sha).reduce((a, r) => a + r.cost.totalUsd, 0)),
      })).reverse(),
      runs: prRuns,
      totalUsd: r6(prRuns.reduce((a, r) => a + r.cost.totalUsd, 0)),
    };
  }

  return { repo, generatedAt: new Date().toISOString(), ratePerMTok: RATE_PER_MTOK, costs: byPr, runCount: runs.length, pr };
}
