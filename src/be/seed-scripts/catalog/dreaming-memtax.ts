import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming-v2 lane B, phase B1 (plan-v3 §4.2-4.3, Phase 4; taxonomy dreaming-v2/memory-taxonomy.md §3.2, §5.2).
// Classify-only. No memory writes in any mode. Never throws: a sync node that throws fails the whole run, and this
// lane must never block publish, verify or any other lane.
//   plan     -> batches of ~40 curated docs (today's manual docs + N backlog batches), aggregated in SQL (<=1,000 rows).
//   report   -> validates memtax-classify output against the closed path enum, counts per path/action, 30 seeded
//               random samples, measured cost per batch, Markdown section for publish. Live only: KV memtax:class:<id>
//               and the backlog cursor. Also re-counts memory writes in the window as a control.
//   controls -> self-test of the pure functions, including the negative controls (failed/empty/garbage classify).
// 2026-10-06 (operator): how-to/procedure/service notes classify to /howto/<slug> (never written) and lane B routes them to
// skills and scripts; /longterm/facts/{services,procedures} are retired (legacy rows are re-filed, writes refused).
// 2026-10-06 (2nd ask, taxonomy v5): /longterm is a few living subject docs (people, customers, company-story
// sections, decisions, workstreams). /longterm/facts is retired: a row on it is episodic and stays in the inbox.
// B2 backfill and B3 steady state wait on the agent-swarm memory key/newKey/keyPrefix PR. Not built here.

export const argsSchema = z.object({
  mode: z.enum(["plan", "report", "controls"]).default("plan"),
  runId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  generatedAt: z.string().optional(), // gather.result.generatedAt; the window is the 24h before it
  budget: z.unknown().optional(), // gather.result.budget
  memtax: z.string().optional(), // workflow input kill switch: "off" skips the lane
  batchSize: z.number().int().min(5).max(60).default(40),
  maxTodayBatches: z.number().int().min(0).max(10).default(4),
  backlogBatches: z.number().int().min(0).max(10).default(4),
  previewChars: z.number().int().min(200).max(3000).default(1500),
  plan: z.unknown().optional(), // memtax-plan.result
  classify: z.unknown().optional(), // memtax-classify (foreach aggregate)
  sampleSize: z.number().int().min(0).max(100).default(30),
});

const NS = "dreaming-v2";
const CURSOR_KEY = "memtax:cursor";

// Closed path enum, taxonomy §3.2, every long-term path under /longterm/ (2026-10-01). Anything not under
// /longterm/ is inbox; `/inbox/<id>` is the explicit "fits nowhere" answer. `<slug>` = kebab, `<id>` = memory id.
// Inside the server allowlist (key-paths.ts LONGTERM_ROOTS / LONGTERM_ENTITY_TYPES, PR #1814): /longterm/<root> is
// company-story | entities | facts | decisions | workstreams | timeline, and entities/<type> is people | customers.
// Every key is lowercase (MEMORY_KEY_PATTERN).
// Operator 2026-10-06: /longterm is recall only (recall only: if it can be a skill or script, it should be one). A how-to, procedure or service-usage note has no /longterm home: B1 files it at /howto/<slug>, a routing
// path that is never written. Lane B hands /howto clusters to synthesize as skillify / skill-refactor / scriptify.
// Operator 2026-10-06, 2nd ask: "/longterm is the swarm's distilled understanding: who people are and how the company works". /longterm is a few living subject docs, rewritten as evidence accrues: people,
// customers, the company story (one doc per section), decisions, workstreams. Episodic notes (a bug, an incident, a
// fix) are not a subject: they stay in the inbox on their TTL. /longterm/facts is retired for new writes.
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

// The pre-10-06 how-to homes. Route logic only: a classifier row still using one is re-filed to /howto/<slug>, and
// guardLongtermWrite refuses any create or edit under them.
export const LEGACY_HOWTO_RE = new RegExp(`^/longterm/facts/(services|procedures)/(${SLUG})$`);
export const toHowto = (path: string): string => {
  const m = LEGACY_HOWTO_RE.exec(String(path ?? ""));
  return m ? `/howto/${m[2]}` : String(path ?? "");
};
// Re-file a classifier path written against an older enum. how-to -> /howto/<slug>; anything else under the retired
// /longterm/facts root is episodic -> the doc stays in the inbox (/inbox/<id>); the bare story root -> its overview.
export function refile(path: string, id: string): { path: string; why: "howto" | "episodic" | "story-section" | null } {
  const p = String(path ?? "");
  if (LEGACY_HOWTO_RE.test(p)) return { path: toHowto(p), why: "howto" };
  if (p === "/longterm/facts" || p.startsWith("/longterm/facts/")) return { path: `/inbox/${id}`, why: "episodic" };
  if (p === "/longterm/company-story") return { path: "/longterm/company-story/overview", why: "story-section" };
  return { path: p, why: null };
}
export function guardLongtermWrite(x: { op: string; name: string }): { ok: true } | { ok: false; why: string } {
  if (x.op === "delete") return { ok: true };
  const name = String(x.name ?? "");
  if (!name.startsWith("/longterm/")) return { ok: false, why: "not-longterm" };
  if (/^\/longterm\/facts\/(services|procedures)(\/|$)/.test(name)) return { ok: false, why: "howto-root" };
  if (/^\/longterm\/facts(\/|$)/.test(name)) return { ok: false, why: "retired-root" };
  return { ok: true };
}
export function validateClassification(c: any, ids: Set<string>): { ok: true; row: any } | { ok: false; why: string } {
  if (!c || typeof c !== "object") return { ok: false, why: "not-an-object" };
  const id = String(c.id ?? "");
  if (!ids.has(id)) return { ok: false, why: "unknown-id" };
  let action = String(c.action ?? "");
  const m = /^merge-into:(.+)$/.exec(action);
  const rp = refile(String(c.path ?? ""), id);
  const rt = m ? refile(m[1]!, id) : null;
  // Episodic: the doc's destination (merge target if any, else path) on the retired facts root keeps it in the inbox
  // (a delete stays a delete). A facts path merged into a live target follows the target.
  const episodic = rt ? rt.why === "episodic" : rp.why === "episodic";
  const path = episodic ? `/inbox/${id}` : rp.why === "episodic" && rt ? rt.path : rp.path;
  const root = pathRoot(path);
  if (!root) return { ok: false, why: "path-outside-enum" };
  let kind = String(c.kind ?? "");
  if (!(KINDS as readonly string[]).includes(kind)) return { ok: false, why: "bad-kind" };
  let mergeTarget = rt ? rt.path : null;
  if (episodic) {
    mergeTarget = null;
    kind = "inbox";
    if (action !== "delete") action = "keep";
  } else if (m) {
    if (!pathRoot(mergeTarget!)) return { ok: false, why: "merge-target-outside-enum" };
    action = "merge-into";
  } else if (!["keep", "move", "supersede", "delete"].includes(action)) return { ok: false, why: "bad-action" };
  if (root === "/howto" || (mergeTarget && pathRoot(mergeTarget) === "/howto")) kind = "procedure";
  const refiled = episodic ? "episodic" : (rt ? rt.why : rp.why);
  const remapped = refiled !== null;
  const entitySlugs = Array.isArray(c.entitySlugs) ? c.entitySlugs.map(String).slice(0, 10) : [];
  return { ok: true, row: { id, path, root, kind, action, mergeTarget, remapped, refiled, entitySlugs, reason: String(c.reason ?? "").slice(0, 300) } };
}

// foreach aggregate -> per batch {batchId, status, taskId, classifications|null, error}
export function parseClassify(classify: unknown): Array<{ batchId: string; status: string; taskId: string | null; items: any[] | null; error: string | null }> {
  const agg: any = parse(classify);
  const results: any[] = Array.isArray(agg?.results) ? agg.results : [];
  return results.map((r: any) => {
    const batchId = String(r?.itemKey ?? "");
    const taskId = r?.output?.taskId ? String(r.output.taskId) : null;
    if (r?.status !== "completed") return { batchId, status: String(r?.status ?? "unknown"), taskId, items: null, error: String(r?.error ?? r?.output?.taskOutput ?? "not completed").slice(0, 200) };
    const out: any = parse(r?.output?.taskOutput);
    if (typeof r?.output?.taskOutput === "string" && r.output.taskOutput.startsWith("[FAILED")) return { batchId, status: "failed", taskId, items: null, error: r.output.taskOutput.slice(0, 200) };
    if (!out || !Array.isArray(out.classifications)) return { batchId, status: "unparseable", taskId, items: null, error: "taskOutput has no classifications array" };
    return { batchId, status: "completed", taskId, items: out.classifications, error: null };
  });
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

const rows = (r: any): any[] => {
  const d = r?.data ?? r;
  if (d?.error) throw new Error(String(d.error));
  if (!Array.isArray(d?.rows)) throw new Error("db_query returned no rows array (throttled?)");
  const c: string[] = d?.columns ?? [];
  return d.rows.map((x: any[]) => Object.fromEntries(c.map((k, i) => [k, x[i]])));
};

// Seeded shuffle (mulberry32 over an FNV-1a hash of the seed): the same run renders the same 30 samples.
export function seededSample<T>(arr: T[], n: number, seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let s = h >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

// Cheap pre-sort (taxonomy §5.1 buckets). A hint for the classifier and a sanity check, never the answer.
export function preSort(name: string, tags: string): string {
  const s = `${name} ${tags}`.toLowerCase();
  if (/prefer|wants|standing instruction|comms/.test(s)) return "people/prefs";
  if (/customer|client-swarm|prospect|jan-carbonell/.test(s)) return "customer";
  if (/digest|journal|daily-|weekly-|briefing|retro/.test(s)) return "journal/digest";
  if (/linkedin|blog|seo|tweet|content|gtm|newsletter|reddit|bluesky/.test(s)) return "content/GTM";
  if (/repo|ci|deploy|fly|docker|github|infra|pr-|migration/.test(s)) return "repo/infra";
  if (/workflow|script|memory|slack|kv|swarm|agent|task|heartbeat|gotcha/.test(s)) return "swarm-runtime";
  return "other";
}

const esc = (s: string, n: number) => String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, n);

export function renderSection(r: { runId: string; dry: boolean; batches: number; okBatches: number; failedBatches: Array<{ batchId: string; status: string; error: string | null }>; docsPlanned: number; classified: number; invalid: Record<string, number>; missing: number; perRoot: Record<string, number>; perAction: Record<string, number>; mergeTargets: number; samples: any[]; cost: { usd: number | null; perBatchUsd: number | null }; costBasis?: string; memoryWrites: number | null; kv: string; skipReason?: string | null; howto?: { docs: number; remapped: number }; subject?: { episodic: number; story: number; people: number } }): string {
  const L: string[] = [];
  L.push("## Memory taxonomy (lane B1, classify-only)");
  if (r.skipReason) {
    L.push(`Skipped: ${r.skipReason}. No classification ran; no other lane is affected.`);
    return L.join("\n");
  }
  L.push(`${r.classified} of ${r.docsPlanned} docs classified in ${r.okBatches}/${r.batches} batches. No memory writes (B1 is read-only${r.memoryWrites === null ? "" : `; memtax-tagged writes in window: ${r.memoryWrites}`}). KV: ${r.kv}.`);
  if (r.cost.usd !== null) L.push(`Cost: $${r.cost.usd.toFixed(2)} total, $${(r.cost.perBatchUsd ?? 0).toFixed(2)} per batch (${r.costBasis ?? "this run"}, session_costs).`);
  else L.push("Cost: pending (session_costs lands after the classify tasks finish; gather counts it in the next night's full cost).");
  if (r.howto) L.push(`How-to routed to skills/scripts, not /longterm (/longterm is recall only): ${r.howto.docs} docs at /howto/<slug>${r.howto.remapped ? `, ${r.howto.remapped} re-filed from the retired facts/services|procedures paths` : ""}.`);
  if (r.subject) L.push(`Subject docs (taxonomy v5, /longterm is distilled understanding): ${r.subject.people} people and ${r.subject.story} company-story rows feed their living docs; ${r.subject.episodic} episodic notes (bug, incident, fix) stay in the inbox on their TTL, never a /longterm doc.`);
  if (r.failedBatches.length) L.push(`Failed batches (lane continued without them): ${r.failedBatches.map((b) => `${b.batchId} ${b.status}`).join(", ")}.`);
  const inv = Object.entries(r.invalid).filter(([, n]) => n > 0);
  if (inv.length || r.missing) L.push(`Rejected rows: ${inv.map(([k, n]) => `${k} ${n}`).join(", ") || "none"}; docs with no row: ${r.missing}.`);
  L.push("", "| path | docs |", "|---|---:|");
  for (const [k, n] of Object.entries(r.perRoot).sort((a, b) => b[1] - a[1])) L.push(`| \`${k}\` | ${n} |`);
  L.push("", `Actions: ${Object.entries(r.perAction).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}. Merge targets with 2+ members: ${r.mergeTargets}.`);
  if (r.samples.length) {
    L.push("", `**${r.samples.length} random samples to spot-check** (seed = run id):`, "", "| # | doc | proposed path | action | reason |", "|---:|---|---|---|---|");
    r.samples.forEach((s, i) => L.push(`| ${i + 1} | ${esc(s.name, 70)} (\`${String(s.id).slice(0, 8)}\`) | \`${s.path}\` | ${s.action === "merge-into" ? `merge-into \`${s.mergeTarget}\`` : s.action} | ${esc(s.reason, 120)} |`));
  }
  return L.join("\n");
}

/** Dreaming lane B1: memory taxonomy plan, classify report and controls; no memory writes. */
export default async function (args: unknown, ctx: ScriptContext) {
  const p = argsSchema.safeParse(args ?? {});
  if (!p.success) return { ok: false, mode: "invalid-args", batches: [], errors: [p.error.message.slice(0, 400)] };
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
    // Belt and braces: never throw out of a workflow node.
    return { ok: false, mode: a.mode, batches: [], markdown: "## Memory taxonomy (lane B1, classify-only)\nSkipped: script error. No other lane is affected.", errors: [...errors, String(e?.message ?? e).slice(0, 300)] };
  }

  async function plan() {
    const gen = a.generatedAt && !Number.isNaN(Date.parse(a.generatedAt)) ? new Date(a.generatedAt) : new Date();
    const since = new Date(gen.getTime() - 86400000).toISOString();
    const budget: any = parse(a.budget) ?? {};
    let skipReason: string | null = null;
    if (String(a.memtax ?? "").toLowerCase() === "off") skipReason = "disabled (workflow input memtax=off)";
    const overCap = Number(budget?.prevRunUsd) > Number(budget?.cap ?? 25);
    if (!skipReason && overCap) skipReason = `previous run $${budget.prevRunUsd} over the $${budget.cap ?? 25} cap`;
    // Over the soft cap (gather budget.overBudget): today's docs only, no backlog.
    const backlogBatches = budget?.overBudget ? 0 : a.backlogBatches;
    const caps = { batchSize: a.batchSize, maxTodayBatches: a.maxTodayBatches, backlogBatches, previewChars: a.previewChars, overBudget: !!budget?.overBudget };
    if (skipReason) return { ok: true, mode: "plan", dryRun: dry, runId, since, skipReason, batches: [], caps, counts: {}, errors };

    const S = a.batchSize;
    const todayCap = S * a.maxTodayBatches;
    const backlogCap = S * backlogBatches;
    const cursorEntry: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key: CURSOR_KEY }).catch(() => null);
    const cursor = parse(cursorEntry?.value) ?? { createdAt: "", id: "" };
    // Aggregates in SQL (no row pulls).
    const counts = (
      await q(
        "counts",
        `SELECT
           SUM(CASE WHEN source='manual' AND (createdAt >= ?1 OR updatedAt >= ?1) THEN 1 ELSE 0 END) AS today,
           SUM(CASE WHEN (createdAt > ?2 OR (createdAt = ?2 AND id > ?3)) THEN 1 ELSE 0 END) AS backlogLeft,
           COUNT(*) AS curated
         FROM agent_memory WHERE chunkIndex = 0 AND source IN ('manual','file_index')`,
        [since, cursor.createdAt ?? "", cursor.id ?? ""],
      )
    )[0] ?? {};
    // One doc per row: chunk 0 plus chunk 1 when chunk 0 is short, cut to previewChars; tags, posteriors, inbound links.
    const docSql = (where: string) => `
      SELECT m.id, m.name, m.scope, m.source, m.agentId, m.key, m.tags, m.accessCount, m.alpha, m.beta, m.totalChunks, m.createdAt,
        substr(m.content || CASE WHEN length(m.content) < ?P THEN coalesce((SELECT c.content FROM agent_memory c WHERE c.key = m.key AND c.scope = m.scope AND coalesce(c.agentId,'') = coalesce(m.agentId,'') AND c.chunkIndex = 1), '') ELSE '' END, 1, ?P) AS text,
        (SELECT COUNT(*) FROM memory_link l WHERE l.targetId = m.id) AS inLinks
      FROM agent_memory m WHERE m.chunkIndex = 0 AND ${where}`;
    const P = a.previewChars;
    const today = todayCap
      ? await q("today", docSql(`m.source = 'manual' AND (m.createdAt >= ? OR m.updatedAt >= ?) ORDER BY m.createdAt, m.id LIMIT ?`).replaceAll("?P", String(P)), [since, since, Math.min(todayCap, 400)])
      : [];
    const todayIds = new Set(today.map((r) => r.id));
    const backlogRaw = backlogCap
      ? await q(
          "backlog",
          docSql(`m.source IN ('manual','file_index') AND (m.createdAt > ? OR (m.createdAt = ? AND m.id > ?)) ORDER BY m.createdAt, m.id LIMIT ?`).replaceAll("?P", String(P)),
          [cursor.createdAt ?? "", cursor.createdAt ?? "", cursor.id ?? "", Math.min(backlogCap + todayIds.size, 400)],
        )
      : [];
    const backlog = backlogRaw.filter((r) => !todayIds.has(r.id)).slice(0, backlogCap);
    const doc = (r: any) => ({
      id: r.id,
      name: String(r.name ?? "").slice(0, 160),
      scope: r.scope,
      source: r.source,
      key: String(r.key ?? "").slice(0, 120),
      tags: String(r.tags ?? "").slice(0, 200),
      acc: Number(r.accessCount ?? 0),
      ab: `${Number(r.alpha ?? 1).toFixed(1)}/${Number(r.beta ?? 1).toFixed(1)}`,
      inLinks: Number(r.inLinks ?? 0),
      chunks: Number(r.totalChunks ?? 1),
      created: String(r.createdAt ?? "").slice(0, 10),
      pre: preSort(String(r.name ?? ""), String(r.tags ?? "")),
      text: String(r.text ?? ""),
    });
    const date = gen.toISOString().slice(0, 10);
    const batches: any[] = [];
    const chunk = (list: any[], kind: string) => {
      for (let i = 0; i < list.length; i += S) batches.push({ batchId: `${date}-${kind}-${batches.filter((b) => b.kind === kind).length + 1}`, kind, docs: list.slice(i, i + S).map(doc) });
    };
    chunk(today, "today");
    chunk(backlog, "backlog");
    const last = backlog[backlog.length - 1];
    return {
      ok: errors.length === 0,
      mode: "plan",
      dryRun: dry,
      runId,
      since,
      skipReason: batches.length ? null : errors.length ? "plan query failed" : "no docs to classify",
      batches,
      caps,
      counts: { todayDocs: Number(counts.today ?? 0), backlogLeft: Number(counts.backlogLeft ?? 0), curated: Number(counts.curated ?? 0), planned: batches.reduce((s, b) => s + b.docs.length, 0), todayPlanned: today.length, backlogPlanned: backlog.length },
      cursor: { from: cursor, to: last ? { createdAt: last.createdAt, id: last.id } : cursor },
      errors,
    };
  }

  async function report() {
    const pl: any = parse(a.plan) ?? {};
    const planned: any[] = Array.isArray(pl.batches) ? pl.batches : [];
    const runDry = pl.dryRun === undefined ? dry : pl.dryRun === true || dry;
    if (!planned.length) {
      const skipReason = String(pl.skipReason ?? (a.plan ? "plan returned no batches" : "memtax-plan did not run"));
      const markdown = renderSection({ runId, dry: runDry, batches: 0, okBatches: 0, failedBatches: [], docsPlanned: 0, classified: 0, invalid: {}, missing: 0, perRoot: {}, perAction: {}, mergeTargets: 0, samples: [], cost: { usd: null, perBatchUsd: null }, memoryWrites: null, kv: "none", skipReason });
      return { ok: true, mode: "report", dryRun: runDry, runId, skipReason, markdown, counts: { classified: 0 }, errors: [...errors, ...(Array.isArray(pl.errors) ? pl.errors.map(String) : [])] };
    }
    const meta = new Map<string, any>();
    for (const b of planned) for (const d of b.docs ?? []) meta.set(String(d.id), { ...d, batchId: b.batchId, batchKind: b.kind });
    const ids = new Set(meta.keys());
    const parsed = parseClassify(a.classify);
    const byBatch = new Map(parsed.map((x) => [x.batchId, x]));
    const failedBatches = planned
      .map((b) => byBatch.get(b.batchId) ?? { batchId: String(b.batchId), status: a.classify ? "missing" : "not-run", taskId: null, items: null, error: null })
      .filter((x) => x.status !== "completed")
      .map((x) => ({ batchId: x.batchId, status: x.status, error: x.error }));
    const invalid: Record<string, number> = {};
    const good = new Map<string, any>();
    for (const x of parsed) {
      if (x.status !== "completed" || !x.items) continue;
      for (const c of x.items) {
        const v = validateClassification(c, ids);
        if (!v.ok) invalid[v.why] = (invalid[v.why] ?? 0) + 1;
        else if (good.has(v.row.id)) invalid["duplicate-id"] = (invalid["duplicate-id"] ?? 0) + 1;
        else good.set(v.row.id, { ...v.row, name: meta.get(v.row.id)?.name, source: meta.get(v.row.id)?.source, batchId: x.batchId, taskId: x.taskId });
      }
    }
    const okBatchIds = new Set(parsed.filter((x) => x.status === "completed").map((x) => x.batchId));
    const missing = [...meta.values()].filter((d) => okBatchIds.has(d.batchId) && !good.has(String(d.id))).length;
    const perRoot: Record<string, number> = {};
    const perAction: Record<string, number> = {};
    const targets: Record<string, number> = {};
    for (const r of good.values()) {
      perRoot[r.root] = (perRoot[r.root] ?? 0) + 1;
      perAction[r.action] = (perAction[r.action] ?? 0) + 1;
      const t = r.mergeTarget ?? (r.root.startsWith("/longterm/entities") || r.root === "/longterm/company-story" ? r.path : null);
      if (t) targets[t] = (targets[t] ?? 0) + 1;
    }
    const mergeTargets = Object.values(targets).filter((n) => n >= 2).length;
    const howtoRows = [...good.values()].filter((r) => r.root === "/howto" || (r.mergeTarget && pathRoot(r.mergeTarget) === "/howto"));
    const howto = { docs: howtoRows.length, remapped: [...good.values()].filter((r) => r.refiled === "howto").length };
    const tgt = (r: any) => r.mergeTarget ?? r.path;
    const subject = { episodic: [...good.values()].filter((r) => r.refiled === "episodic").length, story: [...good.values()].filter((r) => tgt(r).startsWith("/longterm/company-story/")).length, people: [...good.values()].filter((r) => tgt(r).startsWith("/longterm/entities/people/")).length };
    const samples = seededSample([...good.values()], a.sampleSize, runId || "memtax");

    // Measured cost of the classify tasks.
    const taskIds = parsed.map((x) => x.taskId).filter(Boolean) as string[];
    let cost = { usd: null as number | null, perBatchUsd: null as number | null, tasks: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, models: [] as string[] };
    if (taskIds.length) {
      const c = (
        await q(
          "cost",
          `SELECT COUNT(DISTINCT taskId) tasks, SUM(totalCostUsd) usd, SUM(inputTokens) inTok, SUM(outputTokens) outTok, SUM(cacheReadTokens) cacheTok, group_concat(DISTINCT model) models FROM session_costs WHERE taskId IN (${taskIds.map(() => "?").join(",")})`,
          taskIds,
        )
      )[0];
      if (c && c.usd !== null && c.usd !== undefined) {
        const usd = Number(c.usd);
        cost = { usd, perBatchUsd: taskIds.length ? usd / taskIds.length : null, tasks: Number(c.tasks ?? 0), inputTokens: Number(c.inTok ?? 0), outputTokens: Number(c.outTok ?? 0), cacheReadTokens: Number(c.cacheTok ?? 0), models: String(c.models ?? "").split(",").filter(Boolean) };
      }
    }
    // session_costs lands a few seconds after the task finishes, usually after this node ran. Fall back to the
    // measured mean of the last 7 days of memtax classify tasks, labelled as such.
    let costBasis = cost.usd === null ? "pending" : "this run";
    if (cost.usd === null) {
      const prior = (
        await q(
          "cost-prior",
          `SELECT COUNT(*) tasks, AVG(s.usd) usd FROM (SELECT sc.taskId, SUM(sc.totalCostUsd) usd FROM session_costs sc JOIN agent_tasks t ON t.id = sc.taskId WHERE t.tags LIKE '%dreaming-v2-memtax%' AND t.status = 'completed' AND sc.createdAt >= datetime('now','-7 days') GROUP BY sc.taskId) s`,
        )
      )[0];
      if (prior && Number(prior.tasks) > 0 && prior.usd !== null) {
        cost.perBatchUsd = Number(prior.usd);
        cost.usd = cost.perBatchUsd * taskIds.length;
        costBasis = `estimate: mean of ${prior.tasks} completed memtax tasks in 7 days`;
      }
    }
    // Control: B1 must write no memory. memtax-tagged rows touched since the plan window, and manual rows (memory-store /
    // inject-learning) written by the classify tasks. The runner's own session_summary/task_completion rows are not agent writes.
    const since = String(pl.since ?? new Date(Date.now() - 86400000).toISOString());
    const mw = (await q("memory-writes", `SELECT COUNT(*) n FROM agent_memory WHERE tags LIKE '%memtax%' AND (updatedAt >= ? OR createdAt >= ?)`, [since, since]))[0];
    const memoryWrites = mw ? Number(mw.n) : null;
    const taskWrites = taskIds.length
      ? Number((await q("task-writes", `SELECT COUNT(*) n FROM agent_memory WHERE sourceTaskId IN (${taskIds.map(() => "?").join(",")}) AND source = 'manual'`, taskIds))[0]?.n ?? 0)
      : 0;

    // Live only: KV memtax:class:<id> and the backlog cursor. Bounded so a slow KV can never time the node out.
    let kv = runDry ? "dry run, nothing written" : "";
    let kvWritten = 0;
    if (!runDry) {
      const t0 = Date.now();
      const list = [...good.values()];
      for (let i = 0; i < list.length && Date.now() - t0 < 45000; i += 20) {
        const res = await Promise.allSettled(
          list.slice(i, i + 20).map((r) =>
            ctx.swarm.kv_set({ namespace: NS, key: `memtax:class:${r.id}`, value: { id: r.id, path: r.path, root: r.root, kind: r.kind, action: r.action, mergeTarget: r.mergeTarget, entitySlugs: r.entitySlugs, reason: r.reason, runId, batchId: r.batchId, taskId: r.taskId, at: new Date().toISOString() } as any }),
          ),
        );
        kvWritten += res.filter((x) => x.status === "fulfilled").length;
      }
      // Advance the backlog cursor only past fully completed backlog batches, so a failed batch is retried tomorrow.
      const backlogPlanned = planned.filter((b) => b.kind === "backlog");
      let to: any = null;
      for (const b of backlogPlanned) {
        if (!okBatchIds.has(b.batchId)) break;
        const lastDoc = (b.docs ?? [])[(b.docs ?? []).length - 1];
        if (lastDoc) to = lastDoc;
      }
      if (to) {
        const cur = pl?.cursor?.to && pl.cursor.to.id === to.id ? pl.cursor.to : null;
        const createdAt = cur?.createdAt ?? (await q("cursor", `SELECT createdAt FROM agent_memory WHERE id = ?`, [to.id]))[0]?.createdAt;
        if (createdAt) await ctx.swarm.kv_set({ namespace: NS, key: CURSOR_KEY, value: { createdAt, id: to.id, runId, at: new Date().toISOString() } as any }).catch((e: any) => errors.push(`cursor: ${String(e?.message ?? e).slice(0, 120)}`));
      }
      kv = `${kvWritten} memtax:class keys written${kvWritten < good.size ? ` (${good.size - kvWritten} not written)` : ""}`;
    }
    const counts = { batches: planned.length, okBatches: okBatchIds.size, docsPlanned: meta.size, classified: good.size, missing, invalid, perRoot, perAction, mergeTargets, howto: howto.docs, howtoRemapped: howto.remapped, episodic: subject.episodic, story: subject.story, people: subject.people };
    const markdown = renderSection({ runId, dry: runDry, batches: planned.length, okBatches: okBatchIds.size, failedBatches, docsPlanned: meta.size, classified: good.size, invalid, missing, perRoot, perAction, mergeTargets, samples, cost, memoryWrites, kv, costBasis, howto, subject });
    return {
      ok: errors.length === 0 && failedBatches.length === 0,
      mode: "report",
      dryRun: runDry,
      runId,
      counts,
      cost: { ...cost, basis: costBasis },
      controls: { memtaxTaggedWrites: memoryWrites, classifyTaskMemoryWrites: taskWrites, readOnly: memoryWrites === 0 && taskWrites === 0 },
      failedBatches,
      samples: samples.map((s) => ({ id: s.id, name: s.name, path: s.path, action: s.action, mergeTarget: s.mergeTarget, reason: s.reason })),
      kvWritten,
      markdown,
      errors,
    };
  }

  function controls() {
    const ids = new Set(["a1", "a2"]);
    const cases: Array<{ name: string; pass: boolean; got?: unknown }> = [];
    const t = (name: string, pass: boolean, got?: unknown) => cases.push({ name, pass, got });
    t("path refused: /longterm/facts retired (taxonomy v5)", pathRoot("/longterm/facts/workflows/foreach-join-semantics") === null && pathRoot("/longterm/facts/infra/ci-hang") === null);
    t("path ok: company-story sections; bare root refused", STORY_SECTIONS.every((x) => pathRoot(`/longterm/company-story/${x}`) === "/longterm/company-story") && pathRoot("/longterm/company-story") === null && pathRoot("/longterm/company-story/random") === null);
    t("path refused: dropped roots (PR #1814 allowlist)", ["/longterm/entities/repos/example-org/app", "/longterm/entities/agents/lead", "/longterm/entities/services/github", "/longterm/procedures/x", "/longterm/timeline/weekly/2026-W40"].every((p) => pathRoot(p) === null));
    t("path refused: retired how-to roots (operator 10-06)", pathRoot("/longterm/facts/procedures/x") === null && pathRoot("/longterm/facts/services/github") === null);
    t("path ok: /howto routing root and lowercase week", pathRoot("/howto/github") === "/howto" && pathRoot("/longterm/timeline/weekly/2026-w40") === "/longterm/timeline/weekly");
    t("path refused: /howto needs a kebab slug", pathRoot("/howto/GitHub") === null && pathRoot("/howto/a/b") === null);
    t("path ok /longterm/decisions/date-slug", pathRoot("/longterm/decisions/2026-09-04-linkedin-page-retired") === "/longterm/decisions");
    t("path refused: unknown root", pathRoot("/longterm/preferences/ada") === null);
    t("path refused: no /longterm prefix", pathRoot("/facts/workflows/foreach-join-semantics") === null);
    t("path ok /inbox/<id> (not long-term)", pathRoot("/inbox/70a57182-bd98-4806-b474-d77c9b761722") === "/inbox");
    t("path refused: bad fact domain", pathRoot("/longterm/facts/marketing/x") === null);
    t("path refused: uppercase", pathRoot("/longterm/facts/workflows/Foo") === null);
    t("path refused: decision without date", pathRoot("/longterm/decisions/linkedin") === null);
    t("action refused: merge into bad path", validateClassification({ id: "a1", path: "/howto/x-y", kind: "procedure", action: "merge-into:/nope/x" }, ids).ok === false);
    t("id refused: unknown", validateClassification({ id: "zz", path: "/howto/x-y", kind: "procedure", action: "keep" }, ids).ok === false);
    t("row ok", validateClassification({ id: "a2", path: "/howto/hn-briefing", kind: "procedure", action: "merge-into:/howto/hn-briefing" }, ids).ok === true);
    const legacy: any = validateClassification({ id: "a1", path: "/longterm/facts/services/clickhouse", kind: "fact", action: "merge-into:/longterm/facts/services/clickhouse" }, ids);
    t("route: legacy services row re-filed to /howto (positive control)", legacy.ok && legacy.row.path === "/howto/clickhouse" && legacy.row.mergeTarget === "/howto/clickhouse" && legacy.row.root === "/howto" && legacy.row.kind === "procedure" && legacy.row.remapped === true, legacy);
    const legacyP: any = validateClassification({ id: "a2", path: "/longterm/facts/procedures/hn-briefing", kind: "procedure", action: "move" }, ids);
    t("route: legacy procedures row re-filed to /howto", legacyP.ok && legacyP.row.path === "/howto/hn-briefing" && legacyP.row.remapped === true, legacyP);
    const bug: any = validateClassification({ id: "e1-episodic", path: "/longterm/facts/infra/ci-run-tests-shard2-hang", kind: "fact", action: "move" }, new Set(["e1-episodic"]));
    t("episodic: bug note on a facts path stays in the inbox (positive control)", bug.ok && bug.row.path === "/inbox/e1-episodic" && bug.row.root === "/inbox" && bug.row.kind === "inbox" && bug.row.action === "keep" && bug.row.refiled === "episodic", bug);
    const bugM: any = validateClassification({ id: "e2-episodic", path: "/longterm/facts/workflows/x", kind: "fact", action: "merge-into:/longterm/facts/workflows/workflow-condition-evaluation-bug" }, new Set(["e2-episodic"]));
    t("episodic: merge into a facts doc -> inbox, no merge target", bugM.ok && bugM.row.path === "/inbox/e2-episodic" && bugM.row.mergeTarget === null && bugM.row.refiled === "episodic", bugM);
    const ppl: any = validateClassification({ id: "a1", path: "/longterm/entities/people/ada", kind: "entity", action: "merge-into:/longterm/entities/people/ada" }, ids);
    const sty: any = validateClassification({ id: "a2", path: "/longterm/company-story", kind: "story", action: "merge-into:/longterm/company-story" }, ids);
    t("subject: people row untouched; bare story root -> overview (negative control)", ppl.ok && ppl.row.mergeTarget === "/longterm/entities/people/ada" && ppl.row.remapped === false && sty.ok && sty.row.mergeTarget === "/longterm/company-story/overview" && sty.row.refiled === "story-section", { ppl, sty });
    const dec: any = validateClassification({ id: "a1", path: "/longterm/decisions/2026-03-24-pr-merging-rules", kind: "decision", action: "keep" }, ids);
    t("route: decision untouched (negative control)", dec.ok && dec.row.path === "/longterm/decisions/2026-03-24-pr-merging-rules" && dec.row.remapped === false && dec.row.kind === "decision", dec);
    t("guard: create/edit under facts/services|procedures refused (positive control)", [guardLongtermWrite({ op: "create", name: "/longterm/facts/services/clickhouse" }), guardLongtermWrite({ op: "edit", name: "/longterm/facts/procedures/hn-briefing" })].every((g: any) => g.ok === false && g.why === "howto-root"));
    t("guard: /howto and inbox are never written", (guardLongtermWrite({ op: "create", name: "/howto/clickhouse" }) as any).why === "not-longterm");
    t("guard: create/edit under /longterm/facts refused (taxonomy v5)", [guardLongtermWrite({ op: "create", name: "/longterm/facts/infra/ci-hang" }), guardLongtermWrite({ op: "edit", name: "/longterm/facts/workflows/x" })].every((g: any) => g.ok === false && g.why === "retired-root"));
    t("guard: recall writes and deletes pass (negative control)", ["/longterm/decisions/2026-10-06-longterm-is-recall-only", "/longterm/company-story/overview", "/longterm/entities/people/ada", "/longterm/workstreams/active/dreaming-v2"].every((n) => guardLongtermWrite({ op: "create", name: n }).ok) && guardLongtermWrite({ op: "delete", name: "/longterm/facts/services/clickhouse" }).ok && guardLongtermWrite({ op: "delete", name: "/longterm/facts/infra/x" }).ok);
    t("render: subject line", renderSection({ runId: "r", dry: true, batches: 1, okBatches: 1, failedBatches: [], docsPlanned: 2, classified: 2, invalid: {}, missing: 0, perRoot: {}, perAction: {}, mergeTargets: 0, samples: [], cost: { usd: null, perBatchUsd: null }, memoryWrites: 0, kv: "none", subject: { episodic: 1, story: 1, people: 0 } }).includes("1 episodic notes"));
    t("render: how-to line", renderSection({ runId: "r", dry: true, batches: 1, okBatches: 1, failedBatches: [], docsPlanned: 2, classified: 2, invalid: {}, missing: 0, perRoot: { "/howto": 2 }, perAction: {}, mergeTargets: 0, samples: [], cost: { usd: null, perBatchUsd: null }, memoryWrites: 0, kv: "none", howto: { docs: 2, remapped: 1 } }).includes("How-to routed to skills/scripts"));
    // Negative controls: a failed, cancelled, empty or garbage classify must parse to non-completed batches, never throw.
    const neg = parseClassify({ results: [{ itemKey: "b1", status: "completed", output: { taskId: "t1", taskOutput: "[FAILED: memtax negative control] This node failed or was cancelled." } }, { itemKey: "b2", status: "failed" }, { itemKey: "b3", status: "completed", output: { taskId: "t3", taskOutput: "not json" } }] });
    t("neg: [FAILED] taskOutput -> failed", neg[0]?.status === "failed", neg[0]);
    t("neg: failed child -> failed", neg[1]?.status === "failed", neg[1]);
    t("neg: garbage output -> unparseable", neg[2]?.status === "unparseable", neg[2]);
    t("neg: empty string classify -> []", parseClassify("").length === 0);
    t("neg: undefined classify -> []", parseClassify(undefined).length === 0);
    const md = renderSection({ runId: "r", dry: true, batches: 2, okBatches: 0, failedBatches: [{ batchId: "b1", status: "failed", error: "x" }], docsPlanned: 80, classified: 0, invalid: {}, missing: 0, perRoot: {}, perAction: {}, mergeTargets: 0, samples: [], cost: { usd: null, perBatchUsd: null }, memoryWrites: 0, kv: "none" });
    t("neg: all-failed renders a section", md.includes("Failed batches") && md.startsWith("## Memory taxonomy"));
    const s1 = seededSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, "run-x");
    t("sample deterministic", JSON.stringify(s1) === JSON.stringify(seededSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, "run-x")) && s1.length === 3);
    return { ok: cases.every((c) => c.pass), mode: "controls", passed: cases.filter((c) => c.pass).length, total: cases.length, failed: cases.filter((c) => !c.pass), batches: [], errors };
  }
}
