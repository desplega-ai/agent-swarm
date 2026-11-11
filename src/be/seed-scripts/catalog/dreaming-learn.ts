import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming v3 learning loop (plan-v3 section 6, Phase 1). Runs after verify. For every cut in KV cuts:<runId>:<lane>
// from the last `days` nights it scores: reverted, reintroduced (pinned), referenced (restore candidate), and for
// file-backed memories `reindexed` (never pinned, Revision 1 §0.5). Writes per-lane metrics to learn:<runId> and
// learn:latest, with deltas vs the previous night and the 7-night mean. dryRun writes nothing. Never throws.

export const argsSchema = z.object({
  runId: z.string().optional(),
  leadAgentId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  days: z.number().int().min(1).max(30).default(14),
  trim: z.unknown().optional(),
  hb: z.unknown().optional(),
  budget: z.unknown().optional(),
  verify: z.unknown().optional(),
});

const NS = "dreaming-v2";
const FIELDS = ["soulMd", "identityMd", "toolsMd", "claudeMd"] as const;

const sha = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s ?? ""))))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const rows = (r: any): any[] => {
  const d = r?.data ?? r;
  if (d?.error) throw new Error(String(d.error));
  if (!Array.isArray(d?.rows)) throw new Error("db_query returned no rows array (throttled?)");
  const c: string[] = d?.columns ?? [];
  return d.rows.map((x: any[]) => Object.fromEntries(c.map((k, i) => [k, x[i]])));
};

// Lead agent id: the `leadAgentId` arg when set (workflow input), else the swarm's lead (agents.isLead = 1).
let LEAD = "";
async function resolveLead(ctx: ScriptContext, id: unknown): Promise<string> {
  if (typeof id === "string" && id.trim()) return id.trim();
  const r = rows(await ctx.swarm.db_query({ sql: `SELECT id FROM agents WHERE isLead = 1 ORDER BY createdAt ASC LIMIT 1` }));
  return String(r[0]?.id ?? "");
}

function parse(v: unknown): any {
  if (v && typeof v === "object") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return JSON.parse(s);
      } catch {}
    }
  }
  return null;
}

export type ScoreEnv = {
  live: string | null; // live target text (profile field / heartbeat); null for memory targets
  liveSha: string | null;
  revertState: { beforeSha?: string; runId?: string } | null; // trim-state / hb-state of the cut's run
  memory?: { present: number; reindexedSamePath: number } | null;
  references: Array<{ ref: string; text: string }>;
};

// Pure scorer, shared by the nightly pass and the controls.
export function scoreCut(cut: any, env: ScoreEnv): { signals: string[]; evidence: string[] } {
  const signals: string[] = [];
  const evidence: string[] = [];
  const probe = String(cut?.probe ?? "");
  if (!probe) return { signals, evidence };
  if (cut?.target?.kind === "memory") {
    if (env.memory?.reindexedSamePath) signals.push("reindexed");
    else if (env.memory?.present) signals.push("reintroduced");
  } else if (env.live !== null) {
    const reverted = !!env.revertState?.beforeSha && env.revertState.runId === cut.runId && env.liveSha === env.revertState.beforeSha;
    if (reverted) signals.push("reverted");
    else if (env.live.includes(probe)) signals.push("reintroduced");
  }
  if (probe.length >= 12) {
    const p = probe.toLowerCase();
    for (const r of env.references) if (r.text.toLowerCase().includes(p)) evidence.push(r.ref);
    if (evidence.length) signals.push("referenced");
  }
  return { signals, evidence: evidence.slice(0, 5) };
}

const H2 = (t: string) => {
  const out: Record<string, number> = {};
  let cur = "(top)";
  for (const l of t.split("\n")) {
    if (/^## /.test(l)) cur = l.slice(3, 40);
    out[cur] = (out[cur] ?? 0) + l.length + 1;
  }
  return out;
};

/** Dreaming learning loop: scores past cuts and pins and records per-lane metrics. */
export default async function (args: unknown, ctx: ScriptContext) {
  const p = argsSchema.safeParse(args ?? {});
  if (!p.success) return { ok: false, errors: [p.error.message] };
  const a = p.data;
  LEAD = await resolveLead(ctx, (args as any)?.leadAgentId);
  const dry = a.dryRun === true || a.dryRun === "true";
  const runId = a.runId ?? "";
  const now = new Date();
  const errors: string[] = [];
  const q = async (label: string, sql: string, params: unknown[] = []): Promise<any[]> => {
    try {
      return rows(await ctx.swarm.db_query({ sql, params }));
    } catch (e: any) {
      errors.push(`${label}: ${String(e?.message ?? e).slice(0, 200)}`);
      return [];
    }
  };
  const kvList = async (prefix: string, limit = 200): Promise<any[]> => {
    try {
      const r: any = await ctx.swarm.kv_list({ namespace: NS, prefix, limit });
      return (r?.data?.entries ?? r?.entries ?? []).map((e: any) => ({ key: e.key, value: parse(e.value) ?? e.value }));
    } catch (e: any) {
      errors.push(`kv_list ${prefix}: ${String(e?.message ?? e).slice(0, 160)}`);
      return [];
    }
  };
  const kvSet = async (key: string, value: unknown) => ctx.swarm.kv_set({ namespace: NS, key, value: value as any });

  // 1. Inputs.
  const since = new Date(now.getTime() - a.days * 86400000).toISOString();
  const day = new Date(now.getTime() - 86400000).toISOString();
  const ledgers = (await kvList("cuts:")).filter((e) => String(e.value?.at ?? "") >= since);
  const cuts: any[] = ledgers.flatMap((e) => (Array.isArray(e.value?.cuts) ? e.value.cuts.map((c: any) => ({ ...c, runId: e.value.runId, at: e.value.at })) : []));
  const restored = new Set((await kvList("restored:")).map((e) => String(e.key).slice("restored:".length)));
  const pinsExisting = await kvList("pin:", 500);
  const pinKeys = new Set(pinsExisting.map((e) => String(e.key)));
  const agents = await q("agents", `SELECT id, name, isLead, status, soulMd, identityMd, toolsMd, claudeMd, CASE WHEN id = ? THEN heartbeatMd END AS heartbeatMd FROM agents WHERE name NOT LIKE 'ext:%'`, [LEAD]);
  const byId = new Map(agents.map((x: any) => [x.id, x]));
  const trimStates = (await kvList("trim-state:")).map((e) => e.value ?? {});
  const hbState = parse((await ctx.swarm.kv_getOrNull({ namespace: NS, key: "hb-state:lead" }).catch(() => null))?.value) ?? null;
  const failed = await q("failed", `SELECT id, failureReason FROM agent_tasks WHERE status = 'failed' AND finishedAt >= ? AND failureReason IS NOT NULL LIMIT 500`, [day]);
  const coaching = await q("coaching", `SELECT id, changeReason FROM context_versions WHERE changeSource = 'lead_coaching' AND createdAt >= ? AND changeReason IS NOT NULL LIMIT 300`, [day]);
  const references = [
    ...failed.map((r: any) => ({ ref: `task:${r.id}`, text: String(r.failureReason ?? "") })),
    ...coaching.map((r: any) => ({ ref: `context_version:${r.id}`, text: String(r.changeReason ?? "") })),
  ];
  const shaCache = new Map<string, string>();
  const liveOf = async (cut: any): Promise<{ live: string | null; liveSha: string | null }> => {
    const t = cut?.target ?? {};
    if (t.kind !== "profile" && t.kind !== "heartbeat") return { live: null, liveSha: null };
    const ag: any = byId.get(t.agentId);
    const live = ag ? String(ag[t.field] ?? "") : null;
    if (live === null) return { live: null, liveSha: null };
    const k = `${t.agentId}:${t.field}`;
    if (!shaCache.has(k)) shaCache.set(k, await sha(live));
    return { live, liveSha: shaCache.get(k)! };
  };

  // 2. Score every cut.
  const scored = { cuts: cuts.length, reverted: [] as any[], reintroduced: [] as any[], referenced: [] as any[], reindexed: [] as any[] };
  const newPins: any[] = [];
  for (const cut of cuts) {
    if (restored.has(String(cut.cutId))) continue;
    const t = cut.target ?? {};
    const { live, liveSha } = await liveOf(cut);
    let memory: ScoreEnv["memory"] = null;
    if (t.kind === "memory") {
      const m = await q("memPresent", `SELECT COUNT(*) n, SUM(CASE WHEN source = 'file_index' AND sourcePath = ? THEN 1 ELSE 0 END) same FROM agent_memory WHERE name = ?`, [String(t.sourcePath ?? ""), String(cut.probe)]);
      memory = { present: Number(m[0]?.n ?? 0), reindexedSamePath: Number(m[0]?.same ?? 0) };
    }
    const revertState = t.kind === "heartbeat" ? hbState : trimStates.find((s: any) => s.agentId === t.agentId && s.field === t.field && s.runId === cut.runId) ?? null;
    const r = scoreCut(cut, { live, liveSha, revertState, memory, references });
    const rec = { cutId: cut.cutId, lane: cut.lane, runId: cut.runId, target: t, probe: String(cut.probe).slice(0, 80) };
    if (r.signals.includes("reverted")) scored.reverted.push(rec);
    if (r.signals.includes("reindexed")) scored.reindexed.push(rec);
    if (r.signals.includes("reintroduced")) {
      let by: any = null;
      if (t.kind === "profile" || t.kind === "heartbeat") {
        const w = await q("writer", `SELECT changeSource, changedByAgentId, createdAt FROM context_versions WHERE agentId = ? AND field = ? AND createdAt >= ? ORDER BY createdAt DESC LIMIT 1`, [t.agentId, t.field, String(cut.at ?? since)]);
        by = w[0] ?? null;
      }
      scored.reintroduced.push({ ...rec, by });
      const key = `pin:${cut.lane}:${(await sha(`${t.agentId ?? ""}:${t.field ?? t.kind}:${cut.probe}`)).slice(0, 16)}`;
      if (!pinKeys.has(key)) newPins.push({ key, value: { probe: rec.probe, cutId: cut.cutId, target: t, reason: "reintroduced", by, at: now.toISOString() } });
    }
    if (r.signals.includes("referenced")) scored.referenced.push({ ...rec, evidence: r.evidence });
  }

  // 3. Controls (same scorer, synthetic cuts, never pinned or stored).
  const lead: any = byId.get(LEAD) ?? {};
  const leadClaude = String(lead.claudeMd ?? "");
  const line40 = leadClaude.split("\n").map((l) => l.trim()).find((l) => l.length >= 40) ?? "";
  const posProbe = line40.slice(0, 60);
  const negProbe = `zq${crypto.randomUUID().replace(/-/g, "").slice(0, 38)}`;
  const leadSha = await sha(leadClaude);
  const ctlCut = (probe: string) => ({ cutId: "control", lane: "A", runId: "control", probe, target: { kind: "profile", agentId: LEAD, field: "claudeMd" } });
  const pos = scoreCut(ctlCut(posProbe), { live: leadClaude, liveSha: leadSha, revertState: null, memory: null, references });
  const neg = scoreCut(ctlCut(negProbe), { live: leadClaude, liveSha: leadSha, revertState: null, memory: null, references });
  const memCtl = scoreCut({ probe: "some-memory-name", runId: "c", target: { kind: "memory", sourcePath: "/workspace/shared/memory/x.md" } }, { live: null, liveSha: null, revertState: null, memory: { present: 1, reindexedSamePath: 1 }, references: [] });
  const revCtl = scoreCut({ probe: "x".repeat(20), runId: "r1", target: { kind: "heartbeat" } }, { live: "y", liveSha: "B", revertState: { beforeSha: "B", runId: "r1" }, memory: null, references: [] });
  const controls = {
    results: [
      { name: "reintroduced+ probe from live Lead claudeMd", pass: posProbe.length >= 40 && pos.signals.includes("reintroduced"), probe: posProbe },
      { name: "reintroduced- random 40-char probe scores nothing", pass: neg.signals.length === 0, probe: negProbe },
      { name: "reindexed+ file-backed memory at the cut's sourcePath -> reindexed, not reintroduced", pass: memCtl.signals.includes("reindexed") && !memCtl.signals.includes("reintroduced") },
      { name: "reverted+ live sha = the run's beforeSha", pass: revCtl.signals.includes("reverted") },
    ],
    ok: false,
  };
  controls.ok = controls.results.every((r) => r.pass);
  if (!controls.ok) errors.push("controls: scorer self-test failed");

  // 4. Metrics.
  const active = agents.filter((x: any) => x.status !== "offline");
  const laneA: any = { perAgent: {} as Record<string, any>, totalChars: 0 };
  for (const ag of active) {
    const m: any = {};
    for (const f of FIELDS) m[f] = String(ag[f] ?? "").length;
    laneA.perAgent[ag.name] = m;
    laneA.totalChars += FIELDS.reduce((n, f) => n + m[f], 0);
  }
  const trim = parse(a.trim) ?? {};
  laneA.trims = { applied: (trim.applied ?? []).length, wouldApply: (trim.wouldApply ?? []).length, refused: (trim.refused ?? []).length, reapplied: (trim.reapplied ?? []).length, drifted: (trim.survival?.drifted ?? []).length, cuts: trim.cuts ?? null };
  const hbText = String(lead.heartbeatMd ?? "");
  const tracked = (() => {
    const i = hbText.lastIndexOf("## Tracked Items");
    if (i < 0) return [] as string[];
    return (hbText.slice(hbText.indexOf("\n", i) + 1).split(/^#{1,2}\s/m)[0] ?? "").split("\n").filter((l) => l.trim());
  })();
  const hbCost = await q(
    "hbCost",
    `SELECT COUNT(*) n, SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) failed,
       ROUND((SELECT SUM(c.totalCostUsd) FROM session_costs c JOIN agent_tasks t2 ON t2.id = c.taskId
              WHERE t2.agentId = ? AND t2.taskType = 'heartbeat-checklist' AND t2.createdAt >= ?), 2) usd
     FROM agent_tasks t WHERE t.agentId = ? AND t.taskType = 'heartbeat-checklist' AND t.createdAt >= ?`,
    [LEAD, new Date(now.getTime() - 7 * 86400000).toISOString(), LEAD, new Date(now.getTime() - 7 * 86400000).toISOString()],
  );
  const n7 = Number(hbCost[0]?.n ?? 0);
  const hb = parse(a.hb) ?? null;
  const laneC = {
    chars: hbText.length,
    sections: H2(hbText),
    trackedItems: tracked.length,
    itemsOver500: tracked.filter((l) => l.length > 500).length,
    undated: tracked.filter((l) => !/delete\s+(on\s+)?\d{2}-\d{2}/i.test(l) && !l.trim().replace(/^[-*+]\s+/, "").startsWith("📌")).length,
    hbTasks7d: n7,
    hbTasksPerDay: Math.round((n7 / 7) * 10) / 10,
    usdPerHbTask7d: n7 ? Math.round((Number(hbCost[0]?.usd ?? 0) / n7) * 100) / 100 : null,
    hbFailureRate7d: n7 ? Math.round((Number(hbCost[0]?.failed ?? 0) / n7) * 1000) / 1000 : null,
    apply: hb ? { status: hb.status ?? null, draftChars: hb.draftChars ?? null, removed: hb.removed ?? null } : null,
  };
  const laneB = { status: "not-built (Phase 4)" };
  const budget = parse(a.budget) ?? {};
  const learning = { cutsScored: cuts.length, reverted: scored.reverted.length, reintroduced: scored.reintroduced.length, referenced: scored.referenced.length, reindexed: scored.reindexed.length, pinsTotal: pinsExisting.length + (dry ? 0 : newPins.length), newPins: newPins.length };
  const metrics = { laneA, laneB, laneC, learning, cost: { prevRunId: budget.prevRunId ?? null, prevRunUsd: budget.prevRunUsd ?? null, cap: budget.cap ?? 25 } };

  // 5. Trend: delta vs the previous learn row and the 7-night mean.
  const hist = (await kvList("learn:", 60))
    .filter((e) => e.key !== "learn:latest" && e.key !== `learn:${runId}` && e.value?.metrics)
    .sort((x, y) => String(y.value.at).localeCompare(String(x.value.at)))
    .slice(0, 7);
  const pick = (m: any) => ({
    profileChars: Number(m?.laneA?.totalChars ?? NaN),
    heartbeatChars: Number(m?.laneC?.chars ?? NaN),
    usdPerHbTask: Number(m?.laneC?.usdPerHbTask7d ?? NaN),
    trackedItems: Number(m?.laneC?.trackedItems ?? NaN),
    prevRunUsd: Number(m?.cost?.prevRunUsd ?? NaN),
  });
  const cur = pick(metrics);
  const prev = hist[0] ? pick(hist[0].value.metrics) : null;
  const trend: Record<string, any> = {};
  for (const k of Object.keys(cur) as Array<keyof typeof cur>) {
    const vals = hist.map((h) => pick(h.value.metrics)[k]).filter((v) => Number.isFinite(v));
    trend[k] = {
      tonight: Number.isFinite(cur[k]) ? cur[k] : null,
      delta: prev && Number.isFinite(prev[k]) && Number.isFinite(cur[k]) ? Math.round((cur[k] - prev[k]) * 100) / 100 : null,
      mean7: vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100 : null,
    };
  }
  const fmt = (v: any) => (v === null || v === undefined ? "–" : String(v));
  const table = [
    "| metric | tonight | Δ vs last night | 7-night mean |",
    "|---|---:|---:|---:|",
    ...Object.entries(trend).map(([k, v]: any) => `| ${k} | ${fmt(v.tonight)} | ${fmt(v.delta)} | ${fmt(v.mean7)} |`),
    `| cuts scored / reverted / reintroduced / referenced | ${learning.cutsScored} / ${learning.reverted} / ${learning.reintroduced} / ${learning.referenced} | | |`,
    `| pins (new tonight) | ${learning.pinsTotal} (${learning.newPins}) | | |`,
  ].join("\n");

  // 6. Store (live only).
  let stored: string[] = [];
  if (!dry && runId) {
    try {
      for (const pin of newPins) await kvSet(pin.key, pin.value);
      const row = { runId, at: now.toISOString(), metrics, trend, scored, candidates: scored.referenced.slice(0, 20) };
      await kvSet(`learn:${runId}`, row);
      await kvSet("learn:latest", row);
      stored = [`learn:${runId}`, "learn:latest", ...newPins.map((p) => p.key)];
    } catch (e: any) {
      errors.push(`store: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return {
    ok: errors.length === 0,
    mode: dry ? "dry-run" : "live",
    runId,
    metrics,
    trend,
    table,
    scored: { ...scored, reverted: scored.reverted.slice(0, 20), reintroduced: scored.reintroduced.slice(0, 20), referenced: scored.referenced.slice(0, 20), reindexed: scored.reindexed.slice(0, 20) },
    restoreCandidates: scored.referenced.slice(0, 10),
    newPins: newPins.map((p) => ({ key: p.key, probe: p.value.probe })),
    controls,
    stored,
    errors,
  };
}
