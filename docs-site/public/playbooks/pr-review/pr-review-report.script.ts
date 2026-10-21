import type { ScriptContext } from "swarm-sdk";

// pr-review-report: one JSON per review run, including what it cost.
// Jev and Clairic are priced per input token at RATE_PER_MTOK; agent cost is the
// real session cost of each review task (null until its session row lands).

const RATE_PER_MTOK = 0.042;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export default async function (args: any, ctx: ScriptContext) {
  const fetched = args?.fetched || {};
  const tag = args?.tagging || {};
  const dec = args?.decisions || {};
  const rev = args?.reviews || {};
  const cx = args?.context && typeof args.context === "object" ? args.context : {};
  const clairicTokens = Number(args?.claimsUsage?.input_tokens || 0);
  const results: any[] = Array.isArray(rev.results) ? rev.results : [];

  const agentReviews = results.map((r: any) => {
    let out: any = r.output?.taskOutput ?? r.output;
    if (typeof out === "string") { try { out = JSON.parse(out); } catch { /* keep text */ } }
    return { batch: r.itemKey, status: r.status, taskId: r.output?.taskId ?? null, review: out ?? null };
  });
  const blocks = agentReviews.filter((r) => r.review && r.review.verdict === "block").length;
  const comments = agentReviews.filter((r) => r.review && r.review.verdict === "comment").length;
  const flagged = dec.flaggedCount || 0;
  const verdict = blocks ? "request_changes" : comments ? "comment" : flagged ? "flags_cleared_by_agent" : "clean";
  const jevCalls = (tag.jevCalls || 0) + (dec.jevCalls || 0) + (cx.jevCalls || 0);
  const jevCostUsd = r6((tag.jevCostUsd || 0) + (dec.jevCostUsd || 0) + (cx.jevCostUsd || 0));
  const clairicCostUsd = r6(clairicTokens * RATE_PER_MTOK / 1e6);

  // Agent cost: real per-session cost of each review task.
  const ids = agentReviews.map((r) => r.taskId).filter((id) => /^[0-9a-f-]{36}$/.test(String(id)));
  let agentCostUsd: number | null = ids.length ? null : 0;
  const perTask: Record<string, number> = {};
  if (ids.length) {
    try {
      const res: any = await (ctx.swarm as any).db_query({ sql: "SELECT taskId, SUM(totalCostUsd) FROM session_costs WHERE taskId IN (" + ids.map((id) => "'" + id + "'").join(",") + ") GROUP BY taskId" });
      for (const [id, usd] of res?.data?.rows || []) perTask[id] = Number(usd) || 0;
      if (Object.keys(perTask).length === ids.length) agentCostUsd = r6(Object.values(perTask).reduce((a, b) => a + b, 0));
    } catch { /* leave null: the info script recomputes on read */ }
  }
  const totalUsd = agentCostUsd == null ? null : r6(jevCostUsd + clairicCostUsd + agentCostUsd);

  return {
    pr: fetched.pr,
    review: fetched.review,
    verdict,
    claims: dec.claims,
    files: fetched.files,
    ci: cx.ci || null,
    cost: { totalUsd, jevUsd: jevCostUsd, clairicUsd: clairicCostUsd, agentUsd: agentCostUsd, agentTasks: ids.length, perTask, ratePerMTok: RATE_PER_MTOK },
    summary: {
      granularity: fetched.granularity,
      units: fetched.unitCount,
      omittedUnits: fetched.omittedUnits,
      batches: dec.batchCount,
      flagged,
      sentToAgent: dec.sentToAgent,
      notSentToAgent: dec.notSentToAgent,
      tagErrors: tag.errors,
      rulesUsed: dec.rulesUsed || 0,
      jevCalls,
      jevTagWallMs: tag.jevWallMs,
      jevDecideWallMs: dec.jevWallMs,
      jevContextWallMs: cx.jevWallMs,
      jevCostUsd,
    },
    unitTags: tag.perUnit,
    batches: (dec.batches || []).map((b: any) => ({ key: b.key, label: b.label, verdict: b.verdict, score: b.score, why: b.why, files: b.files, units: b.unitIds, jev: b.jev })),
    agentReviews,
  };
}
