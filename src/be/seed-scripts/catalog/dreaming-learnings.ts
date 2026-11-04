import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming learnings triage. Learnings (/learnings/* rows a store-progress `learning` writes) expire 30 days after
// they are written, so each night decides every new one's fate once: promote (fold into a /longterm subject doc),
// keep (leave it to its TTL; how-to goes to the skill lanes), or drop (delete it tonight).
//   plan     -> read-only. Learnings written after the KV cursor (learnings:cursor), oldest first, in bounded batches,
//               plus older learnings another agent retrieved or rated since the last committed run (reuse happens days
//               after the write). First run: no cursor, so it starts at the oldest live learning and backfills.
//   report   -> validates the triage output, counts per decision, and emits B1-shaped rows for lane B: promotions go
//               through dreaming-memtax-create (distill + the one /longterm writer), how-to rows through its skill
//               routing, drops through its Lead write step. No writes here, in any mode.
//   controls -> self-test of the pure functions, including negative controls.
// The cursor is committed by dreaming-memtax-create apply on a live run with v3Writes on, after the writes, so a
// skipped or failed night (or a dry run) re-reads the same learnings the next night and loses nothing.
// Never throws: a sync node that throws fails the whole run, and this step must never block publish or lane B.

export const argsSchema = z.object({
  mode: z.enum(["plan", "report", "controls"]).default("plan"),
  runId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  generatedAt: z.string().optional(), // gather.result.generatedAt
  budget: z.unknown().optional(), // gather.result.budget
  memtax: z.string().optional(), // workflow input kill switch for lane B: "off" skips this step too
  leadAgentId: z.string().optional(), // gather.result.leadAgentId: report trusts only triage tasks this agent ran
  batchSize: z.number().int().min(5).max(60).default(40),
  // 6 x 40 = 240 new learnings a night against ~115 written a day: the backlog shrinks by ~125 a night.
  maxBatches: z.number().int().min(0).max(12).default(6),
  reuseBatches: z.number().int().min(0).max(6).default(2),
  previewChars: z.number().int().min(200).max(2500).default(1200),
  catalogMax: z.number().int().min(0).max(600).default(300),
  plan: z.unknown().optional(), // learnings-plan.result
  triage: z.unknown().optional(), // learnings-triage (foreach aggregate)
  sampleSize: z.number().int().min(0).max(40).default(10),
});

const NS = "dreaming-v2";
export const CURSOR_KEY = "learnings:cursor";
const HEADING = "## Learnings triage";
export const DECISIONS = ["promote", "keep", "drop"] as const;
export const DROP_WHY = ["noise", "superseded", "contradicted"] as const;

// ---- path enum: the same rules as dreaming-memtax (B1) PATH_RULES; lane B re-validates every row ----
const SLUG = "[a-z0-9][a-z0-9-]{0,79}";
export const STORY_SECTIONS = ["overview", "products", "customers", "team", "how-we-work", "priorities", "history"] as const;
export const PATH_RULES: Array<{ root: string; re: RegExp }> = [
  { root: "/longterm/company-story", re: new RegExp(`^/longterm/company-story/(${STORY_SECTIONS.join("|")})$`) },
  { root: "/longterm/entities/people", re: new RegExp(`^/longterm/entities/people/${SLUG}$`) },
  { root: "/longterm/entities/customers", re: new RegExp(`^/longterm/entities/customers/(_archive/)?${SLUG}$`) },
  { root: "/howto", re: new RegExp(`^/howto/${SLUG}$`) },
  { root: "/longterm/decisions", re: new RegExp(`^/longterm/decisions/\\d{4}-\\d{2}-\\d{2}-${SLUG}$`) },
  { root: "/longterm/workstreams/active", re: new RegExp(`^/longterm/workstreams/active/${SLUG}$`) },
  { root: "/longterm/workstreams/done", re: new RegExp(`^/longterm/workstreams/done/${SLUG}$`) },
  { root: "/longterm/timeline/daily", re: /^\/longterm\/timeline\/daily\/\d{4}-\d{2}-\d{2}$/ },
  { root: "/longterm/timeline/weekly", re: /^\/longterm\/timeline\/weekly\/\d{4}-w\d{2}$/ },
  { root: "/inbox", re: /^\/inbox\/[A-Za-z0-9-]{8,64}$/ },
];
const KEY_RE = /^\/[a-z0-9-]+(\/[a-z0-9._-]+)*$/;
const KINDS = ["entity", "fact", "decision", "procedure", "workstream", "timeline", "story", "inbox"] as const;
export function pathRoot(path: string): string | null {
  if (typeof path !== "string" || path.length > 200) return null;
  if (!KEY_RE.test(path) && !path.startsWith("/inbox/")) return null;
  for (const r of PATH_RULES) if (r.re.test(path)) return r.root;
  return null;
}
// A promote target is a /longterm subject doc: in the enum, not the inbox, not a how-to, not the timeline (built from
// the window, never distilled).
export const promoteRoot = (path: string): string | null => {
  const root = pathRoot(path);
  if (!root || root === "/inbox" || root === "/howto" || root.startsWith("/longterm/timeline")) return null;
  return root;
};
const KIND_OF_ROOT = (root: string) =>
  root.startsWith("/longterm/entities") ? "entity" : root === "/howto" ? "procedure" : root.startsWith("/longterm/decisions") ? "decision" : root.startsWith("/longterm/workstreams") ? "workstream" : root === "/inbox" ? "inbox" : "story";

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
const rows = (r: any): any[] => {
  const d = r?.data ?? r;
  if (d?.error) throw new Error(String(d.error));
  if (!Array.isArray(d?.rows)) throw new Error("db_query returned no rows array (throttled?)");
  const c: string[] = d?.columns ?? [];
  return d.rows.map((x: any[]) => Object.fromEntries(c.map((k, i) => [k, x[i]])));
};
// foreach aggregate -> per batch {batchId, status, taskId, items|null, error}. A [FAILED...] taskOutput is a failure.
export function parseTriage(agg: unknown): Array<{ batchId: string; status: string; taskId: string | null; items: any[] | null; error: string | null }> {
  const a: any = parse(agg);
  const results: any[] = Array.isArray(a?.results) ? a.results : [];
  return results.map((r: any) => {
    const batchId = String(r?.itemKey ?? "");
    const taskId = r?.output?.taskId ? String(r.output.taskId) : null;
    if (r?.status !== "completed") return { batchId, status: String(r?.status ?? "unknown"), taskId, items: null, error: String(r?.error ?? "not completed").slice(0, 200) };
    const raw = r?.output?.taskOutput;
    if (typeof raw === "string" && raw.startsWith("[FAILED")) return { batchId, status: "failed", taskId, items: null, error: raw.slice(0, 200) };
    const out = parse(raw);
    if (!out || !Array.isArray(out.decisions)) return { batchId, status: "unparseable", taskId, items: null, error: "taskOutput has no decisions array" };
    return { batchId, status: "completed", taskId, items: out.decisions, error: null };
  });
}

export type TriageDoc = { id: string; useful?: boolean };
export type TriageRow = { id: string; decision: (typeof DECISIONS)[number]; path: string; kind: string; action: string; dropWhy: string | null; entitySlugs: string[]; reason: string; guard: string | null };
// One triage row -> a decision lane B can act on. Deterministic guards, so a bad row can only ever keep a learning:
// a promote with no /longterm subject target, or a drop with no reason category, is kept; a drop of a learning that
// was rated useful or reused by another agent is kept unless it is superseded or contradicted.
export function normalizeDecision(c: any, docs: Map<string, TriageDoc>): { ok: true; row: TriageRow } | { ok: false; why: string } {
  if (!c || typeof c !== "object") return { ok: false, why: "not-an-object" };
  const id = String(c.id ?? "");
  const doc = docs.get(id);
  if (!doc) return { ok: false, why: "unknown-id" };
  const decision = String(c.decision ?? "");
  if (!(DECISIONS as readonly string[]).includes(decision)) return { ok: false, why: "bad-decision" };
  const reason = String(c.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const entitySlugs = Array.isArray(c.entitySlugs) ? c.entitySlugs.map(String).slice(0, 10) : [];
  const inbox = `/inbox/${id}`;
  const keepRow = (guard: string | null, path = inbox): TriageRow => {
    const howto = pathRoot(path) === "/howto";
    return { id, decision: "keep", path, kind: howto ? "procedure" : "inbox", action: howto ? "move" : "keep", dropWhy: null, entitySlugs, reason, guard };
  };
  const m = /^merge-into:(.+)$/.exec(String(c.action ?? ""));
  const target = String((m ? m[1] : c.path) ?? "").trim();
  if (decision === "promote") {
    const root = promoteRoot(target);
    if (!root || target.startsWith("/longterm/facts")) return { ok: true, row: keepRow("promote-without-longterm-target") };
    const kind = (KINDS as readonly string[]).includes(String(c.kind)) && String(c.kind) !== "inbox" ? String(c.kind) : KIND_OF_ROOT(root);
    return { ok: true, row: { id, decision: "promote", path: target, kind, action: `merge-into:${target}`, dropWhy: null, entitySlugs, reason, guard: null } };
  }
  if (decision === "drop") {
    const why = String(c.dropWhy ?? "");
    if (!(DROP_WHY as readonly string[]).includes(why)) return { ok: true, row: keepRow("drop-without-reason-category") };
    if (doc.useful && why === "noise") return { ok: true, row: keepRow("drop-refused-useful") };
    return { ok: true, row: { id, decision: "drop", path: inbox, kind: "inbox", action: "delete", dropWhy: why, entitySlugs, reason, guard: null } };
  }
  return { ok: true, row: keepRow(null, pathRoot(target) === "/howto" ? target : inbox) };
}

// Advance only past "new" batches that completed, in order: a failed batch is re-read the next night. The reuse window
// (`at`) moves only when every reuse batch completed, so a failed reuse batch loses no reuse signal either.
export function nextCursor(planned: Array<{ batchId: string; kind: string; docs?: Array<{ id: string; createdAt?: string }> }>, okBatchIds: Set<string>, from: { createdAt: string; id: string; at: string }, at: string): { createdAt: string; id: string; at: string } {
  let to: { createdAt: string; id: string } = { createdAt: from.createdAt, id: from.id };
  for (const b of planned.filter((x) => x.kind === "new")) {
    if (!okBatchIds.has(b.batchId)) break;
    const last = (b.docs ?? [])[(b.docs ?? []).length - 1];
    if (last?.createdAt) to = { createdAt: String(last.createdAt), id: String(last.id) };
  }
  const reuseOk = planned.filter((x) => x.kind === "reuse").every((b) => okBatchIds.has(b.batchId));
  return { ...to, at: reuseOk ? at : from.at };
}

const esc = (s: string, n: number) => String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, n);

export function renderSection(r: { skipReason?: string | null; read: number; planned: number; newRead: number; reuseRead: number; batches: number; okBatches: number; failedBatches: Array<{ batchId: string; status: string }>; promoted: number; kept: number; keptHowto: number; dropped: number; dropWhy: Record<string, number>; guards: Record<string, number>; invalid: Record<string, number>; missing: number; left: number | null; cursor: { from: string; to: string } | null; cost: { usd: number | null; basis: string }; samples: TriageRow[]; names: Record<string, string> }): string {
  const L: string[] = [HEADING];
  if (r.skipReason) {
    L.push(`Skipped: ${r.skipReason}. No learning was triaged; the cursor stays where it is, so tomorrow reads the same learnings.`);
    return L.join("\n");
  }
  const why = DROP_WHY.map((k) => `${k} ${r.dropWhy[k] ?? 0}`).join(", ");
  L.push(`${r.read} of ${r.planned} learnings read in ${r.okBatches}/${r.batches} batches (${r.newRead} new since the cursor, ${r.reuseRead} reused by another agent since the last run): **${r.promoted} promoted, ${r.kept} kept, ${r.dropped} dropped**. Kept: ${r.keptHowto} to the skill lanes (/howto), ${r.kept - r.keptHowto} on their TTL. Dropped: ${why}.`);
  L.push(`Promotions go through lane B (distill, then the one /longterm writer); drops are deleted by its Lead write step. What was written is on the "Learnings triage (applied)" line of the long-term memories section.`);
  if (r.cursor) L.push(`Backlog: ${r.left ?? "?"} learnings after tonight's batches. Cursor ${r.cursor.from || "start"} -> ${r.cursor.to || "start"} (committed by lane B on a live run only).`);
  const g = Object.entries(r.guards).filter(([, n]) => n > 0);
  if (g.length) L.push(`Guards (each one kept the learning): ${g.map(([k, n]) => `${k} ${n}`).join(", ")}.`);
  const inv = Object.entries(r.invalid).filter(([, n]) => n > 0);
  if (inv.length || r.missing) L.push(`Rejected rows: ${inv.map(([k, n]) => `${k} ${n}`).join(", ") || "none"}; learnings with no row (kept): ${r.missing}.`);
  if (r.failedBatches.length) L.push(`Failed batches (re-read tomorrow): ${r.failedBatches.map((b) => `${b.batchId} ${b.status}`).join(", ")}.`);
  L.push(r.cost.usd === null ? `Cost: pending (${r.cost.basis}).` : `Cost: $${r.cost.usd.toFixed(2)} (${r.cost.basis}, session_costs).`);
  if (r.samples.length) {
    L.push("", `**${r.samples.length} samples** (promotions and drops first):`, "", "| # | learning | decision | reason |", "|---:|---|---|---|");
    r.samples.forEach((s, i) => L.push(`| ${i + 1} | ${esc(r.names[s.id] ?? "", 70)} (\`${s.id.slice(0, 8)}\`) | ${s.decision === "promote" ? `promote \`${s.path}\`` : s.decision === "drop" ? `drop (${s.dropWhy})` : `keep${s.path.startsWith("/howto/") ? ` \`${s.path}\`` : ""}`} | ${esc(s.reason, 120)} |`));
  }
  return L.join("\n");
}

/** Dreaming learnings triage: plan (cursor + reuse batches), report (promote / keep / drop rows for lane B) and controls; no writes. */
export default async function (args: unknown, ctx: ScriptContext) {
  const p = argsSchema.safeParse(args ?? {});
  if (!p.success) return { ok: false, mode: "invalid-args", batches: [], classifications: [], drops: [], errors: [p.error.message.slice(0, 400)] };
  const a = p.data;
  const dry = a.dryRun === true || a.dryRun === "true" || a.dryRun === undefined || a.dryRun === "";
  const runId = a.runId ?? "";
  const errors: string[] = [];
  const q = async (label: string, sql: string, params: unknown[] = []): Promise<any[]> => {
    try {
      return rows(await ctx.swarm.db_query({ sql, params }));
    } catch (e: any) {
      errors.push(`${label}: ${String(e?.message ?? e).slice(0, 200)}`);
      return [];
    }
  };
  try {
    if (a.mode === "plan") return await plan();
    if (a.mode === "report") return await report();
    return controls();
  } catch (e: any) {
    return { ok: false, mode: a.mode, batches: [], classifications: [], drops: [], markdown: `${HEADING}\nSkipped: script error. No other lane is affected.`, errors: [...errors, String(e?.message ?? e).slice(0, 300)] };
  }

  async function plan() {
    const gen = a.generatedAt && !Number.isNaN(Date.parse(a.generatedAt)) ? new Date(a.generatedAt) : new Date();
    const at = gen.toISOString();
    const budget: any = parse(a.budget) ?? {};
    let skipReason: string | null = null;
    if (String(a.memtax ?? "").toLowerCase() === "off") skipReason = "disabled (workflow input memtax=off)";
    if (!skipReason && Number(budget?.prevRunUsd) > Number(budget?.cap ?? 25)) skipReason = `previous run $${budget.prevRunUsd} over the $${budget.cap ?? 25} cap`;
    // Over the soft cap: new learnings only (the TTL deadline is on them), no reuse re-reads.
    const reuseBatches = budget?.overBudget ? 0 : a.reuseBatches;
    const caps = { batchSize: a.batchSize, maxBatches: a.maxBatches, reuseBatches, previewChars: a.previewChars, overBudget: !!budget?.overBudget };
    if (skipReason) return { ok: true, mode: "plan", dryRun: dry, runId, at, skipReason, batches: [], catalog: "", caps, counts: {}, cursor: null, errors };

    const entry: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key: CURSOR_KEY }).catch(() => null);
    const c = parse(entry?.value) ?? {};
    const from = { createdAt: String(c.createdAt ?? ""), id: String(c.id ?? ""), at: String(c.at ?? "") };
    const live = `m.chunkIndex = 0 AND m.key GLOB '/learnings/*' AND (m.expiresAt IS NULL OR m.expiresAt > ?)`;
    const after = `(m.createdAt > ? OR (m.createdAt = ? AND m.id > ?))`;
    const counts = (await q("counts", `SELECT COUNT(*) total, SUM(CASE WHEN ${after} THEN 1 ELSE 0 END) pending FROM agent_memory m WHERE ${live}`, [from.createdAt, from.createdAt, from.id, at]))[0] ?? {};
    // Reuse by another agent since `at`: a retrieval inside their task (not the dedup probe) or a rating from their task.
    const reuseExpr = `(
        (SELECT COUNT(*) FROM memory_retrieval r WHERE r.memoryId = m.id AND r.retrievedAt >= ?1 AND r.agentId <> coalesce(m.agentId, '') AND r.taskId IS NOT NULL AND coalesce(r.intent, '') <> 'dedup before store')
      + (SELECT COUNT(*) FROM memory_rating g JOIN agent_tasks t ON t.id = g.taskId WHERE g.memoryId = m.id AND g.createdAt >= ?1 AND t.agentId <> coalesce(m.agentId, '')))`;
    const cols = (reuse: string) => `m.id, m.name, m.key, m.agentId, m.tags, m.accessCount, m.alpha, m.beta, m.contentHash, m.totalChunks, m.createdAt, substr(m.content, 1, ${a.previewChars}) AS text, ${reuse} AS reuse`;
    const S = a.batchSize;
    const newCap = S * a.maxBatches;
    const reuseCap = S * reuseBatches;
    const fresh = newCap
      ? await q("new", `SELECT ${cols(from.at ? reuseExpr : "0")} FROM agent_memory m WHERE ${live.replace("?", "?2")} AND (m.createdAt > ?3 OR (m.createdAt = ?3 AND m.id > ?4)) ORDER BY m.createdAt, m.id LIMIT ?5`, [from.at || at, at, from.createdAt, from.id, newCap])
      : [];
    // Reuse rows are learnings already triaged (at or before the cursor) and not yet carried by a /longterm doc (its
    // Sources list the id). Only after a committed run: the first run has nothing to compare against.
    const reuse =
      reuseCap && from.at && from.createdAt
        ? await q(
            "reuse",
            `SELECT * FROM (SELECT ${cols(reuseExpr)} FROM agent_memory m WHERE ${live.replace("?", "?2")} AND (m.createdAt < ?3 OR (m.createdAt = ?3 AND m.id <= ?4))
               AND NOT EXISTS (SELECT 1 FROM agent_memory l WHERE l.chunkIndex = 0 AND (l.name GLOB '/longterm/*' OR coalesce(l.key, '') GLOB '/longterm/*') AND instr(l.content, m.id) > 0)) x
             WHERE x.reuse > 0 ORDER BY x.reuse DESC, x.createdAt, x.id LIMIT ?5`,
            [from.at, at, from.createdAt, from.id, reuseCap],
          )
        : [];
    const doc = (r: any, src: "new" | "reuse") => {
      const alpha = Number(r.alpha ?? 1);
      const beta = Number(r.beta ?? 1);
      const reuseN = Number(r.reuse ?? 0);
      return { id: String(r.id), src, name: String(r.name ?? "").slice(0, 160), key: String(r.key ?? "").slice(0, 160), createdAt: String(r.createdAt ?? ""), created: String(r.createdAt ?? "").slice(0, 10), acc: Number(r.accessCount ?? 0), ab: `${alpha.toFixed(1)}/${beta.toFixed(1)}`, reuse: reuseN, useful: alpha > beta || reuseN > 0, chunks: Number(r.totalChunks ?? 1), contentHash: String(r.contentHash ?? ""), tags: String(r.tags ?? "").slice(0, 200), text: String(r.text ?? "") };
    };
    const freshIds = new Set(fresh.map((r) => String(r.id)));
    const date = at.slice(0, 10);
    const batches: any[] = [];
    const chunk = (list: any[], kind: "new" | "reuse") => {
      for (let i = 0; i < list.length; i += S) batches.push({ batchId: `${date}-learnings-${kind}-${batches.filter((b) => b.kind === kind).length + 1}`, kind, docs: list.slice(i, i + S).map((r) => doc(r, kind)) });
    };
    chunk(fresh, "new");
    chunk(reuse.filter((r) => !freshIds.has(String(r.id))), "reuse");
    // Promote targets the triage should prefer: existing /longterm subject docs (lane docs by name, agent docs by key).
    const targets = await q("catalog", `SELECT DISTINCT CASE WHEN name GLOB '/longterm/*' THEN name ELSE key END p FROM agent_memory WHERE chunkIndex = 0 AND (name GLOB '/longterm/*' OR coalesce(key, '') GLOB '/longterm/*') ORDER BY p LIMIT 1000`);
    const catalogList = [...new Set(targets.map((r) => String(r.p ?? "")).filter((x) => promoteRoot(x)))].slice(0, a.catalogMax);
    const last = fresh[fresh.length - 1];
    const planned = batches.reduce((s, b) => s + b.docs.length, 0);
    const pending = Number(counts.pending ?? 0);
    return {
      ok: errors.length === 0,
      mode: "plan",
      dryRun: dry,
      runId,
      at,
      skipReason: batches.length ? null : errors.length ? "plan query failed" : "no learnings to triage",
      batches,
      catalog: catalogList.join("\n") || "(none yet)",
      caps,
      counts: { total: Number(counts.total ?? 0), pending, planned, newPlanned: fresh.length, reusePlanned: planned - fresh.length, left: Math.max(0, pending - fresh.length), catalog: catalogList.length },
      cursor: { from, to: last ? { createdAt: String(last.createdAt), id: String(last.id), at } : { createdAt: from.createdAt, id: from.id, at } },
      errors,
    };
  }

  async function report() {
    const pl: any = parse(a.plan) ?? {};
    const planned: any[] = Array.isArray(pl.batches) ? pl.batches : [];
    const runDry = pl.dryRun === undefined ? dry : pl.dryRun === true || dry;
    const empty = { read: 0, planned: 0, newRead: 0, reuseRead: 0, promoted: 0, kept: 0, keptHowto: 0, dropped: 0 };
    if (!planned.length) {
      const skipReason = String(pl.skipReason ?? (a.plan ? "plan returned no batches" : "learnings-plan did not run"));
      const markdown = renderSection({ skipReason, read: 0, planned: 0, newRead: 0, reuseRead: 0, batches: 0, okBatches: 0, failedBatches: [], promoted: 0, kept: 0, keptHowto: 0, dropped: 0, dropWhy: {}, guards: {}, invalid: {}, missing: 0, left: null, cursor: null, cost: { usd: null, basis: "none" }, samples: [], names: {} });
      return { ok: true, mode: "report", dryRun: runDry, runId, skipReason, markdown, counts: empty, classifications: [], docs: [], drops: [], promotedIds: [], cursor: null, errors: [...errors, ...(Array.isArray(pl.errors) ? pl.errors.map(String) : [])] };
    }
    const meta = new Map<string, any>();
    for (const b of planned) for (const d of b?.docs ?? []) meta.set(String(d.id), { ...d, batchId: b.batchId, batchKind: b.kind });
    // A drop becomes a delete with Lead authority, so only a batch the Lead ran is trusted (as lane B trusts only
    // Lead-run distill tasks). A batch any other agent ran (a pool worker) decides nothing and holds the cursor.
    const parsed = parseTriage(a.triage);
    const leadId = String(a.leadAgentId ?? "").trim();
    const runIds = [...new Set(parsed.map((x) => x.taskId).filter((x): x is string => !!x))];
    const authors = new Map<string, string>();
    if (leadId && runIds.length) for (const r of await q("triage-authors", `SELECT id, agentId FROM agent_tasks WHERE id IN (${runIds.map(() => "?").join(",")})`, runIds)) authors.set(String(r.id), String(r.agentId ?? ""));
    for (const x of parsed) {
      if (x.status === "completed" && (!leadId || !x.taskId || authors.get(x.taskId) !== leadId)) {
        x.status = "untrusted-author";
        x.items = null;
        x.error = !leadId ? "no leadAgentId to check the triage task against" : `triage task ${x.taskId ?? "(none)"} was not run by the lead`;
      }
    }
    const byBatch = new Map(parsed.map((x) => [x.batchId, x]));
    const okBatchIds = new Set(parsed.filter((x) => x.status === "completed").map((x) => x.batchId));
    const failedBatches = planned
      .map((b) => byBatch.get(b.batchId) ?? { batchId: String(b.batchId), status: a.triage ? "missing" : "not-run" })
      .filter((x) => x.status !== "completed")
      .map((x) => ({ batchId: x.batchId, status: x.status }));
    const invalid: Record<string, number> = {};
    const guards: Record<string, number> = {};
    const good = new Map<string, TriageRow>();
    for (const x of parsed) {
      if (x.status !== "completed" || !x.items) continue;
      const inBatch = new Map([...meta.values()].filter((d) => d.batchId === x.batchId).map((d) => [String(d.id), d as TriageDoc]));
      for (const c of x.items) {
        const v = normalizeDecision(c, inBatch);
        if (!v.ok) invalid[v.why] = (invalid[v.why] ?? 0) + 1;
        else if (good.has(v.row.id)) invalid["duplicate-id"] = (invalid["duplicate-id"] ?? 0) + 1;
        else {
          good.set(v.row.id, v.row);
          if (v.row.guard) guards[v.row.guard] = (guards[v.row.guard] ?? 0) + 1;
        }
      }
    }
    const readDocs = [...meta.values()].filter((d) => okBatchIds.has(d.batchId));
    // A learning in a completed batch with no valid row is kept: the TTL decides it.
    const missing = readDocs.filter((d) => !good.has(String(d.id))).length;
    const all = [...good.values()];
    const promoted = all.filter((r) => r.decision === "promote");
    const dropped = all.filter((r) => r.decision === "drop");
    const keptHowto = all.filter((r) => r.decision === "keep" && r.path.startsWith("/howto/")).length;
    const dropWhy: Record<string, number> = {};
    for (const r of dropped) dropWhy[r.dropWhy!] = (dropWhy[r.dropWhy!] ?? 0) + 1;
    // B1-shaped rows for lane B: promotions (distilled into their subject doc) and how-to keeps (skill routing).
    const classifications = all.filter((r) => r.decision === "promote" || r.path.startsWith("/howto/")).map((r) => ({ id: r.id, path: r.path, kind: r.kind, action: r.action, entitySlugs: r.entitySlugs, reason: r.reason, decision: r.decision }));
    const docs = classifications.map((r) => {
      const d = meta.get(r.id) ?? {};
      return { id: r.id, name: d.name ?? "", key: d.key ?? "", created: d.created ?? "", text: d.text ?? "" };
    });
    const drops = dropped.map((r) => ({ id: r.id, name: String(meta.get(r.id)?.name ?? ""), key: String(meta.get(r.id)?.key ?? ""), contentHash: String(meta.get(r.id)?.contentHash ?? ""), dropWhy: r.dropWhy, reason: r.reason }));
    const from = pl?.cursor?.from ?? { createdAt: "", id: "", at: "" };
    const cursor = { from, to: nextCursor(planned, okBatchIds, from, String(pl.at ?? "")) };
    // Measured cost of the triage tasks; session_costs usually lands after this node, so fall back to the 7-day mean.
    const taskIds = parsed.map((x) => x.taskId).filter(Boolean) as string[];
    let cost: { usd: number | null; basis: string } = { usd: null, basis: "no tasks" };
    if (taskIds.length) {
      const c = (await q("cost", `SELECT SUM(totalCostUsd) usd FROM session_costs WHERE taskId IN (${taskIds.map(() => "?").join(",")})`, taskIds))[0];
      if (c && c.usd !== null && c.usd !== undefined) cost = { usd: Number(c.usd), basis: "this run" };
      else {
        const prior = (await q("cost-prior", `SELECT COUNT(*) tasks, AVG(s.usd) usd FROM (SELECT sc.taskId, SUM(sc.totalCostUsd) usd FROM session_costs sc JOIN agent_tasks t ON t.id = sc.taskId WHERE t.tags LIKE '%dreaming-v2-learnings%' AND t.status = 'completed' AND sc.createdAt >= datetime('now','-7 days') GROUP BY sc.taskId) s`))[0];
        cost = prior && Number(prior.tasks) > 0 && prior.usd !== null ? { usd: Number(prior.usd) * taskIds.length, basis: `estimate: mean of ${prior.tasks} triage tasks in 7 days` } : { usd: null, basis: "session_costs lands after the triage tasks finish" };
      }
    }
    const names = Object.fromEntries([...meta.entries()].map(([id, d]) => [id, String(d.name ?? "")]));
    const samples = [...promoted, ...dropped, ...all.filter((r) => r.decision === "keep")].slice(0, a.sampleSize);
    const counts = {
      read: readDocs.length,
      planned: meta.size,
      newRead: readDocs.filter((d) => d.batchKind === "new").length,
      reuseRead: readDocs.filter((d) => d.batchKind === "reuse").length,
      promoted: promoted.length,
      kept: readDocs.length - promoted.length - dropped.length,
      keptHowto,
      dropped: dropped.length,
      dropWhy,
      guards,
      invalid,
      missing,
      batches: planned.length,
      okBatches: okBatchIds.size,
      left: pl?.counts?.left ?? null,
    };
    const markdown = renderSection({ ...counts, failedBatches, cursor: { from: String(from.createdAt ?? "").slice(0, 19), to: String(cursor.to.createdAt ?? "").slice(0, 19) }, cost, samples, names });
    return {
      ok: errors.length === 0 && failedBatches.length === 0,
      mode: "report",
      dryRun: runDry,
      runId,
      skipReason: null,
      counts,
      classifications,
      docs,
      drops,
      promotedIds: promoted.map((r) => r.id),
      cursor,
      failedBatches,
      cost,
      markdown,
      errors,
    };
  }

  function controls() {
    const cases: Array<{ name: string; pass: boolean; got?: unknown }> = [];
    const t = (name: string, pass: boolean, got?: unknown) => cases.push({ name, pass, got });
    const docs = new Map<string, TriageDoc>([
      ["l1", { id: "l1" }],
      ["l2", { id: "l2", useful: true }],
    ]);
    const n = (c: any) => normalizeDecision(c, docs) as any;
    const pr = n({ id: "l1", decision: "promote", path: "/longterm/entities/people/ada", kind: "entity", action: "merge-into:/longterm/entities/people/ada", reason: "standing preference" });
    t("promote into a subject doc -> merge-into row (positive control)", pr.ok && pr.row.decision === "promote" && pr.row.action === "merge-into:/longterm/entities/people/ada" && pr.row.guard === null, pr);
    const prNew = n({ id: "l1", decision: "promote", path: "/longterm/workstreams/active/learnings-triage", kind: "workstream", action: "move", reason: "new effort" });
    t("promote with no existing doc -> merge-into the new path", prNew.ok && prNew.row.path === "/longterm/workstreams/active/learnings-triage" && prNew.row.action === "merge-into:/longterm/workstreams/active/learnings-triage", prNew);
    const prFacts = n({ id: "l1", decision: "promote", path: "/longterm/facts/infra/x", kind: "fact", action: "move", reason: "x" });
    const prHowto = n({ id: "l1", decision: "promote", path: "/howto/clickhouse", kind: "procedure", action: "move", reason: "x" });
    const prTimeline = n({ id: "l1", decision: "promote", path: "/longterm/timeline/daily/2026-11-03", kind: "timeline", action: "move", reason: "x" });
    t("promote without a /longterm subject target is kept (facts, howto, timeline)", [prFacts, prHowto, prTimeline].every((x) => x.ok && x.row.decision === "keep" && x.row.guard === "promote-without-longterm-target"), [prFacts, prHowto, prTimeline]);
    t("guarded promote to /howto keeps the inbox path, not the how-to route", prHowto.row.path === "/inbox/l1");
    const kh = n({ id: "l1", decision: "keep", path: "/howto/clickhouse", kind: "procedure", action: "move", reason: "cli flags" });
    t("keep how-to -> /howto move row (skill lanes)", kh.ok && kh.row.path === "/howto/clickhouse" && kh.row.action === "move" && kh.row.kind === "procedure", kh);
    const ki = n({ id: "l1", decision: "keep", path: "/longterm/entities/people/ada", kind: "entity", action: "keep", reason: "x" });
    t("keep with a /longterm path stays in the inbox (never a promotion)", ki.ok && ki.row.path === "/inbox/l1" && ki.row.action === "keep", ki);
    const dr = n({ id: "l1", decision: "drop", dropWhy: "superseded", reason: "newer learning says it" });
    t("drop with a category -> delete row (positive control)", dr.ok && dr.row.decision === "drop" && dr.row.action === "delete" && dr.row.dropWhy === "superseded", dr);
    const drNo = n({ id: "l1", decision: "drop", reason: "meh" });
    t("drop with no category is kept (negative control)", drNo.ok && drNo.row.decision === "keep" && drNo.row.guard === "drop-without-reason-category", drNo);
    const drUseful = n({ id: "l2", decision: "drop", dropWhy: "noise", reason: "noise" });
    const drUsefulSup = n({ id: "l2", decision: "drop", dropWhy: "superseded", reason: "newer one" });
    t("noise drop of a useful learning is kept; superseded drop passes", drUseful.row.decision === "keep" && drUseful.row.guard === "drop-refused-useful" && drUsefulSup.row.decision === "drop", { drUseful, drUsefulSup });
    t("unknown id and bad decision are rejected", n({ id: "zz", decision: "keep" }).ok === false && n({ id: "l1", decision: "archive" }).ok === false);
    const neg = parseTriage({ results: [{ itemKey: "b1", status: "completed", output: { taskId: "t1", taskOutput: "[FAILED: negative control] x" } }, { itemKey: "b2", status: "failed" }, { itemKey: "b3", status: "completed", output: { taskId: "t3", taskOutput: "not json" } }, { itemKey: "b4", status: "completed", output: { taskId: "t4", taskOutput: '{"batchId":"b4","decisions":[]}' } }] });
    t("neg: failed, garbage and [FAILED] batches never parse as completed", neg[0]?.status === "failed" && neg[1]?.status === "failed" && neg[2]?.status === "unparseable" && neg[3]?.status === "completed", neg);
    t("neg: empty/undefined aggregate -> []", parseTriage("").length === 0 && parseTriage(undefined).length === 0);
    const from = { createdAt: "2026-10-27T00:00:00.000Z", id: "a", at: "2026-11-03T03:30:00.000Z" };
    const pb = [
      { batchId: "n1", kind: "new", docs: [{ id: "x1", createdAt: "2026-10-27T01:00:00.000Z" }] },
      { batchId: "n2", kind: "new", docs: [{ id: "x2", createdAt: "2026-10-27T02:00:00.000Z" }] },
      { batchId: "r1", kind: "reuse", docs: [{ id: "y1", createdAt: "2026-10-01T00:00:00.000Z" }] },
    ];
    const c1 = nextCursor(pb, new Set(["n1", "n2", "r1"]), from, "2026-11-04T03:30:00.000Z");
    const c2 = nextCursor(pb, new Set(["n2", "r1"]), from, "2026-11-04T03:30:00.000Z");
    const c3 = nextCursor(pb, new Set(["n1", "n2"]), from, "2026-11-04T03:30:00.000Z");
    t("cursor: all batches done -> last new doc and tonight's reuse window", c1.id === "x2" && c1.at === "2026-11-04T03:30:00.000Z", c1);
    t("cursor: first new batch failed -> no move (nothing skipped)", c2.id === "a" && c2.createdAt === from.createdAt, c2);
    t("cursor: a reuse batch failed -> reuse window stays", c3.id === "x2" && c3.at === from.at, c3);
    const md = renderSection({ read: 2, planned: 2, newRead: 2, reuseRead: 0, batches: 1, okBatches: 1, failedBatches: [], promoted: 1, kept: 0, keptHowto: 0, dropped: 1, dropWhy: { noise: 1 }, guards: {}, invalid: {}, missing: 0, left: 10, cursor: { from: "", to: "2026-10-27" }, cost: { usd: null, basis: "pending" }, samples: [], names: {} });
    t("render: counts line", md.startsWith(HEADING) && md.includes("1 promoted, 0 kept, 1 dropped") && md.includes("noise 1"), md);
    t("render: skipped section", renderSection({ skipReason: "x", read: 0, planned: 0, newRead: 0, reuseRead: 0, batches: 0, okBatches: 0, failedBatches: [], promoted: 0, kept: 0, keptHowto: 0, dropped: 0, dropWhy: {}, guards: {}, invalid: {}, missing: 0, left: null, cursor: null, cost: { usd: null, basis: "" }, samples: [], names: {} }).includes("Skipped: x"));
    return { ok: cases.every((c) => c.pass), mode: "controls", passed: cases.filter((c) => c.pass).length, total: cases.length, failed: cases.filter((c) => !c.pass), batches: [], errors };
  }
}
