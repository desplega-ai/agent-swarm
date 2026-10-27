import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming-v2 lane B, CREATE + VALIDATE + TIDY on top of B1 classify (global dreaming-memtax). Operator 2026-10-01:
// curated memories live at name = /longterm/<path> (taxonomy dreaming-v2/memory-taxonomy.md §3.2), scope swarm.
// Anything not under /longterm/ is inbox and is never written or deleted here (B2/B3).
//   plan     -> read-only. Ingest every /longterm/* doc (chunk 0), the source records (users, agents, swarm_repos)
//               and tonight's B1 classifications. Propose deterministic entity docs, B1 clusters to distill,
//               validate verdicts (ok / stale / drift / duplicate / bad-path) and tidy ops inside /longterm/.
//   apply    -> compose the final docs (plan + distill output), re-check live, write ONLY when v3Writes is on and
//               not dryRun, capped per night. Every write: KV pre-image, re-read sha, row in KV
//               memtax-create:writes:<runId>, and an item appended to ledger:<runId> so the next night's
//               dreaming-verify survival check reads it. Dry: same output, zero writes.
//   rollback -> undo one run's writes by id from memtax-create:writes:<runId> (dry unless execute=true).
//   sample   -> scratch dry runs only: B1-shaped batches picked by a name filter.
//   controls -> self-test of the pure functions, including negative controls.
// Never throws: a sync node that throws fails the whole run, and this lane must never block publish or verify.
// Writes run as the workflow's createdByAgentId (Lead for dreaming-v2), so the /longterm Lead-only guard passes.
// No tool can set expiresAt today, so "supersede" is the taxonomy §3.1 in-place correction (old text stays in
// agent_memory_version). Docs stay <= 1,950 chars so they are one chunk (chunking.ts MAX_CHUNK_SIZE 2000):
// memory-edit refuses multi-chunk docs.
// Operator 2026-10-01: no docs are created under /longterm/entities/agents or /longterm/entities/repos. Agent profiles
// (soulMd/identityMd) and get-repos are the source of truth. agents and swarm_repos rows are still read, as reference
// records that VALIDATE checks people/customer docs against.
// Operator 2026-10-06: /longterm is recall only. How-to (B1 /howto/<slug>, or a fact an existing skill covers) is never
// written: plan routes it to skill-update / skill-new / script, apply hands it to the next night's synthesize via KV
// memtax-create:skill-routes:latest, and guardLongtermWrite refuses every create/edit under facts/services|procedures.
// Operator 2026-10-06, 2nd ask (taxonomy v5): "/longterm is the swarm's distilled understanding: who people are and how the company works". /longterm is a few living subject docs. Distill REWRITES an existing
// subject doc (merge, dedupe, dated supersede, one-chunk cap) instead of appending; the doc itself is never a cluster
// member. Episodic notes (bug, incident, fix) never create a /longterm doc: /longterm/facts is retired for writes and
// B1 rows on it stay in the inbox. company-story is one doc per section (STORY_SECTIONS), distilled like any subject.

export const argsSchema = z.object({
  mode: z.enum(["plan", "apply", "rollback", "sample", "controls"]).default("plan"),
  runId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  v3Writes: z.unknown().optional(),
  memtax: z.string().optional(), // workflow input kill switch: "off" skips the lane
  generatedAt: z.string().optional(),
  budget: z.unknown().optional(), // gather.result.budget
  classifyPlan: z.unknown().optional(), // memtax-plan.result (B1)
  classify: z.unknown().optional(), // memtax-classify foreach aggregate (B1)
  plan: z.unknown().optional(), // memtax-create-plan.result (apply)
  distill: z.unknown().optional(), // memtax-distill foreach aggregate (apply)
  leadAgentId: z.string().optional(), // gather.result.leadAgentId: apply trusts only distill tasks this agent ran
  maxCreates: z.number().int().min(0).max(80).default(40),
  maxEdits: z.number().int().min(0).max(60).default(20),
  maxDeletes: z.number().int().min(0).max(20).default(5),
  maxClusters: z.number().int().min(0).max(40).default(12),
  clustersPerJob: z.number().int().min(1).max(12).default(6),
  memberChars: z.number().int().min(200).max(1500).default(900),
  sampleCount: z.number().int().min(0).max(100).default(20),
  // sample mode
  match: z.array(z.string()).optional(),
  batchSize: z.number().int().min(5).max(60).default(40),
  // rollback mode
  targetRunId: z.string().optional(),
  execute: z.boolean().default(false),
  // Seeded workflow: run from a Lead agent-task with args loaded from the run, or return that stored result.
  fromRun: z.boolean().optional(),
  loadResult: z.boolean().optional(),
  // apply: stop writing after this many ms (default 90 s). fromRun sets 20 s: a script-run started by an agent
  // has a 30 s wall clock, and a run killed mid-write would store no result.
  writeBudgetMs: z.number().int().min(1000).max(90000).optional(),
});

const NS = "dreaming-v2";
const MAX_DOC = 1950;
const TAGS = ["dreaming-v2", "longterm"]; // never "memtax": B1's read-only control counts memtax-tagged writes

// ---- path enum: byte-identical to dreaming-memtax (B1) PATH_RULES ----
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
// Agent and repo records are read as VALIDATE references under these internal paths. They are outside the enum
// (B1 rows that use them are rejected) and the server refuses them, so this lane never writes there.
export const NO_CREATE_ROOTS = ["/longterm/entities/agents", "/longterm/entities/repos"];
const REF_RULES = [new RegExp(`^/longterm/entities/agents/${SLUG}$`), new RegExp(`^/longterm/entities/repos/${SLUG}/[a-z0-9._-]{1,80}$`)];
export const refPath = (path: string) => REF_RULES.some((re) => re.test(path));
export const noCreate = (path: string) => NO_CREATE_ROOTS.some((r) => path === r || path.startsWith(`${r}/`));
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

// ---- end of the B1 copy ----

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
// foreach aggregate -> per item {key, status, taskId, out|null, error}. A [FAILED...] taskOutput is a failure.
export function parseForeach(agg: unknown): Array<{ key: string; status: string; taskId: string | null; out: any; error: string | null }> {
  const a: any = parse(agg);
  const results: any[] = Array.isArray(a?.results) ? a.results : [];
  return results.map((r: any) => {
    const key = String(r?.itemKey ?? "");
    const taskId = r?.output?.taskId ? String(r.output.taskId) : null;
    if (r?.status !== "completed") return { key, status: String(r?.status ?? "unknown"), taskId, out: null, error: String(r?.error ?? "not completed").slice(0, 200) };
    const raw = r?.output?.taskOutput;
    if (typeof raw === "string" && raw.startsWith("[FAILED")) return { key, status: "failed", taskId, out: null, error: raw.slice(0, 200) };
    const out = parse(raw);
    if (!out) return { key, status: "unparseable", taskId, out: null, error: "taskOutput is not JSON" };
    return { key, status: "completed", taskId, out, error: null };
  });
}
const rows = (r: any): any[] => {
  const d = r?.data ?? r;
  if (d?.error) throw new Error(String(d.error));
  if (!Array.isArray(d?.rows)) throw new Error("db_query returned no rows array (throttled?)");
  const c: string[] = d?.columns ?? [];
  return d.rows.map((x: any[]) => Object.fromEntries(c.map((k, i) => [k, x[i]])));
};
export const sha = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s ?? ""))))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export const kebab = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

// ---- deterministic entities ----
type Entity = { path: string; kind: "person" | "agent" | "repo"; table: "users" | "agents" | "swarm_repos"; sourceId: string; aliases: string[]; fields: Array<[string, string]> };
// People = active humans. Service/placeholder/bot users are skipped and listed, so a wrong skip is visible.
export function personSkip(u: any): string | null {
  if (String(u.status ?? "") !== "active") return `status ${u.status}`;
  const role = String(u.role ?? "").toLowerCase().trim();
  if (["editor", "viewer", "external", ""].includes(role)) return `service/placeholder role "${u.role ?? ""}"`;
  if (/\bbot\b/.test(role)) return `bot role "${u.role}"`;
  return null;
}
export function repoPath(url: string, name: string): string | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i.exec(String(url ?? "").trim());
  if (!m) return null;
  const p = `/longterm/entities/repos/${kebab(m[1]!)}/${m[2]!.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80) || kebab(name)}`;
  return refPath(p) ? p : null;
}
export function buildEntities(users: any[], agents: any[], repos: any[]): { entities: Entity[]; skipped: Array<{ table: string; id: string; name: string; why: string }> } {
  const entities: Entity[] = [];
  const skipped: Array<{ table: string; id: string; name: string; why: string }> = [];
  for (const u of users) {
    const why = personSkip(u);
    const slug = kebab(u.name);
    if (why || !slug) {
      skipped.push({ table: "users", id: String(u.id), name: String(u.name ?? ""), why: why ?? "no slug" });
      continue;
    }
    const ext = String(u.ext ?? "").split(",").filter(Boolean).sort();
    entities.push({
      path: `/longterm/entities/people/${slug}`,
      kind: "person",
      table: "users",
      sourceId: String(u.id),
      aliases: [...new Set([slug, String(u.name ?? "").toLowerCase(), String(u.name ?? "").split(/\s+/)[0]!.toLowerCase(), ...(u.email ? [String(u.email).toLowerCase()] : [])])].filter(Boolean),
      fields: [
        ["name", String(u.name ?? "")],
        ["email", String(u.email || "none")],
        ["role", String(u.role ?? "")],
        ["timezone", String(u.timezone || "unknown")],
        ["preferred channel", String(u.preferredChannel || "unknown")],
        ["linked accounts", ext.join(", ") || "none"],
        // Linked, never copied (operator 2026-10-06): the comms profile changes often and is injected per task already.
        ["comms profile", Number(u.hasComms) ? `users/${u.id} notes + metadata.comms (manage-user); not copied here` : "none"],
      ],
    });
  }
  for (const g of agents) {
    const slug = kebab(g.name);
    if (String(g.name ?? "").startsWith("ext:") || String(g.role ?? "") === "extension" || !slug) {
      skipped.push({ table: "agents", id: String(g.id), name: String(g.name ?? ""), why: "extension, not an agent" });
      continue;
    }
    entities.push({
      path: `/longterm/entities/agents/${slug}`,
      kind: "agent",
      table: "agents",
      sourceId: String(g.id),
      aliases: [...new Set([slug, String(g.name ?? "").toLowerCase(), String(g.id).slice(0, 8)])],
      fields: [
        ["name", String(g.name ?? "")],
        ["agent id", String(g.id)],
        ["role", String(g.role ?? "")],
        ["lead", Number(g.isLead) ? "yes" : "no"],
        ["harness", String(g.harness || "unknown")],
      ],
    });
  }
  for (const r of repos) {
    const p = repoPath(r.url, r.name);
    if (!p) {
      skipped.push({ table: "swarm_repos", id: String(r.id), name: String(r.name ?? ""), why: `url not github org/repo: ${r.url}` });
      continue;
    }
    const orgRepo = p.replace("/longterm/entities/repos/", "");
    entities.push({
      path: p,
      kind: "repo",
      table: "swarm_repos",
      sourceId: String(r.id),
      aliases: [...new Set([orgRepo, String(r.name ?? "").toLowerCase(), orgRepo.split("/")[1]!])],
      fields: [
        ["name", String(r.name ?? "")],
        ["url", String(r.url ?? "").replace(/\/+$/, "")],
        ["default branch", String(r.defaultBranch || "main")],
        ["clone path", String(r.clonePath || "none")],
        ["auto clone", Number(r.autoClone) ? "yes" : "no"],
      ],
    });
  }
  // Two records on one path (e.g. two users named alike): keep the first, report the rest.
  const seen = new Set<string>();
  const unique = entities.filter((e) => {
    if (seen.has(e.path)) {
      skipped.push({ table: e.table, id: e.sourceId, name: e.path, why: "path collision with an earlier record" });
      return false;
    }
    seen.add(e.path);
    return true;
  });
  return { entities: unique, skipped };
}
export async function recordSha(e: { table: string; sourceId: string; fields: Array<[string, string]> }): Promise<string> {
  return (await sha(JSON.stringify([e.table, e.sourceId, e.fields]))).slice(0, 12);
}

// ---- doc format (taxonomy §3.1). Header lines, then ## Record / ## Facts / ## Corrections / ## Sources. ----
export type Fact = { claim: string; stated: string; src: string[] };
export type Doc = { kind: string; path: string; aliases: string[]; source?: string; recSha?: string; checked?: string; stale?: string; record?: Array<[string, string]>; facts: Fact[]; corrections: string[]; sources: Array<{ id: string; name: string }>; distilledNote?: string };
const SRC_TABLE: Record<string, string> = { person: "users", agent: "agents", repo: "swarm_repos" };
export function factLine(f: Fact): string {
  return `- ${f.claim.replace(/\s+/g, " ").trim()} (stated ${f.stated}, src: ${f.src.join(", ")})`;
}
export function renderDoc(d: Doc): { content: string; omitted: number } {
  const head: string[] = [`type: ${d.kind === "person" || d.kind === "agent" || d.kind === "repo" ? `entity · kind: ${d.kind}` : d.kind} · path: ${d.path}`];
  if (d.aliases.length) head.push(`aliases: ${d.aliases.join(", ")}`);
  if (d.source) head.push(`source: ${d.source} (record-sha ${d.recSha}, checked ${d.checked})`);
  if (d.stale) head.push(`status: ${d.stale}`);
  if (d.distilledNote) head.push(d.distilledNote);
  const rec = d.record?.length ? ["", `## Record (lane-maintained from ${SRC_TABLE[d.kind] ?? "source"}; hand edits are overwritten)`, ...d.record.map(([k, v]) => `- ${k}: ${v}`)] : [];
  const corr = d.corrections.length ? ["", "## Corrections", ...d.corrections] : [];
  const srcLine = (s: { id: string; name: string }, named: boolean) => (named ? `- ${s.id}: ${s.name.replace(/\s+/g, " ").slice(0, 90)}` : `- ${s.id}`);
  // Newest facts first; drop the oldest until the doc fits one chunk.
  const facts = [...d.facts].sort((a, b) => (a.stated < b.stated ? 1 : a.stated > b.stated ? -1 : 0));
  const dropped: Fact[] = [];
  // Operator 2026-10-08: never point at ids that are not in the doc. Under budget pressure the Sources section keeps only
  // ids no visible line carries (fact lines and the omitted line already cite theirs); it is dropped when that is
  // none, never collapsed to a bare count. The omitted line lists the dropped facts' src ids inline, and parseDoc
  // reads them back so a re-render carries them forward.
  const build = (stage: number, uncitedCap = Infinity) => {
    const omitSrc = [...new Set(dropped.flatMap((f) => f.src))];
    const factBlock = facts.length ? ["", "## Facts", ...facts.map(factLine), ...(dropped.length ? [`- (+${dropped.length} older facts omitted to stay one chunk; src: ${omitSrc.join(", ")})`] : [])] : [];
    let src: string[] = [];
    if (stage === 0) src = d.sources.length ? ["", "## Sources", ...d.sources.map((s) => srcLine(s, true))] : [];
    else {
      const shown = new Set([...facts.flatMap((f) => f.src), ...omitSrc]);
      const rest = d.sources.filter((s) => !shown.has(s.id));
      const keep = rest.slice(Math.max(0, rest.length - uncitedCap));
      if (keep.length) src = ["", "## Sources (only ids not cited on a line above)", ...keep.map((s) => srcLine(s, stage < 2))];
    }
    return [...head, ...rec, ...factBlock, ...corr, ...src].join("\n").trim();
  };
  // Stage 0 is today's full render (byte-identical when it fits). 1: Sources keeps uncited ids only. 2: names
  // stripped. Then drop the oldest facts down to one, then the oldest uncited ids.
  let stage = 0;
  let out = build(stage);
  while (out.length > MAX_DOC && stage < 2) out = build(++stage);
  while (out.length > MAX_DOC && facts.length > 1) {
    dropped.unshift(facts.pop()!);
    out = build(stage);
  }
  for (let cap = d.sources.length - 1; out.length > MAX_DOC && cap >= 0; cap--) out = build(stage, cap);
  return { content: out.slice(0, MAX_DOC), omitted: dropped.length };
}
// The omitted-facts line renderDoc writes; parseDoc reads its src ids back into sources.
const OMITTED_RE = /^- \(\+(\d+) older facts omitted to stay one chunk; src: ([^)]*)\)$/;
// Parse a lane-written doc back into parts. Unknown docs parse to {facts: [], ...} with raw kept by the caller.
export function parseDoc(content: string): { source: { table: string; id: string; recSha: string } | null; stale: string | null; record: Array<[string, string]>; facts: Fact[]; corrections: string[]; sources: Array<{ id: string; name: string }>; aliases: string[] } {
  const lines = String(content ?? "").split("\n");
  const sm = /^source: (users|agents|swarm_repos)\/(\S+) \(record-sha ([0-9a-f]{12})/m.exec(content ?? "");
  const st = /^status: (.+)$/m.exec(content ?? "");
  const al = /^aliases: (.+)$/m.exec(content ?? "");
  const section = (title: string) => {
    const i = lines.findIndex((l) => l.startsWith(`## ${title}`));
    if (i < 0) return [] as string[];
    const out: string[] = [];
    for (let j = i + 1; j < lines.length && !lines[j]!.startsWith("## "); j++) if (lines[j]!.startsWith("- ")) out.push(lines[j]!);
    return out;
  };
  const facts: Fact[] = [];
  const omittedSrc: string[] = [];
  for (const l of section("Facts")) {
    const o = OMITTED_RE.exec(l);
    if (o) {
      omittedSrc.push(...o[2]!.split(",").map((x) => x.trim()).filter(Boolean));
      continue;
    }
    const m = /^- (.+) \(stated (\d{4}-\d{2}-\d{2}), src: ([^)]+)\)$/.exec(l);
    if (m) facts.push({ claim: m[1]!, stated: m[2]!, src: m[3]!.split(",").map((x) => x.trim()).filter(Boolean) });
  }
  const record = section("Record").map((l) => {
    const m = /^- ([^:]+): (.*)$/.exec(l);
    return (m ? [m[1], m[2]] : [l.slice(2), ""]) as [string, string];
  });
  const sources = section("Sources")
    .map((l) => /^- ([0-9a-f-]{8,64})(?::\s?(.*))?$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ id: m![1]!, name: m![2] ?? "" }));
  // Omitted facts' ids are sources the doc no longer shows a fact for: keep them so a re-render does not lose them.
  for (const id of omittedSrc) if (!sources.some((s) => s.id === id)) sources.push({ id, name: "" });
  return { source: sm ? { table: sm[1]!, id: sm[2]!, recSha: sm[3]! } : null, stale: st ? st[1]! : null, record, facts, corrections: section("Corrections"), sources, aliases: al ? al[1]!.split(",").map((x) => x.trim()).filter(Boolean) : [] };
}
// Operator 2026-10-08 invariant: no line points at something that is not in the doc. Returns the violations (empty = ok):
// a Sources section that is only "(+N more sources)", any "(+N more sources)" count, a "see sources" pointer, and an
// omitted-facts line that does not list its src ids.
const MORE_SOURCES_RE = /^- \(\+\d+ more sources\)\s*$/;
export function docInvariant(content: string): string[] {
  const lines = String(content ?? "").split("\n");
  const v: string[] = [];
  const i = lines.findIndex((l) => l.startsWith("## Sources"));
  if (i >= 0) {
    const bullets: string[] = [];
    for (let j = i + 1; j < lines.length && !lines[j]!.startsWith("## "); j++) if (lines[j]!.startsWith("- ")) bullets.push(lines[j]!);
    if (bullets.length > 0 && bullets.every((l) => MORE_SOURCES_RE.test(l))) v.push("bare-more-sources");
  }
  if (!v.length && lines.some((l) => MORE_SOURCES_RE.test(l))) v.push("more-sources-count");
  if (/see sources/i.test(content ?? "")) v.push("see-sources");
  for (const l of lines) {
    if (!/older facts omitted/.test(l)) continue;
    const o = OMITTED_RE.exec(l);
    if (!o || !o[2]!.split(",").some((x) => /^[0-9a-f-]{8,64}$/.test(x.trim()))) {
      v.push("omitted-without-src");
      break;
    }
  }
  return v;
}
// apply's pre-write gate: every create/edit whose rendered doc breaks the invariant, with why. The caller skips the
// write and keeps the existing row; it never fails the lane.
export function invariantGate<T extends { op: string; content?: string }>(props: T[]): Map<T, string> {
  const out = new Map<T, string>();
  for (const x of props) {
    if (x.op === "delete" || typeof x.content !== "string") continue;
    const v = docInvariant(x.content);
    if (v.length) out.set(x, `invariant: ${v.join(", ")}`);
  }
  return out;
}
const claimKey = (f: Fact) => f.claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
// One bullet per claim: the same claim from another source unions its src and keeps the first stated date.
export function mergeFacts(a: Fact[], b: Fact[]): Fact[] {
  const m = new Map<string, Fact>();
  for (const f of [...a, ...b]) {
    const k = claimKey(f);
    const o = m.get(k);
    if (!o) m.set(k, { ...f, src: [...f.src] });
    else m.set(k, { claim: o.claim, stated: o.stated <= f.stated ? o.stated : f.stated, src: [...new Set([...o.src, ...f.src])] });
  }
  return [...m.values()];
}
// Subject-doc rewrite (taxonomy v5): the distiller returns the doc's complete new bullet list. Accept it unless it
// silently loses evidence: a current bullet is dropped when no new bullet keeps its claim or any of its sources. More
// than max(2, a third of the current bullets) dropped -> refuse; the caller falls back to merge (append + dedupe).
export function rewriteFacts(current: Fact[], next: Fact[]): { ok: boolean; facts: Fact[]; dropped: number; maxDrop: number } {
  const facts = mergeFacts([], next);
  const keys = new Set(facts.map(claimKey));
  const srcs = new Set(facts.flatMap((f) => f.src));
  const dropped = current.filter((f) => !keys.has(claimKey(f)) && !f.src.some((x) => srcs.has(x))).length;
  const maxDrop = Math.max(2, Math.floor(current.length / 3));
  return { ok: facts.length > 0 && dropped <= maxDrop, facts, dropped, maxDrop };
}

// ---- validate (pure) ----
export type Verdict = "ok" | "ok-unsourced" | "stale" | "drift" | "duplicate" | "bad-path" | "multi-chunk" | "misfiled";
// A people/customers path whose slug names an agent or repo record: that subject lives in its profile / get-repos.
export function agentOrRepoMatch(path: string, live: Map<string, { e: Entity; recSha: string } | { gone: string }>): string | null {
  const root = pathRoot(path);
  if (root !== "/longterm/entities/people" && root !== "/longterm/entities/customers") return null;
  const slug = path.split("/").pop() ?? "";
  for (const l of live.values()) {
    if ("gone" in l || (l.e.kind !== "agent" && l.e.kind !== "repo")) continue;
    if (l.e.aliases.some((x) => kebab(x) === slug)) return `${l.e.table}/${l.e.sourceId}`;
  }
  return null;
}
export function validateDoc(doc: { id: string; name: string; totalChunks: number; content: string }, live: Map<string, { e: Entity; recSha: string } | { gone: string }>, dupCanonical: Map<string, string>): { verdict: Verdict; why: string } {
  if (!pathRoot(doc.name) || doc.name.startsWith("/inbox")) return { verdict: "bad-path", why: "name is not a /longterm path in the enum" };
  const canon = dupCanonical.get(doc.name);
  if (canon && canon !== doc.id) return { verdict: "duplicate", why: `same name as ${canon}` };
  if (Number(doc.totalChunks) > 1) return { verdict: "multi-chunk", why: `${doc.totalChunks} chunks: memory-edit refuses it, rewrite by hand` };
  const p = parseDoc(doc.content);
  // users-backed people docs are real humans; only hand-written or distilled people/customers docs can be misfiled.
  const mis = p.source?.table === "users" ? null : agentOrRepoMatch(doc.name, live);
  if (mis) return { verdict: "misfiled", why: `names ${mis}; agent profiles and get-repos are the source of truth` };
  if (!p.source) return { verdict: doc.name.startsWith("/longterm/entities/") ? "ok-unsourced" : "ok", why: doc.name.startsWith("/longterm/entities/") ? "entity with no source table (customers/services or hand-written)" : "" };
  const l = live.get(`${p.source.table}/${p.source.id}`);
  if (!l || "gone" in l) return { verdict: "stale", why: l && "gone" in l ? l.gone : `no live ${p.source.table} row ${p.source.id}` };
  if (l.e.path !== doc.name) return { verdict: "stale", why: `record now maps to ${l.e.path}` };
  if (l.recSha !== p.source.recSha) return { verdict: "drift", why: `record-sha ${p.source.recSha} -> ${l.recSha}` };
  return { verdict: "ok", why: "" };
}

// ---- distill output (pure) ----
export function validateDistill(out: any, jobClusters: Map<string, { path: string; memberIds: Set<string>; currentSrc?: Set<string> }>): { ok: Map<string, { aliases: string[]; facts: Fact[]; rewrite: boolean }>; rejected: Record<string, number>; howto: Set<string>; episodic: Set<string> } {
  const ok = new Map<string, { aliases: string[]; facts: Fact[]; rewrite: boolean }>();
  const rejected: Record<string, number> = {};
  const howto = new Set<string>(); // clusters the distiller flagged as how-to: no doc, handed to the skills lanes
  const episodic = new Set<string>(); // clusters the distiller flagged as episodic (bug, incident, fix): no doc, inbox
  const bump = (k: string) => (rejected[k] = (rejected[k] ?? 0) + 1);
  for (const c of Array.isArray(out?.clusters) ? out.clusters : []) {
    const cl = jobClusters.get(String(c?.clusterId ?? ""));
    if (!cl) {
      bump("unknown-cluster");
      continue;
    }
    if (c?.howto === true) {
      howto.add(String(c.clusterId));
      continue;
    }
    if (c?.episodic === true) {
      episodic.add(String(c.clusterId));
      continue;
    }
    // A rewrite may keep the sources already on the doc's current bullets; anything else must be a member.
    const rewrite = c?.rewrite === true && !!cl.currentSrc;
    const facts: Fact[] = [];
    for (const b of Array.isArray(c?.bullets) ? c.bullets.slice(0, 12) : []) {
      const claim = String(b?.claim ?? "").replace(/\s+/g, " ").trim();
      const stated = String(b?.stated ?? "");
      const src = (Array.isArray(b?.src) ? b.src.map(String) : []).filter((x: string) => cl.memberIds.has(x) || (rewrite && cl.currentSrc!.has(x))).slice(0, 3);
      if (claim.length < 10 || claim.length > 240 || /\(stated |src:/.test(claim)) bump("bad-claim");
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(stated)) bump("bad-date");
      else if (!src.length) bump("src-not-a-member");
      else facts.push({ claim, stated, src });
    }
    if (!facts.length) {
      bump("no-valid-bullets");
      continue;
    }
    const aliases = (Array.isArray(c?.aliases) ? c.aliases.map((x: any) => String(x).toLowerCase().replace(/[,\n]/g, " ").trim()) : []).filter((x: string) => x && x.length <= 40).slice(0, 6);
    ok.set(String(c.clusterId), { aliases, facts, rewrite });
  }
  return { ok, rejected, howto, episodic };
}

// ---- skill routing (operator 2026-10-06: recall only; if it can be a skill or script, it should be one) ----
// /longterm holds recall only: decisions, people, customers, workstreams, timeline, company story. A cluster that is
// service/procedure how-to, or a fact whose subject an existing skill covers, is NOT written to /longterm: it becomes a
// skill-update / skill-new (+ script hint) proposal in the report and KV memtax-create:skill-routes:<runId>.
export const HOWTO_ROOTS = ["/howto", "/longterm/facts/procedures", "/longterm/facts/services"];
const RECALL_ROOT_RE = /^\/longterm\/(decisions|entities|workstreams|timeline|company-story)(\/|$)/;
const GENERIC = new Set(["agent", "agents", "swarm", "desplega", "labs", "code", "data", "info", "interaction", "analytics", "api", "cli", "ops", "use", "the", "and", "for", "how", "report", "reports", "review", "skill", "skills", "test", "tests", "testing", "workflow", "workflows", "task", "tasks", "memory", "script", "scripts", "page", "pages", "bug", "fix", "rules", "setup", "usage", "format", "pattern", "patterns", "notes", "check", "new", "via", "with"]);
const toks = (s: string) => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3 && !GENERIC.has(x));
export type SkillRow = { name: string; description?: string | null };
export type Route = { route: "memory" | "skill-update" | "skill-new" | "inbox"; skill: string | null; score: number; why: string };
export function scoreSkill(slug: string, s: SkillRow): number {
  const n = String(s.name ?? "").toLowerCase();
  const d = ` ${String(s.description ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const st = toks(slug);
  const nt = toks(n);
  let score = 0;
  if (n === slug || n.startsWith(`${slug}-`) || slug.startsWith(`${n}-`)) score += 3;
  if (st.length && nt.length && st[0] === nt[0]) score += 2;
  const phrase = slug.replace(/-/g, " ");
  if ((slug.includes("-") || (st.length === 1 && st[0]!.length >= 5)) && d.includes(` ${phrase} `)) score += 2;
  score += st.filter((x) => nt.includes(x)).length;
  score += 0.5 * st.filter((x) => d.includes(` ${x}`)).length; // word-prefix: "comment" matches "comments"
  return score;
}
// Tie-break only: distinctive words of the members' own text that the skill description carries, length-normalised.
export function textAffinity(texts: string[], s: SkillRow): number {
  const d = ` ${String(s.description ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const words = new Set(toks(texts.join(" ")).filter((x) => x.length >= 4));
  let n = 0;
  for (const w of words) if (d.includes(` ${w}`)) n++;
  return n / Math.sqrt(Math.max(1, d.split(" ").length)); // long catch-all descriptions must not win on volume
}
const HOWTO_TEXT = /\b(install|curl|endpoint|cli|command|flag|header|api key|token|config|workaround|instead|never|always|must|GET|POST)\b/gi;
const RECALL_TEXT = /\b(competitor|competitive|founded|funding|launched|stars|customer|pricing|revenue|acquired|valuation)\b/gi;
export function routeCluster(path: string, skills: SkillRow[], texts: string[] = []): Route {
  if (RECALL_ROOT_RE.test(path)) return { route: "memory", skill: null, score: 0, why: "recall root" };
  let howto = HOWTO_ROOTS.some((r) => path.startsWith(`${r}/`));
  const blob = texts.join("\n");
  // A how-to path can still hold recall (a competitor profile): more market words than how-to words. It has no
  // /longterm home on that path, so it stays in the inbox for B1 to re-file (company-story, customers), never written.
  const recallish = howto && (blob.match(RECALL_TEXT)?.length ?? 0) > (blob.match(HOWTO_TEXT)?.length ?? 0);
  if (recallish) return { route: "inbox", skill: null, score: 0, why: "how-to path but recall content (market/competitor): left in inbox for B1" };
  const slug = path.split("/").pop() ?? "";
  let best: SkillRow | null = null;
  let top = 0;
  let aff = -1;
  for (const s of skills) {
    const v = scoreSkill(slug, s);
    if (v < top || v === 0) continue;
    const f = textAffinity(texts, s);
    if (v > top || f > aff || (f === aff && best && s.name < best.name)) [best, top, aff] = [s, v, f];
  }
  // A strong subject match is a prefix relation, a shared head token, or the slug as a phrase in the description.
  if (best && top >= 2) return { route: "skill-update", skill: best.name, score: top, why: howto ? "how-to; existing skill covers the subject" : "existing skill covers the subject" };
  if (howto) return { route: "skill-new", skill: null, score: top, why: "service/procedure how-to with no covering skill" };
  return { route: "memory", skill: null, score: top, why: "fact, no covering skill" };
}
// Existing script first: a global script whose name/description covers the subject is wired into the skill, not rebuilt.
export function scriptFor(slug: string, scripts: SkillRow[]): string | null {
  let best: string | null = null;
  let top = 0;
  for (const x of scripts) {
    const v = scoreSkill(slug, x);
    if (v > top || (v === top && best && x.name < best)) [best, top] = [x.name, v];
  }
  return top >= 3 ? best : null;
}
// The handoff row synthesize reads (lane + op it should propose). Existing skill or script first.
export function handoffRow(path: string, r: Route, texts: string[], scripts: SkillRow[], memberIds: string[]) {
  const slug = path.split("/").pop() ?? "";
  const scriptExisting = scriptFor(slug, scripts);
  const scriptCandidate = !scriptExisting && scriptHint(texts);
  return {
    path,
    slug,
    route: r.route,
    skill: r.skill,
    lane: r.route === "skill-update" ? "skill-refactor" : "skillify",
    op: r.route === "skill-update" ? "skill-update" : "skill-create",
    scriptExisting,
    script: scriptCandidate,
    scriptLane: scriptExisting || scriptCandidate ? "scriptify" : null,
    score: r.score,
    why: r.why,
    memberIds,
  };
}
export const scriptHint = (texts: string[]) => texts.some((t) => /\b(GET|POST|PUT|PATCH|DELETE) \/|\bcurl\b|\bendpoint\b|https?:\/\/[^\s]*\/(v\d|api)\b|x-api-key|Bearer\b/i.test(String(t ?? "")));

const KIND_OF_ROOT = (root: string) =>
  root.startsWith("/longterm/entities") ? "entity" : root === "/howto" ? "procedure" : root.startsWith("/longterm/facts") ? "fact" : root.startsWith("/longterm/decisions") ? "decision" : root.startsWith("/longterm/workstreams") ? "workstream" : root.startsWith("/longterm/timeline") ? "timeline" : "story";
const esc = (s: string, n: number) => String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, n);
const tok = (chars: number) => Math.ceil(chars / 4);

async function runScript(args: unknown, ctx: ScriptContext) {
  const p = argsSchema.safeParse(args ?? {});
  if (!p.success) return { ok: false, mode: "invalid-args", errors: [p.error.message.slice(0, 400)], jobs: [], markdown: "" };
  const a = p.data;
  const dry = a.dryRun === true || a.dryRun === "true" || a.dryRun === undefined || a.dryRun === "";
  const writesOn = !dry && (a.v3Writes === true || a.v3Writes === "true" || a.v3Writes === "on");
  const runId = a.runId ?? "";
  const errors: string[] = [];
  const today = (a.generatedAt && !Number.isNaN(Date.parse(a.generatedAt)) ? new Date(a.generatedAt) : new Date()).toISOString().slice(0, 10);
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
    if (a.mode === "apply") return await apply();
    if (a.mode === "rollback") return await rollback();
    if (a.mode === "sample") return await sample();
    return await controls();
  } catch (e: any) {
    return { ok: false, mode: a.mode, jobs: [], markdown: "## Long-term memories (lane B, create/validate/tidy)\nSkipped: script error. No other lane is affected.", errors: [...errors, String(e?.message ?? e).slice(0, 300)] };
  }

  async function loadSources() {
    const users = await q("users", `SELECT u.id, u.name, u.email, u.role, u.status, u.timezone, u.preferredChannel, (CASE WHEN json_extract(CASE WHEN json_valid(u.metadata) THEN u.metadata END, '$.comms') IS NOT NULL OR length(coalesce(u.notes, '')) > 0 THEN 1 ELSE 0 END) hasComms, (SELECT group_concat(DISTINCT e.kind) FROM user_external_ids e WHERE e.userId = u.id) ext FROM users u`);
    const agents = await q("agents", `SELECT id, name, role, isLead, coalesce(harness_provider, provider) harness FROM agents`);
    const repos = await q("repos", `SELECT id, name, url, defaultBranch, clonePath, autoClone FROM swarm_repos`);
    const { entities, skipped } = buildEntities(users, agents, repos);
    const live = new Map<string, { e: Entity; recSha: string } | { gone: string }>();
    for (const e of entities) live.set(`${e.table}/${e.sourceId}`, { e, recSha: await recordSha(e) });
    for (const s of skipped) if (!live.has(`${s.table}/${s.id}`)) live.set(`${s.table}/${s.id}`, { gone: `${s.table} row ${s.id} is ${s.why}` });
    return { entities, skipped, live, sourceCounts: { users: users.length, agents: agents.length, repos: repos.length } };
  }
  async function loadLongterm() {
    return await q(
      "longterm",
      `SELECT id, name, agentId, scope, totalChunks, contentHash, createdAt, updatedAt, version, substr(content, 1, 4000) content FROM agent_memory
       WHERE chunkIndex = 0 AND name GLOB '/longterm/*' ORDER BY name, createdAt, id LIMIT 1000`,
    );
  }

  async function plan() {
    if (String(a.memtax ?? "").toLowerCase() === "off") return skip("disabled (workflow input memtax=off)");
    // controls() is pure (no ctx calls, only in-memory fixtures and crypto.subtle) and runs in ms: a failing control
    // means the renderer/validators are broken, so lane B skips tonight rather than write with them.
    const ctl = await controls();
    if (!ctl.ok) return { ...skip(`controls failed ${ctl.passed}/${ctl.total}: ${ctl.failed.map((c) => c.name).join("; ")}`.slice(0, 1500)), controls: { passed: ctl.passed, total: ctl.total, failed: ctl.failed.map((c) => c.name) } };
    const budget: any = parse(a.budget) ?? {};
    const overCap = Number(budget?.prevRunUsd) > Number(budget?.cap ?? 25);
    const { entities, skipped, live, sourceCounts } = await loadSources();
    const existing = await loadLongterm();
    const existingCount = (await q("longterm-count", `SELECT COUNT(*) n FROM agent_memory WHERE name GLOB '/longterm/*'`))[0]?.n ?? null;
    // Validate existing docs.
    const byName = new Map<string, any[]>();
    for (const d of existing) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
    const dupCanonical = new Map<string, string>();
    for (const [n, ds] of byName) if (ds.length > 1) dupCanonical.set(n, ds[0].id); // oldest wins (ORDER BY createdAt, id)
    const verdicts = existing.map((d) => ({ id: d.id, name: d.name, ...validateDoc(d, live, dupCanonical), invariant: docInvariant(d.content) }));
    const invariantViolations = verdicts.filter((v) => v.invariant.length).map((v) => ({ id: v.id, name: v.name, violations: v.invariant }));
    // Deterministic creates: every entity whose path has no doc yet.
    const entityCreates = entities.filter((e) => !byName.has(e.path) && !noCreate(e.path));
    // Alias map for B1 entity targets (classifier says people/ada; the record path may differ).
    const alias = new Map<string, string>();
    for (const e of entities) {
      const root = e.path.split("/").slice(0, 4).join("/");
      for (const x of e.aliases) alias.set(`${root}/${kebab(x)}`, e.path);
      alias.set(e.path, e.path);
      if (e.kind === "repo") alias.set(`${root}/${e.aliases[0]}`, e.path);
    }
    // B1 clusters.
    const cp: any = parse(a.classifyPlan) ?? {};
    const meta = new Map<string, any>();
    for (const b of Array.isArray(cp.batches) ? cp.batches : []) for (const d of b?.docs ?? []) meta.set(String(d.id), d);
    const ids = new Set(meta.keys());
    const groups = new Map<string, any[]>();
    const howtoGroups = new Map<string, any[]>();
    const clusterStats = { classified: 0, inbox: 0, deleteAction: 0, deferredRoots: 0, failedBatches: 0, rejected: 0, noCreateRoot: 0, misfiled: 0, howto: 0, howtoRemapped: 0, episodic: 0, selfMember: 0 };
    for (const x of parseForeach(a.classify)) {
      if (x.status !== "completed") {
        clusterStats.failedBatches++;
        continue;
      }
      for (const c of Array.isArray(x.out?.classifications) ? x.out.classifications : []) {
        const v = validateClassification(c, ids);
        if (!v.ok) {
          clusterStats.rejected++;
          continue;
        }
        clusterStats.classified++;
        const r = v.row;
        let target: string = r.mergeTarget ?? r.path;
        if (r.refiled === "howto") clusterStats.howtoRemapped++;
        if (r.refiled === "episodic") clusterStats.episodic++;
        if (r.action === "delete") clusterStats.deleteAction++;
        else if (pathRoot(target) === "/inbox") clusterStats.inbox++;
        else if (pathRoot(target) === "/howto") {
          clusterStats.howto++;
          howtoGroups.set(target, [...(howtoGroups.get(target) ?? []), { id: r.id, reason: r.reason }]);
        }
        else if (target.startsWith("/longterm/timeline/")) clusterStats.deferredRoots++; // timeline is built from the window, not distilled
        else {
          target = alias.get(target) ?? target;
          if (noCreate(target)) {
            clusterStats.noCreateRoot++;
            continue;
          }
          if (!byName.has(target) && !entities.some((e) => e.kind === "person" && e.path === target) && agentOrRepoMatch(target, live)) {
            clusterStats.misfiled++;
            continue;
          }
          // The subject doc itself is not evidence for its own rewrite (it arrives as `current`).
          if (byName.get(target)?.some((d: any) => d.id === r.id)) {
            clusterStats.selfMember++;
            continue;
          }
          groups.set(target, [...(groups.get(target) ?? []), { id: r.id, reason: r.reason }]);
        }
      }
    }
    const entityPaths = new Set(entities.filter((e) => !noCreate(e.path)).map((e) => e.path));
    const allClusters = [...groups.entries()]
      .map(([path, ms]) => ({ path, root: pathRoot(path)!, members: ms, attach: entityPaths.has(path) || byName.has(path) }))
      .filter((c) => c.members.length >= 2 || c.attach)
      .sort((x, y) => y.members.length - x.members.length || (x.path < y.path ? -1 : 1));
    // Skill routing: how-to clusters leave lane B before distill, so they never reach /longterm or use a cluster slot.
    const skillRows = (await q("skills", `SELECT name, description FROM skills WHERE isEnabled = 1 ORDER BY name`)) as SkillRow[];
    const scriptRows = (await q("scripts", `SELECT name, description FROM scripts WHERE scope = 'global' AND isScratch = 0 ORDER BY name`)) as SkillRow[];
    const skillRoutes: any[] = [];
    const recallLeft: any[] = [];
    const textsOf = (ms: any[]) => ms.map((m: any) => `${String(meta.get(m.id)?.name ?? "")}\n${String(meta.get(m.id)?.text ?? "")}`);
    // Every /howto group routes, singletons included: a skill-update needs one source; synthesize applies the 2+ rule
    // to skill-create.
    for (const [path, ms] of howtoGroups) {
      const texts = textsOf(ms);
      const r = routeCluster(path, skillRows, texts);
      if (r.route === "inbox" || r.route === "memory") recallLeft.push({ path, why: r.why, memberIds: ms.map((m: any) => m.id) });
      else skillRoutes.push(handoffRow(path, r, texts, scriptRows, ms.map((m: any) => m.id)));
    }
    const clusters = allClusters.filter((c) => {
      if (entityPaths.has(c.path)) return true;
      const texts = textsOf(c.members);
      const r = routeCluster(c.path, skillRows, texts);
      if (r.route === "memory") return true;
      if (r.route === "inbox") recallLeft.push({ path: c.path, why: r.why, memberIds: c.members.map((m: any) => m.id) });
      else skillRoutes.push({ ...handoffRow(c.path, r, texts, scriptRows, c.members.map((m: any) => m.id)), existingDoc: byName.get(c.path)?.[0]?.id ?? null });
      return false;
    });
    const singletons = [...groups.values()].filter((ms) => ms.length === 1).length - clusters.filter((c) => c.members.length === 1).length;
    const distillOn = !overCap && a.maxClusters > 0;
    const picked = distillOn ? clusters.slice(0, a.maxClusters) : [];
    const jobs: any[] = [];
    for (let i = 0; i < picked.length; i += a.clustersPerJob) {
      const slice = picked.slice(i, i + a.clustersPerJob);
      jobs.push({
        jobId: `${today}-distill-${jobs.length + 1}`,
        clusters: slice.map((c, j) => ({
          clusterId: `c${i + j + 1}`,
          path: c.path,
          kind: KIND_OF_ROOT(c.root),
          existing: entityPaths.has(c.path) ? "lane entity record (people)" : byName.has(c.path) ? "existing /longterm doc" : "new doc",
          // Subject docs are rewritten, not appended to: the distiller gets the current bullets and returns the full list.
          ...(byName.has(c.path) ? { current: parseDoc(byName.get(c.path)![0].content).facts } : {}),
          members: c.members.map((m: any) => {
            const d = meta.get(m.id) ?? {};
            return { id: m.id, name: String(d.name ?? "").slice(0, 160), created: String(d.created ?? ""), text: String(d.text ?? "").slice(0, a.memberChars) };
          }),
        })),
      });
    }
    // Tidy ops inside /longterm only.
    const tidy: any[] = [];
    for (const v of verdicts) {
      if (v.verdict === "duplicate") tidy.push({ op: "merge-duplicate", id: v.id, name: v.name, into: dupCanonical.get(v.name) });
      else if (v.verdict === "drift") tidy.push({ op: "refresh", id: v.id, name: v.name });
      else if (v.verdict === "stale") tidy.push({ op: "flag-stale", id: v.id, name: v.name, why: v.why });
    }
    const count = (xs: any[], k: string) => xs.reduce((m: Record<string, number>, x) => ((m[x[k]] = (m[x[k]] ?? 0) + 1), m), {});
    return {
      ok: errors.length === 0,
      mode: "plan",
      dryRun: dry,
      writesOn,
      runId,
      today,
      skipReason: null,
      longtermRowsBefore: existingCount === null ? null : Number(existingCount),
      sourceCounts,
      entities: entities.map((e) => ({ ...e })),
      entityCreates: entityCreates.map((e) => e.path),
      referenceOnly: entities.filter((e) => noCreate(e.path)).length, // agents + repos: read for VALIDATE, never created
      skipped,
      existing: existing.map((d) => ({ id: d.id, name: d.name, totalChunks: d.totalChunks, contentHash: d.contentHash, version: d.version })),
      verdicts,
      verdictCounts: count(verdicts, "verdict"),
      invariantViolations,
      controls: { passed: ctl.passed, total: ctl.total, failed: [] as string[] },
      clusters: picked.map((c, i) => ({ clusterId: `c${i + 1}`, path: c.path, memberIds: c.members.map((m: any) => m.id), attach: c.attach, currentSrc: byName.has(c.path) ? [...new Set(parseDoc(byName.get(c.path)![0].content).facts.flatMap((f) => f.src))] : null })),
      clustersDropped: clusters.length - picked.length,
      skillRoutes,
      recallLeft,
      skillCatalog: skillRows.length,
      scriptCatalog: scriptRows.length,
      clusterStats: { ...clusterStats, singletonsLeftForB2: singletons, overCap, routedToSkills: skillRoutes.length },
      jobs,
      tidy,
      memberNames: Object.fromEntries([...meta.entries()].map(([id, d]) => [id, String(d.name ?? "").slice(0, 120)])),
      errors,
    };
  }
  function skip(reason: string) {
    return { ok: true, mode: a.mode, dryRun: dry, writesOn, runId, skipReason: reason, jobs: [], entities: [], tidy: [], verdicts: [], markdown: `## Long-term memories (lane B, create/validate/tidy)\nSkipped: ${reason}. Nothing written; no other lane is affected.`, counts: {}, writes: [], errors };
  }

  async function apply() {
    const pl: any = parse(a.plan) ?? {};
    if (pl.skipReason || !Array.isArray(pl.entities)) return skip(String(pl.skipReason ?? (a.plan ? "plan returned nothing" : "memtax-create-plan did not run")));
    const runDry = pl.dryRun === true || dry;
    const live = !runDry && writesOn && pl.writesOn !== false;
    // Re-read sources and /longterm now: the plan is minutes old and Lead may have edited a doc since.
    const src = await loadSources();
    const existing = await loadLongterm();
    const byName = new Map<string, any[]>();
    for (const d of existing) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
    const memberNames: Record<string, string> = pl.memberNames ?? {};
    const skillRoutes: any[] = Array.isArray(pl.skillRoutes) ? [...pl.skillRoutes] : [];
    const routedPaths = new Set<string>(skillRoutes.map((r) => String(r.path)));
    // Distill results.
    const clusterIndex = new Map<string, { path: string; memberIds: Set<string>; currentSrc?: Set<string> }>();
    for (const c of pl.clusters ?? []) clusterIndex.set(String(c.clusterId), { path: String(c.path), memberIds: new Set((c.memberIds ?? []).map(String)), ...(Array.isArray(c.currentSrc) ? { currentSrc: new Set(c.currentSrc.map(String)) } : {}) });
    const distilled = new Map<string, { aliases: string[]; facts: Fact[]; rewrite: boolean }>();
    const episodicClusters: string[] = [];
    const distillRejected: Record<string, number> = {};
    const failedJobs: any[] = [];
    const flaggedHowto: string[] = [];
    // Distilled bullets become /longterm text written with Lead authority, and a valid source id says nothing about
    // the claim. Only a distill task the Lead ran is trusted; a task anyone else ran (a pool worker) is refused.
    const distillRuns = parseForeach(a.distill);
    const leadId = String(a.leadAgentId ?? "").trim();
    const taskIds = [...new Set(distillRuns.map((x) => x.taskId).filter((x): x is string => !!x))];
    const authors = new Map<string, string>();
    if (leadId && taskIds.length) for (const r of await q("distill-authors", `SELECT id, agentId FROM agent_tasks WHERE id IN (${taskIds.map(() => "?").join(", ")})`, taskIds)) authors.set(String(r.id), String(r.agentId ?? ""));
    for (const x of distillRuns) {
      if (x.status !== "completed") {
        failedJobs.push({ jobId: x.key, status: x.status, error: x.error });
        continue;
      }
      if (!leadId || !x.taskId || authors.get(x.taskId) !== leadId) {
        failedJobs.push({ jobId: x.key, status: "untrusted-author", error: !leadId ? "no leadAgentId to check the distill task against" : `distill task ${x.taskId ?? "(none)"} was not run by the lead` });
        continue;
      }
      const v = validateDistill(x.out, clusterIndex);
      for (const [k, n] of Object.entries(v.rejected)) distillRejected[k] = (distillRejected[k] ?? 0) + n;
      for (const [cid, d] of v.ok) distilled.set(clusterIndex.get(cid)!.path, d);
      for (const cid of v.howto) flaggedHowto.push(cid);
      for (const cid of v.episodic) episodicClusters.push(clusterIndex.get(cid)!.path);
    }
    // Distiller said "this cluster is how-to": no /longterm doc; route it like a B1 /howto group.
    if (flaggedHowto.length) {
      const skillRows = (await q("skills", `SELECT name, description FROM skills WHERE isEnabled = 1 ORDER BY name`)) as SkillRow[];
      const scriptRows = (await q("scripts", `SELECT name, description FROM scripts WHERE scope = 'global' AND isScratch = 0 ORDER BY name`)) as SkillRow[];
      for (const cid of flaggedHowto) {
        const cl = clusterIndex.get(cid)!;
        const hp = `/howto/${cl.path.split("/").pop()}`;
        if (skillRoutes.some((r) => r.path === hp)) continue;
        const ids = [...cl.memberIds];
        const texts = ids.map((id) => memberNames[id] ?? "");
        const r = routeCluster(hp, skillRows, texts);
        if (r.route === "skill-update" || r.route === "skill-new") skillRoutes.push({ ...handoffRow(hp, r, texts, scriptRows, ids), from: cl.path, flaggedBy: "distill" });
      }
    }
    // Compose proposals.
    type Prop = { op: "create" | "edit" | "delete"; why: string; name: string; id?: string; content?: string; beforeContent?: string; beforeSha?: string; sources: string[]; verdict: string; kind: string; omitted?: number };
    const props: Prop[] = [];
    const entityByPath = new Map(src.entities.map((e) => [e.path, e]));
    const touched = new Set<string>();
    for (const e of src.entities) {
      if (noCreate(e.path)) continue; // agents/repos: reference records only
      // Distilled aliases are not trusted on record-backed entities (dry run: an LLM alias "lead" on a person).
      const d = distilled.get(e.path);
      const rs = (src.live.get(`${e.table}/${e.sourceId}`) as any).recSha;
      const have = byName.get(e.path);
      if (!have) {
        const r = renderDoc({ kind: e.kind, path: e.path, aliases: e.aliases.slice(0, 8), source: `${e.table}/${e.sourceId}`, recSha: rs, checked: today, record: e.fields, facts: d?.facts ?? [], corrections: [], sources: d ? [...new Set(d.facts.flatMap((f) => f.src))].map((id) => ({ id, name: memberNames[id] ?? "" })) : [] });
        props.push({ op: "create", why: d ? "entity record + distilled facts" : "entity record", name: e.path, content: r.content, sources: [`${e.table}/${e.sourceId}`, ...(d ? [...new Set(d.facts.flatMap((f) => f.src))] : [])], verdict: "ok", kind: e.kind, omitted: r.omitted });
        touched.add(e.path);
      }
    }
    // Existing docs: validate, then refresh / flag stale / merge duplicates / append distilled facts.
    const dupCanonical = new Map<string, string>();
    for (const [n, ds] of byName) if (ds.length > 1) dupCanonical.set(n, ds[0].id);
    const verdicts: any[] = [];
    const rewrites = { done: 0, fallback: 0, dropped: 0 };
    for (const doc of existing) {
      const v = validateDoc(doc, src.live, dupCanonical);
      verdicts.push({ id: doc.id, name: doc.name, ...v, invariant: docInvariant(doc.content) });
      const pd = parseDoc(doc.content);
      if (v.verdict === "duplicate") {
        props.push({ op: "delete", why: `duplicate of ${v.why.replace("same name as ", "")}; its facts merge into the canonical doc`, name: doc.name, id: doc.id, beforeContent: doc.content, beforeSha: doc.contentHash, sources: [doc.id], verdict: "duplicate", kind: "dup" });
        continue;
      }
      if (v.verdict === "bad-path" || v.verdict === "multi-chunk" || v.verdict === "misfiled" || touched.has(doc.name)) continue;
      const e = entityByPath.get(doc.name);
      const dups = (byName.get(doc.name) ?? []).slice(1).map((x) => parseDoc(x.content).facts);
      const d = routedPaths.has(doc.name) ? undefined : distilled.get(doc.name);
      let facts = pd.facts;
      for (const f of dups) facts = mergeFacts(facts, f);
      let rewritten = false;
      if (d?.rewrite) {
        const rw = rewriteFacts(facts, d.facts);
        if (rw.ok) {
          facts = rw.facts;
          rewritten = true;
          rewrites.dropped += rw.dropped;
        } else {
          facts = mergeFacts(facts, d.facts);
          rewrites.fallback++;
        }
      } else if (d) facts = mergeFacts(facts, d.facts);
      const corrections = [...pd.corrections];
      let record = pd.record;
      let recSha = pd.source?.recSha;
      let stale: string | undefined = pd.stale ?? undefined;
      const reasons: string[] = [];
      if (v.verdict === "drift" && e) {
        const old = new Map(pd.record);
        for (const [k, val] of e.fields) if (old.has(k) && old.get(k) !== val) corrections.push(`- corrected ${today}: ${k} was "${String(old.get(k)).slice(0, 80)}"`);
        record = e.fields;
        recSha = (src.live.get(`${e.table}/${e.sourceId}`) as any).recSha;
        reasons.push("record refreshed from source");
      }
      if (v.verdict === "stale" && !pd.stale) {
        stale = `stale since ${today}: ${v.why}`;
        reasons.push("flagged stale");
      }
      if (v.verdict === "ok" && pd.stale && e) {
        stale = undefined;
        reasons.push("stale flag cleared");
      }
      if (rewritten && JSON.stringify(facts) !== JSON.stringify(pd.facts)) reasons.push(`subject doc rewritten from new evidence (${pd.facts.length} -> ${facts.length} bullets)`);
      else if (facts.length > pd.facts.length) reasons.push(`${facts.length - pd.facts.length} facts appended`);
      if (!reasons.length) continue;
      const kind = e?.kind ?? (/^type: entity · kind: (\w+)/.exec(doc.content)?.[1] ?? KIND_OF_ROOT(pathRoot(doc.name) ?? ""));
      // A rewrite replaces the bullets the distiller saw (pd.facts). Sources no visible bullet cited (omitted facts'
      // ids, uncited sources) were never shown to it, so they carry forward instead of vanishing.
      const pdCited = new Set(pd.facts.flatMap((f) => f.src));
      const newSources = rewritten ? [...new Set([...pd.sources.map((s) => s.id).filter((id) => !pdCited.has(id)), ...facts.flatMap((f) => f.src)])] : [...new Set([...pd.sources.map((s) => s.id), ...facts.flatMap((f) => f.src)])];
      const r = renderDoc({
        kind,
        path: doc.name,
        aliases: (e ? pd.aliases : [...new Set([...pd.aliases, ...(d?.aliases ?? [])])]).slice(0, 8), // record-backed entities: aliases come from the record only
        source: pd.source ? `${pd.source.table}/${pd.source.id}` : undefined,
        recSha,
        checked: today,
        stale,
        record,
        facts,
        corrections,
        sources: newSources.map((id) => ({ id, name: pd.sources.find((s) => s.id === id)?.name ?? memberNames[id] ?? "" })),
      });
      if (r.content === doc.content) continue;
      props.push({ op: "edit", why: reasons.join("; "), name: doc.name, id: doc.id, content: r.content, beforeContent: doc.content, beforeSha: doc.contentHash, sources: newSources, verdict: v.verdict, kind, omitted: r.omitted });
      touched.add(doc.name);
      if (rewritten) rewrites.done++;
    }
    // Distilled clusters with no doc and no entity record: new docs. Never under a how-to root (defense in depth for a
    // plan from an older script version that did not route to skills).
    for (const [path, d] of distilled) {
      if (touched.has(path) || byName.has(path) || entityByPath.has(path) || noCreate(path) || routedPaths.has(path) || HOWTO_ROOTS.some((r) => path.startsWith(`${r}/`))) continue;
      const root = pathRoot(path) ?? "";
      const srcIds = [...new Set(d.facts.flatMap((f) => f.src))];
      const r = renderDoc({ kind: KIND_OF_ROOT(root), path, aliases: d.aliases, facts: d.facts, corrections: [], sources: srcIds.map((id) => ({ id, name: memberNames[id] ?? "" })), distilledNote: `distilled ${today} by dreaming-v2 from ${srcIds.length} inbox memories (they stay in place)` });
      props.push({ op: "create", why: `distilled from ${srcIds.length} B1 members`, name: path, content: r.content, sources: srcIds, verdict: "ok", kind: KIND_OF_ROOT(root), omitted: r.omitted });
      touched.add(path);
    }
    // Guard (operator 2026-10-06): no create or edit under a how-to root, whatever produced the proposal.
    const blocked = new Map<Prop, string>();
    for (const x of props) {
      const g = guardLongtermWrite(x);
      if (!g.ok) blocked.set(x, g.why);
    }
    // Invariant (operator 2026-10-08): a doc that points at something it does not contain is not written; the existing
    // row stays as it is. Listed in the markdown and errors; the rest of the lane carries on.
    const invBlocked = invariantGate(props.filter((x) => !blocked.has(x)));
    for (const [x, why] of invBlocked) {
      blocked.set(x, why);
      errors.push(`${x.op} ${x.name} refused, ${why}`);
    }
    // Validate proposals: unique names, enum paths, one chunk.
    const names = new Map<string, number>();
    for (const x of props) if (x.op === "create") names.set(x.name, (names.get(x.name) ?? 0) + 1);
    for (const x of props) {
      if (x.op === "create" && (names.get(x.name) ?? 0) > 1) x.verdict = "duplicate";
      if (x.op === "create" && noCreate(x.name)) x.verdict = "no-create-root";
      if (x.op === "create" && x.kind !== "person" && agentOrRepoMatch(x.name, src.live)) x.verdict = "misfiled";
      if (!pathRoot(x.name)) x.verdict = "bad-path";
      if (x.content && x.content.length > MAX_DOC) x.verdict = "too-big";
    }
    // Caps: deterministic creates first (people, agents, repos), then distilled; edits; deletes.
    const order = (x: Prop) => ({ person: 0, agent: 1, repo: 2 } as Record<string, number>)[x.kind] ?? 3;
    const creates = props.filter((x) => x.op === "create" && x.verdict === "ok" && !blocked.has(x)).sort((x, y) => order(x) - order(y));
    const edits = props.filter((x) => x.op === "edit" && !blocked.has(x));
    const deletes = props.filter((x) => x.op === "delete");
    const planned = [...creates.slice(0, a.maxCreates), ...edits.slice(0, a.maxEdits), ...deletes.slice(0, a.maxDeletes)];
    const overCap = { creates: Math.max(0, creates.length - a.maxCreates), edits: Math.max(0, edits.length - a.maxEdits), deletes: Math.max(0, deletes.length - a.maxDeletes) };
    const refused = [...props.filter((x) => x.verdict !== "ok" && x.op === "create" && !blocked.has(x)).map((x) => ({ name: x.name, verdict: x.verdict })), ...[...blocked].map(([x, why]) => ({ name: x.name, op: x.op, verdict: why }))];

    // Writes (live only).
    const writes: any[] = [];
    const ledgerItems: any[] = [];
    const t0 = Date.now();
    if (live) {
      let n = 0;
      for (const x of planned) {
        if (Date.now() - t0 > (a.writeBudgetMs ?? 90000)) {
          errors.push(`write budget ${Math.round((a.writeBudgetMs ?? 90000) / 1000)}s reached; rest left for tomorrow`);
          break;
        }
        n++;
        const actionId = `MT${n}`;
        const g = guardLongtermWrite(x);
        const inv = x.op !== "delete" ? docInvariant(x.content ?? "") : [];
        if (!g.ok || inv.length) {
          writes.push({ actionId, op: x.op, id: x.id ?? null, name: x.name, status: "refused", why: g.ok ? `invariant: ${inv.join(", ")}` : g.why });
          if (g.ok) errors.push(`${x.op} ${x.name} refused at write, invariant: ${inv.join(", ")}`);
          continue;
        }
        try {
          if (x.op === "create") {
            const c = await q("pre-create", `SELECT COUNT(*) n FROM agent_memory WHERE name = ?`, [x.name]);
            if (Number(c[0]?.n ?? 1) !== 0) {
              writes.push({ actionId, op: "create", name: x.name, status: "skipped", why: "name appeared since plan" });
              continue;
            }
            // SDK write calls do not throw on a refused write: they return { data: { success: false, message } }.
            const res: any = await ctx.swarm.memory_store({ name: x.name, content: x.content!, scope: "swarm", tags: [...TAGS, `longterm-${x.kind}`, runId].filter(Boolean), intent: `dreaming-v2 ${runId} memtax-create ${actionId}: ${x.why}` });
            if (res?.data?.success === false) {
              writes.push({ actionId, op: "create", name: x.name, status: "failed", why: String(res.data.message ?? "refused").slice(0, 200) });
              continue;
            }
            const back = await q("post-create", `SELECT id, contentHash, totalChunks FROM agent_memory WHERE name = ? AND chunkIndex = 0`, [x.name]);
            const afterSha = await sha(x.content!);
            const okBack = back.length === 1 && back[0].contentHash === afterSha && Number(back[0].totalChunks) === 1;
            writes.push({ actionId, op: "create", id: back[0]?.id ?? null, name: x.name, beforeSha: null, afterSha, status: okBack ? "verified" : "unverified" });
            ledgerItems.push({ actionId, lane: "memtax", kind: "memory-store", target: { name: x.name }, contentHash: afterSha });
          } else if (x.op === "edit") {
            const cur = await q("pre-edit", `SELECT contentHash, version, content, totalChunks FROM agent_memory WHERE id = ? AND chunkIndex = 0`, [x.id]);
            if (!cur.length || cur[0].contentHash !== x.beforeSha || Number(cur[0].totalChunks) !== 1) {
              writes.push({ actionId, op: "edit", id: x.id, name: x.name, status: "skipped", why: "doc changed since plan (sha) or became multi-chunk" });
              continue;
            }
            const preimageKey = `memtax-create:pre:${runId}:${x.id}`;
            await ctx.swarm.kv_set({ namespace: NS, key: preimageKey, value: { rows: [{ id: x.id, name: x.name, content: cur[0].content }], sha256: x.beforeSha, at: new Date().toISOString() } as any });
            const res: any = await ctx.swarm.memory_edit({ memoryId: x.id, mode: "replace", content: x.content!, intent: `dreaming-v2 ${runId} memtax-create ${actionId}: ${x.why}`, expectedVersion: Number(cur[0].version) || undefined });
            if (res?.data?.success === false) {
              writes.push({ actionId, op: "edit", id: x.id, name: x.name, status: "failed", why: String(res.data.message ?? "refused").slice(0, 200), preimageKey });
              continue;
            }
            const back = await q("post-edit", `SELECT contentHash FROM agent_memory WHERE id = ? AND chunkIndex = 0`, [x.id]);
            const afterSha = await sha(x.content!);
            writes.push({ actionId, op: "edit", id: x.id, name: x.name, beforeSha: x.beforeSha, afterSha, preimageKey, status: back[0]?.contentHash === afterSha ? "verified" : "unverified" });
            ledgerItems.push({ actionId, lane: "memtax", kind: "memory-edit", target: { name: x.name, memoryIds: [x.id] }, contentHash: afterSha, preimageKey });
          } else {
            const cur = await q("pre-delete", `SELECT content, contentHash, name FROM agent_memory WHERE id = ? AND chunkIndex = 0`, [x.id]);
            if (!cur.length || !String(cur[0].name).startsWith("/longterm/") || cur[0].contentHash !== x.beforeSha) {
              writes.push({ actionId, op: "delete", id: x.id, name: x.name, status: "skipped", why: "gone, renamed or changed since plan" });
              continue;
            }
            const preimageKey = `memtax-create:pre:${runId}:${x.id}`;
            await ctx.swarm.kv_set({ namespace: NS, key: preimageKey, value: { rows: [{ id: x.id, name: x.name, content: cur[0].content }], sha256: x.beforeSha, at: new Date().toISOString() } as any });
            await ctx.swarm.memory_delete({ id: x.id! });
            const back = await q("post-delete", `SELECT COUNT(*) n FROM agent_memory WHERE id = ?`, [x.id]);
            writes.push({ actionId, op: "delete", id: x.id, name: x.name, beforeSha: x.beforeSha, afterSha: null, preimageKey, status: Number(back[0]?.n) === 0 ? "verified" : "unverified" });
            ledgerItems.push({ actionId, lane: "memtax", kind: "memory-delete", target: { name: x.name, memoryIds: [x.id] }, preimageKey });
          }
        } catch (e: any) {
          writes.push({ actionId, op: x.op, id: x.id ?? null, name: x.name, status: "failed", why: String(e?.message ?? e).slice(0, 200) });
        }
      }
      // Write log for rollback + ledger items for the next night's dreaming-verify survival check. verify already
      // wrote ledger:<runId> earlier in this run (verify -> learn -> memtax), so this read-append-write has no racer.
      try {
        await ctx.swarm.kv_set({ namespace: NS, key: `memtax-create:writes:${runId}`, value: { runId, at: new Date().toISOString(), writes } as any });
        if (ledgerItems.length) {
          const led: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key: `ledger:${runId}` });
          if (led?.value && typeof led.value === "object") {
            const v = led.value as any;
            const prior = (Array.isArray(v.applied) ? v.applied : []).filter((x: any) => x?.lane !== "memtax");
            await ctx.swarm.kv_set({ namespace: NS, key: `ledger:${runId}`, value: { ...v, applied: [...prior, ...ledgerItems], memtaxCreate: { writes: writes.length, at: new Date().toISOString() } } as any });
          } else errors.push("ledger: no ledger for this run (verify did not write one); survival will not see tonight's memtax writes");
        }
      } catch (e: any) {
        errors.push(`log: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    // Handoff to the next night's synthesize (it runs before lane B). Not a memory write, so it does not wait on
    // v3Writes; dry runs write nothing. Fixed key :latest so synthesize reads it by exact name.
    let handoff = runDry ? "dry run, not written" : "none";
    if (!runDry) {
      try {
        const value = { runId, at: new Date().toISOString(), routes: skillRoutes.map((r) => ({ ...r, memberNames: (r.memberIds ?? []).map((id: string) => memberNames[id] ?? "") })) };
        await ctx.swarm.kv_set({ namespace: NS, key: `memtax-create:skill-routes:${runId}`, value: value as any });
        await ctx.swarm.kv_set({ namespace: NS, key: "memtax-create:skill-routes:latest", value: value as any });
        handoff = `KV memtax-create:skill-routes:latest (${skillRoutes.length} routes)`;
      } catch (e: any) {
        errors.push(`handoff: ${String(e?.message ?? e).slice(0, 200)}`);
        handoff = "failed";
      }
    }
    const longtermRowsAfter = Number((await q("longterm-count", `SELECT COUNT(*) n FROM agent_memory WHERE name GLOB '/longterm/*'`))[0]?.n ?? NaN);
    // Report.
    const perPath: Record<string, { create: number; edit: number; delete: number }> = {};
    for (const x of props) {
      const root = (pathRoot(x.name) ?? "other").replace(/\/(people|agents|repos|customers|services)$/, "/$1");
      perPath[root] ??= { create: 0, edit: 0, delete: 0 };
      perPath[root][x.op]++;
    }
    const verdictCounts = verdicts.reduce((m: Record<string, number>, v) => ((m[v.verdict] = (m[v.verdict] ?? 0) + 1), m), {});
    const distilledCount = props.filter((x) => x.op === "create" && !["person", "agent", "repo"].includes(x.kind)).length;
    const samplePick = [...planned].sort((x, y) => order(x) - order(y));
    const samples = [...samplePick.filter((x) => x.kind === "person"), ...samplePick.filter((x) => x.kind !== "person" && x.kind !== "agent" && x.kind !== "repo"), ...samplePick.filter((x) => x.kind === "agent" || x.kind === "repo")].slice(0, a.sampleCount);
    const counts = {
      creates: creates.length,
      edits: edits.length,
      deletes: deletes.length,
      planned: planned.length,
      written: writes.filter((w) => w.status === "verified").length,
      unverified: writes.filter((w) => w.status === "unverified" || w.status === "failed").length,
      stale: verdicts.filter((v) => v.verdict === "stale").length,
      drift: verdicts.filter((v) => v.verdict === "drift").length,
      duplicates: verdicts.filter((v) => v.verdict === "duplicate").length + refused.filter((r) => r.verdict === "duplicate").length,
      distilled: distilledCount,
      routedToSkills: skillRoutes.length,
      routedSkillUpdate: skillRoutes.filter((r) => r.route === "skill-update").length,
      routedSkillNew: skillRoutes.filter((r) => r.route === "skill-new").length,
      routedToScripts: skillRoutes.filter((r) => r.scriptLane === "scriptify").length,
      howtoLeftInInbox: (Array.isArray(pl.recallLeft) ? pl.recallLeft : []).length,
      // Taxonomy v5: subject docs rewritten in place; episodic notes kept out of /longterm.
      subjectRewrites: rewrites.done,
      subjectRewriteFallback: rewrites.fallback,
      subjectBulletsDropped: rewrites.dropped,
      episodicLeftInInbox: Number(pl.clusterStats?.episodic ?? 0) + episodicClusters.length,
      factsRootWrites: props.filter((x) => x.op !== "delete" && /^\/longterm\/facts(\/|$)/.test(x.name) && planned.includes(x)).length,
      // Every how-to write stopped tonight: distilled clusters on a how-to root (plan from an older script or a forged
      // classify), proposals the guard refused, and write-time refusals.
      guardRefused: [...distilled.keys()].filter((p) => HOWTO_ROOTS.some((r) => p.startsWith(`${r}/`))).length + blocked.size - invBlocked.size + writes.filter((w) => w.status === "refused" && !String(w.why).startsWith("invariant")).length,
      // Operator 2026-10-08 invariant: rendered docs refused before the write, and existing docs that break it.
      invariantRefused: invBlocked.size + writes.filter((w) => w.status === "refused" && String(w.why).startsWith("invariant")).length,
      invariantExisting: verdicts.filter((v) => v.invariant.length).length,
      existingDocs: existing.length,
      longtermRowsBefore: pl.longtermRowsBefore ?? null,
      longtermRowsAfter,
    };
    const L: string[] = ["## Long-term memories (lane B, create/validate/tidy)"];
    L.push(
      live
        ? `${counts.written} writes verified of ${planned.length} planned (${creates.length} creates, ${edits.length} edits, ${deletes.length} deletes before caps). /longterm rows ${counts.longtermRowsBefore} -> ${longtermRowsAfter}. Log: KV memtax-create:writes:${runId}; rollback: script dreaming-memtax-create mode rollback.`
        : `Nothing written (${runDry ? "dry run" : "v3Writes off"}). Would write ${planned.length}: ${creates.length} creates, ${edits.length} edits, ${deletes.length} deletes. /longterm rows ${counts.longtermRowsBefore} -> ${longtermRowsAfter} (must be equal).`,
    );
    L.push(`Validate (${existing.length} existing /longterm docs): ${Object.entries(verdictCounts).map(([k, n]) => `${k} ${n}`).join(", ") || "none yet"}. Distilled from B1: ${distilledCount} new docs from ${distilled.size} clusters${failedJobs.length ? `; failed distill jobs: ${failedJobs.map((j) => `${j.jobId} ${j.status}`).join(", ")}` : ""}${Object.keys(distillRejected).length ? `; rejected bullets: ${Object.entries(distillRejected).map(([k, n]) => `${k} ${n}`).join(", ")}` : ""}.`);
    const invEx = verdicts.filter((v) => v.invariant.length);
    L.push(`**Source pointers** (no line points at what the doc does not contain): ${counts.invariantRefused} rendered docs refused before write${invBlocked.size ? ` (${[...invBlocked].map(([x, why]) => `\`${x.name}\` ${why.replace("invariant: ", "")}`).join("; ")}; existing rows kept)` : ""} · ${invEx.length} existing docs break it${invEx.length ? ` (${invEx.map((v) => `\`${v.name}\` ${v.invariant.join(", ")}`).join("; ")})` : ""}.`);
    const refOnly = src.entities.filter((e) => noCreate(e.path)).length;
    const cs: any = pl.clusterStats ?? {};
    L.push(`Agents and repos are not created: agent profiles and get-repos are the source of truth. ${refOnly} agent/repo records read for validation only${cs.noCreateRoot ? `; ${cs.noCreateRoot} B1 classifications to those roots not distilled` : ""}${cs.misfiled ? `; ${cs.misfiled} people/customer classifications naming an agent or repo dropped` : ""}.`);
    L.push(`**Routed to skills/scripts, not /longterm** (/longterm is recall only): ${counts.routedToSkills} (${counts.routedSkillUpdate} skill updates, ${counts.routedSkillNew} new skills, ${counts.routedToScripts} script) · guard refused ${counts.guardRefused} /longterm how-to writes · handoff: ${handoff}${counts.howtoLeftInInbox ? ` · ${counts.howtoLeftInInbox} recall notes on a how-to path left in inbox` : ""}.`);
    L.push(`**Subject docs** (taxonomy v5, /longterm is distilled understanding): ${counts.subjectRewrites} rewritten in place${counts.subjectRewriteFallback ? `, ${counts.subjectRewriteFallback} rewrites refused for dropping evidence (merged instead)` : ""} · ${counts.episodicLeftInInbox} episodic notes (bug, incident, fix) left in the inbox · /longterm/facts writes planned: ${counts.factsRootWrites}.`);
    if (skillRoutes.length) {
      L.push("", "| path | proposal | skill | script | members |", "|---|---|---|---|---:|");
      for (const r of skillRoutes) L.push(`| \`${r.path}\` | ${r.lane} ${r.op} | ${r.skill ? `\`${r.skill}\`` : "new"} | ${r.scriptExisting ? `wire \`${r.scriptExisting}\`` : r.script ? "new" : "-"} | ${(r.memberIds ?? []).length} |`);
      L.push("");
    }
    if (Object.values(overCap).some((n) => n > 0)) L.push(`Over the nightly cap, left for tomorrow: ${Object.entries(overCap).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ")}.`);
    if (src.skipped.length) L.push(`Source records skipped: ${src.skipped.map((s) => `${s.name} (${s.why})`).slice(0, 12).join("; ")}.`);
    L.push("", "| path | create | edit | delete |", "|---|---:|---:|---:|");
    for (const [k, v] of Object.entries(perPath).sort()) L.push(`| \`${k}\` | ${v.create} | ${v.edit} | ${v.delete} |`);
    if (samples.length) {
      L.push("", `**${samples.length} samples** (sizes in tokens = ceil(chars / 4)):`, "", "| # | op | name | tokens | why |", "|---:|---|---|---:|---|");
      samples.forEach((x, i) => L.push(`| ${i + 1} | ${x.op} | \`${x.name}\` | ${x.content ? tok(x.content.length) : 0} | ${esc(x.why, 90)} |`));
    }
    return {
      ok: errors.length === 0 && failedJobs.length === 0 && counts.unverified === 0,
      mode: "apply",
      dryRun: runDry,
      writesOn: live,
      runId,
      counts,
      perPath,
      verdicts,
      proposals: props.map((x) => ({ op: x.op, name: x.name, id: x.id ?? null, kind: x.kind, why: x.why, verdict: x.verdict, sources: x.sources, tokens: x.content ? tok(x.content.length) : 0, content: x.content ?? null, omitted: x.omitted ?? 0, planned: planned.includes(x) })),
      refused,
      skillRoutes,
      handoff,
      overCap,
      failedJobs,
      distillRejected,
      writes,
      ledgerItems: ledgerItems.length,
      markdown: L.join("\n"),
      errors,
    };
  }

  async function rollback() {
    const rid = a.targetRunId ?? "";
    const log: any = rid ? await ctx.swarm.kv_getOrNull({ namespace: NS, key: `memtax-create:writes:${rid}` }) : null;
    const writes: any[] = Array.isArray(log?.value?.writes) ? log.value.writes : [];
    const out: any[] = [];
    for (const w of [...writes].reverse()) {
      if (!["verified", "unverified"].includes(w.status)) continue;
      const step: any = { actionId: w.actionId, op: w.op, id: w.id, name: w.name };
      try {
        if (w.op === "create") {
          step.undo = `delete ${w.id}`;
          if (a.execute && w.id) await ctx.swarm.memory_delete({ id: w.id });
        } else {
          const pre: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key: w.preimageKey });
          const content = pre?.value?.rows?.[0]?.content;
          if (typeof content !== "string") {
            step.undo = "no pre-image";
            out.push(step);
            continue;
          }
          if (w.op === "edit") {
            step.undo = `restore content of ${w.id} (sha ${String(w.beforeSha).slice(0, 12)})`;
            if (a.execute) await ctx.swarm.memory_edit({ memoryId: w.id, mode: "replace", content, intent: `rollback memtax-create ${rid} ${w.actionId}` });
          } else {
            step.undo = `re-store ${w.name} (new id)`;
            if (a.execute) await ctx.swarm.memory_store({ name: w.name, content, scope: "swarm", tags: [...TAGS, "rollback"], intent: `rollback memtax-create ${rid} ${w.actionId}` });
          }
        }
        step.status = a.execute ? "done" : "would";
      } catch (e: any) {
        step.status = "failed";
        step.error = String(e?.message ?? e).slice(0, 200);
      }
      out.push(step);
    }
    return { ok: out.every((s) => s.status !== "failed"), mode: "rollback", targetRunId: rid, execute: a.execute, found: writes.length, steps: out, errors };
  }

  // Scratch dry runs only: B1-shaped batches from a name filter, so a small classify shows clustering.
  async function sample() {
    const pats = (a.match ?? []).map((s) => String(s).toLowerCase()).filter((s) => /^[a-z0-9 _-]{2,40}$/.test(s)).slice(0, 10);
    if (!pats.length) return { ok: false, mode: "sample", batches: [], errors: ["match: give 1-10 name substrings"] };
    const per = Math.max(1, Math.floor(a.batchSize / pats.length));
    const seen = new Set<string>();
    const docs: any[] = [];
    for (const s of pats) {
      const r = await q(
        `sample-${s}`,
        `SELECT m.id, m.name, m.source, m.key, m.tags, m.accessCount, m.alpha, m.beta, m.totalChunks, m.createdAt, substr(m.content, 1, 1500) text,
           (SELECT COUNT(*) FROM memory_link l WHERE l.targetId = m.id) inLinks
         FROM agent_memory m WHERE m.chunkIndex = 0 AND m.source = 'manual' AND m.scope = 'swarm' AND lower(m.name) LIKE ? AND m.name NOT GLOB '/longterm/*'
         ORDER BY m.accessCount DESC, m.id LIMIT ?`,
        [`%${s}%`, per + 10],
      );
      for (const d of r.filter((x) => !seen.has(x.id)).slice(0, per)) {
        seen.add(d.id);
        docs.push({ id: d.id, name: String(d.name ?? "").slice(0, 160), scope: "swarm", source: d.source, key: String(d.key ?? "").slice(0, 120), tags: String(d.tags ?? "").slice(0, 200), acc: Number(d.accessCount ?? 0), ab: `${Number(d.alpha ?? 1).toFixed(1)}/${Number(d.beta ?? 1).toFixed(1)}`, inLinks: Number(d.inLinks ?? 0), chunks: Number(d.totalChunks ?? 1), created: String(d.createdAt ?? "").slice(0, 10), pre: "other", text: String(d.text ?? "") });
      }
    }
    return { ok: errors.length === 0, mode: "sample", dryRun: true, runId, since: null, skipReason: docs.length ? null : "no docs matched", batches: docs.length ? [{ batchId: `${today}-sample-1`, kind: "sample", docs }] : [], counts: { planned: docs.length, match: pats }, errors };
  }

  async function controls() {
    const cases: Array<{ name: string; pass: boolean; got?: unknown }> = [];
    const t = (name: string, pass: boolean, got?: unknown) => cases.push({ name, pass, got });
    const users = [
      { id: "u1", name: "Ada", email: "t@x.ai", role: "co-founder, CTO", status: "active", timezone: "Europe/Madrid", preferredChannel: "slack", ext: "slack,github" },
      { id: "u2", name: "Bot", email: "b@x.ai", role: "viewer", status: "active" },
      { id: "u3", name: "Old", role: "external contributor", status: "suspended" },
      { id: "u4", name: "jan-swarm", role: "external bot — x", status: "active" },
    ];
    const agents = [{ id: "a1", name: "Builder Bot", role: "Implementer", isLead: 0, harness: "codex" }, { id: "a2", name: "ext:gate", role: "extension", isLead: 0 }];
    const repos = [{ id: "r1", name: "landing", url: "https://github.com/example-org/landing/" }, { id: "r2", name: "x", url: "https://gitlab.com/a/b" }];
    const { entities, skipped } = buildEntities(users, agents, repos);
    t("people v5: record links the comms profile, never copies it", entities.find((e) => e.kind === "person")!.fields.some(([k, v]) => k === "comms profile" && v === "none") && buildEntities([{ ...users[0], hasComms: 1 }], [], []).entities[0]!.fields.some(([k, v]) => k === "comms profile" && v.startsWith("users/u1 ")));
    t("people: only active humans", entities.filter((e) => e.kind === "person").map((e) => e.path).join() === "/longterm/entities/people/ada", entities.map((e) => e.path));
    t("people: bot, viewer, suspended skipped", skipped.filter((s) => s.table === "users").length === 3);
    t("agents: extension skipped, slug kebab", entities.some((e) => e.path === "/longterm/entities/agents/builder-bot") && skipped.some((s) => s.name === "ext:gate"));
    t("repos: trailing slash ok, non-github skipped", entities.some((e) => e.path === "/longterm/entities/repos/example-org/landing") && skipped.some((s) => s.id === "r2"));
    t("every entity path is in the enum or reference-only", entities.every((e) => pathRoot(e.path) !== null || refPath(e.path)));
    t("allowlist: dropped roots outside the enum", ["/longterm/procedures/x", "/longterm/entities/services/x", "/longterm/entities/agents/x", "/longterm/entities/repos/a/b", "/longterm/timeline/weekly/2026-W40"].every((p) => pathRoot(p) === null));
    t("allowlist: retired how-to roots outside the enum (operator 10-06)", pathRoot("/longterm/facts/procedures/x") === null && pathRoot("/longterm/facts/services/x") === null);
    t("allowlist: /howto routing root, story sections and lowercase week in the enum", pathRoot("/howto/x") === "/howto" && pathRoot("/longterm/company-story/how-we-work") === "/longterm/company-story" && pathRoot("/longterm/timeline/weekly/2026-w40") === "/longterm/timeline/weekly");
    t("allowlist v5: /longterm/facts, bare company-story and unknown sections outside the enum", ["/longterm/facts/swarm-runtime/x", "/longterm/facts/infra/ci-run-tests-shard2-hang", "/longterm/company-story", "/longterm/company-story/misc"].every((p) => pathRoot(p) === null));
    t("allowlist: kind of mapped roots", KIND_OF_ROOT("/howto") === "procedure" && KIND_OF_ROOT("/longterm/facts") === "fact");
    // Guard (operator 2026-10-06). Positive: a planned /longterm write under facts/services|procedures is refused.
    t("guard: create under facts/services refused (positive control)", (guardLongtermWrite({ op: "create", name: "/longterm/facts/services/clickhouse" }) as any).why === "howto-root");
    t("guard: edit under facts/procedures refused (positive control)", (guardLongtermWrite({ op: "edit", name: "/longterm/facts/procedures/hn-briefing" }) as any).why === "howto-root");
    t("guard: a /howto routing path is never written", (guardLongtermWrite({ op: "create", name: "/howto/clickhouse" }) as any).why === "not-longterm");
    // Negative: recall writes and any delete pass.
    t("guard: recall creates pass (negative control)", ["/longterm/decisions/2026-10-06-longterm-is-recall-only", "/longterm/entities/people/ada", "/longterm/entities/customers/acme", "/longterm/workstreams/active/dreaming-v2", "/longterm/company-story/overview"].every((n) => guardLongtermWrite({ op: "create", name: n }).ok));
    t("guard v5: create/edit under /longterm/facts refused (positive control)", [guardLongtermWrite({ op: "create", name: "/longterm/facts/infra/ci-run-tests-shard2-hang" }), guardLongtermWrite({ op: "edit", name: "/longterm/facts/workflows/workflow-condition-evaluation-bug" })].every((g: any) => g.ok === false && g.why === "retired-root") && guardLongtermWrite({ op: "delete", name: "/longterm/facts/infra/x" }).ok);
    t("guard: delete under a how-to root passes (negative control)", guardLongtermWrite({ op: "delete", name: "/longterm/facts/services/clickhouse" }).ok === true);
    const rIds = new Set(["d1", "d2", "d3"]);
    const lg: any = validateClassification({ id: "d1", path: "/longterm/facts/services/clickhouse", kind: "fact", action: "move" }, rIds);
    t("classify: legacy services row re-filed to /howto", lg.ok && lg.row.path === "/howto/clickhouse" && lg.row.kind === "procedure" && lg.row.remapped === true, lg);
    const lm: any = validateClassification({ id: "d2", path: "/longterm/facts/workflows/x", kind: "fact", action: "merge-into:/longterm/facts/procedures/hn-briefing" }, rIds);
    t("classify: legacy procedures merge target re-filed to /howto", lm.ok && lm.row.mergeTarget === "/howto/hn-briefing" && lm.row.kind === "procedure" && lm.row.remapped === true, lm);
    const bug: any = validateClassification({ id: "e1-episodic", path: "/longterm/facts/infra/ci-run-tests-shard2-hang", kind: "fact", action: "merge-into:/longterm/facts/infra/ci-run-tests-shard2-hang" }, new Set(["e1-episodic"]));
    t("classify v5: bug note on a facts path stays in the inbox (positive control)", bug.ok && bug.row.path === "/inbox/e1-episodic" && bug.row.mergeTarget === null && bug.row.kind === "inbox" && bug.row.refiled === "episodic", bug);
    const sub: any = validateClassification({ id: "d2", path: "/longterm/facts/swarm-runtime/x", kind: "fact", action: "merge-into:/longterm/entities/people/ada" }, rIds);
    t("classify v5: a facts note revealing a trait folds into the subject doc (negative control)", sub.ok && sub.row.mergeTarget === "/longterm/entities/people/ada" && sub.row.path === "/longterm/entities/people/ada" && sub.row.refiled === null, sub);
    const lr: any = validateClassification({ id: "d3", path: "/longterm/decisions/2026-10-06-x", kind: "decision", action: "move" }, rIds);
    t("classify: decision untouched (negative control)", lr.ok && lr.row.path === "/longterm/decisions/2026-10-06-x" && lr.row.remapped === false, lr);
    t("no create: agents and repos are reference only", entities.filter((e) => !noCreate(e.path)).every((e) => e.kind === "person") && entities.some((e) => e.kind === "agent" && noCreate(e.path)) && entities.some((e) => e.kind === "repo" && noCreate(e.path)));
    t("no create: distilled agent/repo paths blocked, people/facts not", noCreate("/longterm/entities/agents/lead") && noCreate("/longterm/entities/repos/example-org/landing") && !noCreate("/longterm/entities/people/ada") && !noCreate("/longterm/entities/customers/acme") && !noCreate("/longterm/facts/workflows/x"));
    const refLive = new Map<string, any>();
    for (const e of entities) refLive.set(`${e.table}/${e.sourceId}`, { e, recSha: "x" });
    t("validate: customer doc naming a repo -> misfiled", validateDoc({ id: "m5", name: "/longterm/entities/customers/landing", totalChunks: 1, content: "type: entity" }, refLive, new Map()).verdict === "misfiled");
    t("validate: people doc naming an agent -> misfiled; real customer ok-unsourced", validateDoc({ id: "m6", name: "/longterm/entities/people/builder-bot", totalChunks: 1, content: "type: entity" }, refLive, new Map()).verdict === "misfiled" && validateDoc({ id: "m7", name: "/longterm/entities/customers/acme", totalChunks: 1, content: "type: entity" }, refLive, new Map()).verdict === "ok-unsourced");
    const e0 = entities[0]!;
    const rs = await recordSha(e0);
    const doc = renderDoc({ kind: "person", path: e0.path, aliases: e0.aliases, source: `users/${e0.sourceId}`, recSha: rs, checked: "2026-10-01", record: e0.fields, facts: [{ claim: "Wants sizes in tokens, not chars", stated: "2026-10-01", src: ["11111111-2222-3333-4444-555555555555"] }], corrections: [], sources: [{ id: "11111111-2222-3333-4444-555555555555", name: "ada tokens" }] });
    const back = parseDoc(doc.content);
    t("render/parse round trip", back.source?.recSha === rs && back.facts.length === 1 && back.record.length === e0.fields.length && back.sources.length === 1, back);
    t("doc fits one chunk", doc.content.length <= MAX_DOC);
    const many = renderDoc({ kind: "fact", path: "/longterm/facts/workflows/x", aliases: [], facts: Array.from({ length: 40 }, (_, i) => ({ claim: `claim number ${i} `.repeat(6), stated: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`, src: ["abcdef12"] })), corrections: [], sources: [] });
    t("oversize doc trimmed to one chunk", many.content.length <= MAX_DOC && many.omitted > 0, { len: many.content.length, omitted: many.omitted });
    // Operator 2026-10-08: no bare "(+N more sources)" Sources, no "see sources" pointer at nothing, ids survive a re-render.
    const uid = (i: number) => `${String(i).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(i).padStart(12, "0")}`;
    const bigFacts = Array.from({ length: 12 }, (_, i) => ({ claim: `Standing rule number ${i}: ${"keep the doc one chunk ".repeat(3)}`, stated: `2026-09-${String(i + 10).padStart(2, "0")}`, src: [uid(i), uid(100 + i)] }));
    const big = renderDoc({ kind: "story", path: "/longterm/company-story/x", aliases: [], facts: bigFacts, corrections: [], sources: bigFacts.flatMap((f) => f.src).map((id) => ({ id, name: `memory ${id.slice(0, 8)}` })) });
    const omitLine = big.content.split("\n").find((l) => l.includes("older facts omitted")) ?? "";
    const droppedIds = bigFacts.slice(0, big.omitted).flatMap((f) => f.src);
    t("sources: never a bare (+N more sources) line, never a see-sources pointer", big.omitted > 0 && !/more sources\)/.test(big.content) && !/see sources/.test(big.content) && big.content.length <= MAX_DOC, { len: big.content.length, omitted: big.omitted });
    t("sources: omitted line lists every dropped fact's src ids", droppedIds.length > 0 && droppedIds.every((id) => omitLine.includes(id)), { omitLine });
    const bp = parseDoc(big.content);
    const again = renderDoc({ kind: "story", path: "/longterm/company-story/x", aliases: [], facts: [{ claim: "A newer fact", stated: "2026-10-08", src: [uid(999)] }, ...bp.facts], corrections: [], sources: bp.sources });
    t("sources: parse -> render keeps the omitted ids (round trip)", droppedIds.every((id) => bp.sources.some((s) => s.id === id) && again.content.includes(id)) && again.content.length <= MAX_DOC, { againLen: again.content.length, againOmitted: again.omitted });
    const small = renderDoc({ kind: "story", path: "/longterm/company-story/y", aliases: ["y"], facts: [{ claim: "One fact", stated: "2026-10-01", src: [uid(1)] }], corrections: [], sources: [{ id: uid(1), name: "one memory" }] });
    t("sources: under-budget doc renders as before (negative control)", small.omitted === 0 && small.content === `type: story · path: /longterm/company-story/y\naliases: y\n\n## Facts\n- One fact (stated 2026-10-01, src: ${uid(1)})\n\n## Sources\n- ${uid(1)}: one memory`, small.content);
    // Invariant gate (operator 2026-10-08). Negative controls: the 10-07 shapes are refused before any write.
    const bareFx = `type: story · path: /longterm/company-story/how-we-work\n\n## Facts\n- One fact (stated 2026-10-01, src: ${uid(1)})\n- (+2 older facts omitted to stay one chunk; see sources)\n\n## Sources\n- (+15 more sources)`;
    t("invariant: bare (+N more sources) Sources + see-sources pointer refused (negative control)", ["bare-more-sources", "see-sources", "omitted-without-src"].every((x) => docInvariant(bareFx).includes(x)), docInvariant(bareFx));
    t("invariant: bare Sources alone refused", docInvariant(`type: story\n\n## Facts\n- One fact (stated 2026-10-01, src: ${uid(1)})\n\n## Sources\n- (+3 more sources)`).join() === "bare-more-sources");
    t("invariant: a (+N more sources) count next to ids refused", docInvariant(`type: story\n\n## Sources\n- ${uid(1)}: x\n- (+4 more sources)`).join() === "more-sources-count");
    t("invariant: omitted line with an empty src list refused", docInvariant(`type: story\n\n## Facts\n- (+2 older facts omitted to stay one chunk; src: )`).join() === "omitted-without-src");
    const gateFx = [{ op: "edit", name: "/longterm/company-story/how-we-work", content: bareFx }, { op: "create", name: "/longterm/company-story/y", content: small.content }, { op: "delete", name: "/longterm/facts/x" }];
    const gate = invariantGate(gateFx);
    t("invariant: apply gate refuses the bare fixture, passes the clean create and the delete", gate.size === 1 && gate.has(gateFx[0]!) && String(gate.get(gateFx[0]!)).startsWith("invariant: bare-more-sources"), [...gate.values()]);
    t("invariant: every renderDoc output passes (positive control)", [doc.content, many.content, big.content, again.content, small.content].every((c) => docInvariant(c).length === 0), [doc, many, big, again, small].map((r) => docInvariant(r.content)));
    const live = new Map<string, any>([[`users/${e0.sourceId}`, { e: e0, recSha: rs }]]);
    const dup = new Map<string, string>();
    t("validate ok", validateDoc({ id: "m1", name: e0.path, totalChunks: 1, content: doc.content }, live, dup).verdict === "ok");
    t("validate drift", validateDoc({ id: "m1", name: e0.path, totalChunks: 1, content: doc.content.replace(rs, "000000000000") }, live, dup).verdict === "drift");
    t("validate stale (no live record)", validateDoc({ id: "m1", name: e0.path, totalChunks: 1, content: doc.content }, new Map(), dup).verdict === "stale");
    t("validate duplicate", validateDoc({ id: "m2", name: e0.path, totalChunks: 1, content: doc.content }, live, new Map([[e0.path, "m1"]])).verdict === "duplicate");
    t("validate bad path", validateDoc({ id: "m3", name: "/longterm/preferences/x", totalChunks: 1, content: "" }, live, dup).verdict === "bad-path");
    const ci = new Map([["c1", { path: "/longterm/facts/workflows/x", memberIds: new Set(["m1", "m2"]) }]]);
    const dv = validateDistill({ clusters: [{ clusterId: "c1", bullets: [{ claim: "Foreach drops sync successors", stated: "2026-09-30", src: ["m1"] }, { claim: "made up source", stated: "2026-09-30", src: ["zz"] }, { claim: "bad date here ok", stated: "yesterday", src: ["m2"] }] }, { clusterId: "c9", bullets: [] }] }, ci);
    t("distill: src must be a member, date must be ISO", dv.ok.get("c1")?.facts.length === 1 && dv.rejected["src-not-a-member"] === 1 && dv.rejected["bad-date"] === 1 && dv.rejected["unknown-cluster"] === 1, { rejected: dv.rejected });
    // Negative controls: failed / cancelled / garbage distill must parse to non-completed jobs, never throw.
    const neg = parseForeach({ results: [{ itemKey: "j1", status: "completed", output: { taskId: "t1", taskOutput: "[FAILED: memtax-create negative control] x" } }, { itemKey: "j2", status: "failed" }, { itemKey: "j3", status: "completed", output: { taskOutput: "not json" } }] });
    const dh = validateDistill({ clusters: [{ clusterId: "c1", howto: true, bullets: [{ claim: "Call GET /v1/x with the x-api-key header", stated: "2026-10-05", src: ["m1"] }] }] }, ci);
    t("distill: a how-to flagged cluster yields no doc, only a handoff", !dh.ok.has("c1") && dh.howto.has("c1"), { ok: [...dh.ok.keys()], howto: [...dh.howto] });
    t("distill: unflagged cluster is unaffected (negative control)", dv.howto.size === 0 && dv.ok.has("c1"));
    t("neg: [FAILED] -> failed", neg[0]?.status === "failed");
    t("neg: failed child -> failed", neg[1]?.status === "failed");
    t("neg: garbage -> unparseable", neg[2]?.status === "unparseable");
    t("neg: empty/undefined aggregate -> []", parseForeach("").length === 0 && parseForeach(undefined).length === 0);
    const mu = mergeFacts([{ claim: "Prefers being asked what's next", stated: "2026-03-16", src: ["a"] }], [{ claim: "prefers being asked: what's next!", stated: "2026-10-02", src: ["doc"] }]);
    t("merge facts v5: same claim from another source -> one bullet, src unioned, first date", mu.length === 1 && mu[0]!.src.join() === "a,doc" && mu[0]!.stated === "2026-03-16", mu);
    const cur = [1, 2, 3, 4, 5, 6].map((i) => ({ claim: `trait ${i} of the subject`, stated: "2026-09-0" + i, src: [`s${i}`] }));
    const rwOk = rewriteFacts(cur, [{ claim: "traits 1 and 2 merged", stated: "2026-09-01", src: ["s1", "s2"] }, ...cur.slice(2, 5), { claim: "new trait from tonight", stated: "2026-10-06", src: ["m1"] }]);
    t("rewrite: merge + dedupe + one drop accepted", rwOk.ok && rwOk.facts.length === 5 && rwOk.dropped === 1, rwOk);
    const rwBad = rewriteFacts(cur, [{ claim: "only tonight's note", stated: "2026-10-06", src: ["m1"] }]);
    t("rewrite: silently losing 6 of 6 bullets refused (falls back to merge)", !rwBad.ok && rwBad.dropped === 6, rwBad);
    const ci2 = new Map([["c1", { path: "/longterm/entities/people/ada", memberIds: new Set(["m1"]), currentSrc: new Set(["s1", "s2"]) }], ["c2", { path: "/longterm/company-story/products", memberIds: new Set(["m2", "m3"]) }]]);
    const dr = validateDistill({ clusters: [{ clusterId: "c1", rewrite: true, bullets: [{ claim: "Decides direction himself; ask, do not propose", stated: "2026-03-16", src: ["s1", "m1"] }, { claim: "keeps a current-doc source only", stated: "2026-03-01", src: ["s2"] }] }, { clusterId: "c2", episodic: true, bullets: [] }] }, ci2);
    t("distill v5: rewrite may cite current-doc sources; episodic flag -> no doc", dr.ok.get("c1")?.rewrite === true && dr.ok.get("c1")?.facts.length === 2 && dr.episodic.has("c2") && !dr.ok.has("c2"), { ok: [...dr.ok.entries()], episodic: [...dr.episodic] });
    const dn = validateDistill({ clusters: [{ clusterId: "c2", rewrite: true, bullets: [{ claim: "Agent Swarm is the only product sold", stated: "2026-09-14", src: ["s1"] }] }] }, ci2);
    t("distill v5: no current doc -> current sources are not members (rejected)", !dn.ok.has("c2") && dn.rejected["src-not-a-member"] === 1, dn.rejected);
    t("merge facts dedups by claim+src", mergeFacts([{ claim: "A b", stated: "2026-01-01", src: ["x"] }], [{ claim: "a  B", stated: "2026-02-01", src: ["x"] }, { claim: "c", stated: "2026-02-01", src: ["y"] }]).length === 2);
    t("tags never contain memtax", !TAGS.some((x) => x.includes("memtax")));
    const sk: SkillRow[] = [
      { name: "agentmail-sending", description: "CRITICAL rules for sending emails via AgentMail API. Covers the HTML bug workaround." },
      { name: "acme-interaction", description: "How to use the Acme CLI plus the HTTP /v2/pipeline API." },
      { name: "gsc-analytics", description: "How to pull Google Search Console data via the gsc CLI." },
      { name: "linear-interaction", description: "How to push updates to Linear (create issues, add comments) via the Linear GraphQL API." },
      { name: "linear-expert", description: "Systematic Linear triage & project-management workflow." },
      { name: "code-quality", description: "Push, PR, MR, merge, review, CI: the checks to run before you push or open a pull request." },
      { name: "workflow-iterate", description: "A procedure for improving workflows through small tested revisions." },
    ];
    const ru = (p: string) => routeCluster(p, sk);
    t("route: agentmail how-to cluster -> skill-update agentmail-sending (control)", ru("/howto/agentmail").route === "skill-update" && ru("/howto/agentmail").skill === "agentmail-sending", ru("/howto/agentmail"));
    t("route: legacy services path still routes (defense in depth)", ru("/longterm/facts/services/agentmail").route === "skill-update");
    t("route: pr-merging-rules decision stays memory (control)", ru("/longterm/decisions/2026-03-24-pr-merging-rules").route === "memory");
    t("route: decision naming a skill subject still memory", ru("/longterm/decisions/2026-03-25-agentmail-html-drop").route === "memory");
    t("route: people/customers/workstreams stay memory", ["/longterm/entities/people/ada", "/longterm/entities/customers/acme", "/longterm/workstreams/active/linear-sync"].every((p) => ru(p).route === "memory"));
    t("route: service with no skill -> skill-new", ru("/howto/globex").route === "skill-new");
    t("route: procedure covered by phrase -> skill-update", ru("/howto/google-search-console").skill === "gsc-analytics" && ru("/howto/acme").skill === "acme-interaction");
    t("route: linear procedure -> linear-interaction", ru("/howto/linear-comment-formatting").skill === "linear-interaction", ru("/howto/linear-comment-formatting"));
    t("route: domain fact with a skill subject -> skill-update", ru("/longterm/facts/swarm-runtime/agentmail-reply-bug").skill === "agentmail-sending");
    t("route: domain fact without a skill subject stays memory", ru("/longterm/facts/infra/assemble-tsx-stalling").route === "memory" && ru("/longterm/facts/workflows/workflow-condition-evaluation-bug").route === "memory");
    t("route: competitor profile on a how-to path -> inbox, never a /longterm write", ru("/howto/paperclip-ai").route === "skill-new" && routeCluster("/howto/paperclip-ai", sk, ["Open-source orchestration platform launched March 2026, 22K GitHub stars; direct competitive threat; founded by Dotta"]).route === "inbox");
    t("route: a how-to path never routes to memory", ["/howto/globex", "/howto/agentmail", "/howto/paperclip-ai", "/longterm/facts/services/x", "/longterm/facts/procedures/y"].every((p) => ru(p).route !== "memory"));
    const skx: SkillRow[] = [...sk, { name: "x-api-interactions", description: "How to interact with the X/Twitter API v2 for posting tweets, replies, and quote tweets. Includes pre-checks for conversation restrictions." }, { name: "x-posting-guidelines", description: "Voice and style guidelines for posting to X/Twitter as @agent__swarm." }];
    t("route: twitter clusters -> x-api-interactions (phrase + text tie-break)", routeCluster("/howto/twitter", skx, ["Reply returns 403 when the tweet has conversation restrictions"]).skill === "x-api-interactions" && routeCluster("/howto/x-twitter-api", skx, ["search patterns"]).skill === "x-api-interactions");
    t("route: script hint on API text only", scriptHint(["Use GET /v1/companies?search=x with x-api-key"]) && !scriptHint(["Ada prefers charts"]));
    const scr: SkillRow[] = [{ name: "globex-company-search", description: "Search companies in the Globex API." }, { name: "gh-pr-snapshot", description: "Snapshot of open GitHub PRs." }];
    const h1 = handoffRow("/howto/globex", routeCluster("/howto/globex", sk), ["GET /v1/companies with x-api-key"], scr, ["d1", "d2"]);
    t("handoff: existing script first (wire, not rebuild)", h1.lane === "skillify" && h1.op === "skill-create" && h1.scriptExisting === "globex-company-search" && h1.script === false && h1.scriptLane === "scriptify", h1);
    const h2 = handoffRow("/howto/agentmail", routeCluster("/howto/agentmail", sk), ["use the HTML workaround"], scr, ["d3"]);
    t("handoff: covered how-to -> skill-refactor skill-update, no script", h2.lane === "skill-refactor" && h2.op === "skill-update" && h2.skill === "agentmail-sending" && h2.scriptLane === null, h2);
    const h3 = handoffRow("/howto/bluesky", routeCluster("/howto/bluesky", sk), ["POST /xrpc/com.atproto.repo.createRecord with Bearer token"], scr, ["d4", "d5"]);
    t("handoff: API how-to with no script -> script candidate", h3.scriptExisting === null && h3.script === true && h3.scriptLane === "scriptify", h3);
    return { ok: cases.every((c) => c.pass), mode: "controls", passed: cases.filter((c) => c.pass).length, total: cases.length, failed: cases.filter((c) => !c.pass), errors };
  }
}

// fromRun / loadResult, for the seeded `dreaming` workflow. These writes need Lead authority, which a seeded
// workflow's script node does not have, so a Lead agent-task runs `{ mode, runId, fromRun: true }` from its own
// session. Every arg the caller did not pass loads from the run's recorded step outputs (a step that never ran
// reads as "", as interpolation renders it), the result is stored in KV, and the task returns a small pointer. The
// next node runs `{ mode, runId, loadResult: true }` and returns the stored result, so downstream mappings keep
// reading `<node>.result`. Without either flag the script runs exactly as before.
const RUN_NODE = "memtax-create-apply";
const RUN_MODE: string | null = "apply";
// [arg, step nodeId, JSON path in the step output, required]. A missing required step stops before any write.
const RUN_PATHS: Array<[string, string, string, boolean]> = [
  ["dryRun", "gather", "$.result.dryRun", true],
  ["v3Writes", "gather", "$.result.v3Writes", true],
  ["plan", "memtax-create-plan", "$.result", true],
  ["distill", "memtax-distill", "$", false],
  ["leadAgentId", "gather", "$.result.leadAgentId", true],
];

const resultSummary = (r: any): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (!r || typeof r !== "object") return out;
  for (const [k, v] of Object.entries(r)) {
    if (Object.keys(out).length >= 24) break;
    if (typeof v === "boolean" || typeof v === "number") out[k] = v;
    else if (typeof v === "string" && v.length <= 160) out[k] = v;
    else if (Array.isArray(v)) out[`${k}Count`] = v.length;
  }
  return out;
};

// Key-sorted JSON, so the hash does not depend on the key order a KV round trip returns.
const stableJson = (v: any): string =>
  Array.isArray(v)
    ? `[${v.map((x) => (x === undefined ? "null" : stableJson(x))).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .filter((k) => v[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
          .join(",")}}`
      : (JSON.stringify(v) ?? "null");
const resultSha256 = async (r: unknown): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(r)))))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

async function fromRun(a: any, ctx: ScriptContext): Promise<any> {
  const runId = typeof a.runId === "string" ? a.runId.trim() : "";
  const key = `result:${runId}:${RUN_NODE}`;
  const flag = a.loadResult === true ? "loadResult" : "fromRun";
  if (!runId) return { ok: false, [flag]: true, error: `${flag} needs runId` };
  const stored: any = (await ctx.swarm.kv_getOrNull({ namespace: NS, key }))?.value;
  const have = stored && stored.runId === runId && stored.node === RUN_NODE;
  if (a.loadResult === true) {
    if (!have) return { ok: false, loadResult: true, error: `no stored ${RUN_NODE} result for run ${runId}: the Lead step did not run the script, or it failed` };
    // Any agent can write namespace dreaming-v2, so the KV entry alone proves nothing. Return it only when its hash
    // equals the sha256 the Lead step returned, which the engine recorded as the `<node>-lead` step output.
    const lead = rows(
      await ctx.swarm.db_query({
        sql: `SELECT json_extract(output, '$.taskOutput') o FROM workflow_run_steps WHERE runId = ? AND nodeId = ? AND status = 'completed' ORDER BY startedAt DESC LIMIT 1`,
        params: [runId, `${RUN_NODE}-lead`],
      }),
    );
    let pointer: any = lead[0]?.o;
    if (typeof pointer === "string") {
      try {
        pointer = JSON.parse(pointer);
      } catch {
        pointer = null;
      }
    }
    const want = pointer && typeof pointer.sha256 === "string" ? pointer.sha256 : "";
    if (!want) return { ok: false, loadResult: true, error: `the ${RUN_NODE}-lead step returned no result sha256; the stored ${RUN_NODE} result is not trusted` };
    if ((await resultSha256(stored.result)) !== want) return { ok: false, loadResult: true, error: `the stored ${RUN_NODE} result does not match the sha256 the ${RUN_NODE}-lead step returned; refusing it` };
    return stored.result;
  }
  // One write per run and node: a repeated Lead call returns the first result's pointer. It carries no sha256: an
  // entry this call did not write may be forged, so loadResult refuses it instead of returning it.
  if (have) return { ok: false, fromRun: true, alreadyRan: true, stored: { namespace: NS, key }, error: `a ${RUN_NODE} result for run ${runId} was already stored; nothing written`, summary: resultSummary(stored.result) };
  const args: any = { ...a };
  delete args.fromRun;
  delete args.loadResult;
  if (RUN_MODE) args.mode = RUN_MODE;
  if (args.writeBudgetMs === undefined) args.writeBudgetMs = 20000;
  const missing: string[] = [];
  for (const [arg, nodeId, path, required] of RUN_PATHS) {
    if (args[arg] !== undefined) continue;
    const r = rows(
      await ctx.swarm.db_query({
        sql: `SELECT json_type(output, ?) t, json_extract(output, ?) v FROM workflow_run_steps WHERE runId = ? AND nodeId = ? ORDER BY startedAt DESC LIMIT 1`,
        params: [path, path, runId, nodeId],
      }),
    );
    if (!r.length) {
      if (required && !missing.includes(nodeId)) missing.push(nodeId);
      args[arg] = "";
      continue;
    }
    const t = r[0].t;
    args[arg] = t === "true" ? true : t === "false" ? false : t === "object" || t === "array" ? JSON.parse(r[0].v) : t == null || t === "null" ? "" : r[0].v;
  }
  if (missing.length) return { ok: false, fromRun: true, error: `run ${runId} has no recorded step ${missing.join(", ")}; nothing written`, missing };
  const result: any = await runScript(args, ctx);
  try {
    await ctx.swarm.kv_set({ namespace: NS, key, value: { runId, node: RUN_NODE, at: new Date().toISOString(), result } as any });
  } catch (e: any) {
    return { ok: false, fromRun: true, error: `ran, but storing ${key} failed: ${String(e?.message ?? e).slice(0, 200)}`, summary: resultSummary(result) };
  }
  // Hash the JSON form KV stores. loadResult checks the stored entry against this value from the Lead step output.
  const sha256 = await resultSha256(JSON.parse(JSON.stringify(result ?? null)));
  return { ok: result?.ok !== false, fromRun: true, stored: { namespace: NS, key }, sha256, summary: resultSummary(result) };
}

/** Dreaming lane B: guarded long-term memory docs (create, edit, tidy), rollback and controls; fromRun / loadResult for apply. */
export default async function (args: unknown, ctx: ScriptContext) {
  const a: any = args ?? {};
  if (a.fromRun === true || a.loadResult === true) {
    try {
      return await fromRun(a, ctx);
    } catch (e: any) {
      return { ok: false, fromRun: a.fromRun === true, loadResult: a.loadResult === true, error: String(e?.message ?? e).slice(0, 300) };
    }
  }
  return runScript(args, ctx);
}
