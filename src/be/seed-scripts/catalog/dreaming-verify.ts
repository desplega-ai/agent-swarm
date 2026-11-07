import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming-v2 node 10: independent re-check of every lane's claims, unclaimed-write scan,
// survival of the previous run's writes, per-node metrics, and the ledger (live only).
// Spec: agent-fs dreaming-v2/design.md section 2, node 10. Never throws.

export const argsSchema = z.object({
  runId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  since: z.string().optional(),
  leadAgentId: z.string().optional(),
  synth: z.unknown().optional(),
  apply: z.unknown().optional(),
  skills: z.unknown().optional(),
  scriptify: z.unknown().optional(),
  trim: z.unknown().optional(),
  // v6: lane C claim (hb-apply result).
  hb: z.unknown().optional(),
  wfSnapshot: z.unknown().optional(),
  // Replay a finished run: live checks, but no ledger / last-run / wf-snapshot writes.
  replay: z.union([z.boolean(), z.string()]).optional(),
  // Survival baseline override (replay only; last-run already points at the replayed run).
  prevRunId: z.string().optional(),
  // Replay only: synthetic ledger items, classified against the live DB and returned as syntheticSurvival.
  survivalItems: z.array(z.unknown()).optional(),
  // dryRun/replay only: read memory content plain (scrubbed) instead of hex. Negative control, never live.
  legacyRead: z.union([z.boolean(), z.string()]).optional(),
});

const NS = "dreaming-v2";
const AUTO_MEMORY_SOURCES = ["task_completion", "session_summary", "file_index"];
const LANES = ["skillify", "skill-refactor", "scriptify", "identity", "memory"];
const FIELD: Record<string, string> = {
  SOUL: "soulMd",
  IDENTITY: "identityMd",
  CLAUDE: "claudeMd",
  TOOLS: "toolsMd",
  HEARTBEAT: "heartbeatMd",
};

// ---- memory-edit guards (same block in dreaming-apply). Run ed569231 A12: synthesis put the edit
// instruction ("APPEND to the end of the existing text (keep everything above): ...") in `content`
// and apply wrote it as the whole body (3857 -> 392 chars). `content` is a body, never an instruction.
const EDIT_INSTRUCTION =
  /^[\s*_#>`"'(\[-]*(append|prepend|replace|insert)\b[^\n]{0,80}?\b(existing\s+(text|body|content|memory|section|paragraph)|above|below|(the\s+)?end\s+of|(the\s+)?(top|beginning|start)\s+of)\b/i;
const KEEP_ABOVE = /keep\s+everything\s+(above|below)/i;
export function editMode(act: any): string {
  const m = act?.mode ?? act?.target?.mode;
  return m === undefined || m === null || m === "" ? "replace" : String(m);
}
// allowShrink counts only with a reason: "<reason>" or { reason: "<reason>" }.
export function shrinkReason(act: any): string {
  const s = act?.allowShrink;
  const r = typeof s === "string" ? s : s && typeof s === "object" ? s.reason : "";
  return typeof r === "string" ? r.trim() : "";
}
export function memEditBody(pre: string, content: string, mode: string): string {
  return mode === "append" ? `${pre.trimEnd()}\n${content}` : content;
}
export function memEditDefects(e: { pre: string; next: string; mode: string; shrinkReason?: string }): string[] {
  const d: string[] = [];
  let added = e.next;
  if (e.mode === "append") {
    const head = `${e.pre.trimEnd()}\n`;
    if (!e.next.startsWith(head)) d.push("append: new body does not start with the pre-image");
    else added = e.next.slice(head.length);
  } else if (e.mode !== "replace") d.push(`unknown mode: ${e.mode}`);
  if (EDIT_INSTRUCTION.test(added)) d.push(`instruction-text: content starts with an edit instruction ("${added.trim().slice(0, 60)}")`);
  if (KEEP_ABOVE.test(added)) d.push('instruction-text: content contains "keep everything above"');
  if (e.mode === "replace" && e.next.length < 0.5 * e.pre.length && !e.shrinkReason)
    d.push(`shrink: ${e.pre.length} -> ${e.next.length} chars (<50% of the pre-image) without allowShrink reason`);
  return d;
}

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

function parseObj(v: unknown): any {
  if (v && typeof v === "object") return v;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      return JSON.parse(v);
    } catch {}
  }
  return null;
}
const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");

// Every ctx.swarm response passes the secret scrubber, which rewrites secret-looking `key=value` text to
// `[REDACTED:<key>]`. Apply's memory pre-images and afterSha hold stored bytes, so current memory content
// is read as hex(...) and decoded here; a plain read would raise false alarms on a secret-shaped memory.
const MARK = "[REDACTED:";
const markers = (s: string) => String(s ?? "").split(MARK).length - 1;
const decodeHex = (hx: unknown) =>
  new TextDecoder().decode(new Uint8Array((String(hx ?? "").match(/../g) ?? []).map((h) => parseInt(h, 16))));
// Stored bytes of a pre-image row: contentHex when present (rows apply wrote before the sweep covered pre-images),
// else `content`. Memory pre-images are read as hex(...) of the kv row (readPreimage), so `content` is stored bytes.
const preBody = (m: any) => (typeof m?.contentHex === "string" && m.contentHex ? decodeHex(m.contentHex) : String(m?.content ?? ""));
// One memory-edit claim against its pre-image: memEditDefects plus apply's afterSha.
async function editClaimDefects(preBody: string, next: string, mode: string, shrink: string, afterSha: unknown) {
  const defects = memEditDefects({ pre: preBody, next, mode, shrinkReason: shrink });
  const nextSha = await sha(next);
  if (afterSha && nextSha !== afterSha) defects.push(`sha now ${nextSha.slice(0, 12)}, apply claimed ${String(afterSha).slice(0, 12)} (may be a later concurrent edit)`);
  return defects;
}

// Does the profile field still carry a previous run's identity edit?
// One skills-lane claim against the re-read row: null when version and sha match, else the mismatch detail.
export function skillClaimDetail(version: unknown, cSha: string, r: any): string | null {
  const vOk = r.versionAfter === undefined || Number(version) === Number(r.versionAfter);
  const hOk = !r.contentSha256 || cSha === r.contentSha256;
  return vOk && hOk ? null : `version ${version} vs ${r.versionAfter}; sha ${cSha.slice(0, 12)} vs ${String(r.contentSha256 ?? "").slice(0, 12)}`;
}
function renameEditControls() {
  const edit = { actionId: "E", kind: "memory-edit", target: { memoryIds: ["m1"] } };
  const ren = { actionId: "R", kind: "memory-rename", target: { memoryIds: ["m0", "m1"], name: "new-name" } };
  const cases: Array<[string, string, any[], string | null]> = [
    ["edit then rename of the same id -> resolves", "m1", [edit, ren], "R"],
    ["edit target deleted, no rename -> missing", "m1", [edit, { actionId: "D", kind: "memory-delete", target: { memoryIds: ["m1"] } }], null],
    ["rename of another id -> missing", "m2", [edit, ren], null],
  ];
  const results = cases.map(([name, id, items, want]) => ({ name, ok: (renamedBy(id, items)?.actionId ?? null) === want }));
  return { ok: results.every((r) => r.ok), results };
}
// v11: the memory-rename in `items` (same run's applied list or ledger) that re-stored memory `id`, or null.
export function renamedBy(id: string, items: any[]): any | null {
  return items.find((x: any) => x?.kind === "memory-rename" && Array.isArray(x.target?.memoryIds) && x.target.memoryIds.includes(id)) ?? null;
}
function identityPresent(body: string, it: any): boolean {
  if (it.target?.op === "remove-section") return !body.split(/\r?\n/).some((l) => l.trim() === String(it.target?.anchor ?? "").trim());
  if (it.target?.op === "replace-exact" && !String(it.content ?? "").trim()) return !body.includes(String(it.section ?? ""));
  return body.includes(String(it.content ?? "").trim());
}

// Survival class of one previous-run write. Order matters: a deleted row or a return to the
// preimage is a revert even if a trim also touched the field; a trim that removed the content
// is 'trimmed'; any other change after apply is 'drifted'. Only 'reverted' is a defect.
export type SurvivalEnv = { exists: boolean; present: boolean; currentSha: string | null; preimageSha: string | null; trimmedBy: any | null };
export function classifySurvival(e: SurvivalEnv): "survived" | "trimmed" | "drifted" | "reverted" {
  if (!e.exists) return "reverted";
  if (e.present) return "survived";
  if (e.preimageSha && e.currentSha === e.preimageSha) return "reverted";
  if (e.trimmedBy) return "trimmed";
  return "drifted";
}

// Positive and negative control per class, run on every call so the result carries its own proof.
function survivalControls() {
  const base: SurvivalEnv = { exists: true, present: false, currentSha: "c", preimageSha: "p", trimmedBy: null };
  const cases: Array<[string, SurvivalEnv, string]> = [
    ["survived+", { ...base, present: true }, "survived"],
    ["trimmed+", { ...base, trimmedBy: { runId: "t" } }, "trimmed"],
    ["trimmed- (no trim on field)", base, "drifted"],
    ["drifted+", { ...base, currentSha: "x" }, "drifted"],
    ["drifted- (row deleted)", { ...base, exists: false }, "reverted"],
    ["reverted+ (back to preimage)", { ...base, currentSha: "p" }, "reverted"],
    ["reverted+ (back to preimage after a trim)", { ...base, currentSha: "p", trimmedBy: { runId: "t" } }, "reverted"],
    ["reverted+ (row deleted)", { ...base, exists: false, present: true }, "reverted"],
    ["reverted- (changed, not preimage)", { ...base, currentSha: "x", preimageSha: "p" }, "drifted"],
    ["reverted- (no preimage recorded)", { ...base, preimageSha: null }, "drifted"],
  ];
  const results = cases.map(([name, env, want]) => ({ name, want, got: classifySurvival(env) }));
  return { ok: results.every((r) => r.got === r.want), results };
}

// Same-run trim lineage: apply wrote applySha, a trim then took applySha as its beforeSha and wrote
// the current sha. That is one chain inside the run, not a concurrent edit.
export function trimLineage(agentId: string, field: string, applySha: string, currentSha: string, trims: any[]): any | null {
  return trims.find((t) => t?.agentId === agentId && t?.field === field && t?.beforeSha === applySha && t?.afterSha === currentSha) ?? null;
}

function lineageControls() {
  const t = [{ agentId: "a", field: "claudeMd", beforeSha: "x1", afterSha: "x2" }];
  const cases: Array<[string, boolean]> = [
    ["chain+ (trim before=apply after, current=trim after)", !!trimLineage("a", "claudeMd", "x1", "x2", t)],
    ["chain- (current moved past the trim)", !trimLineage("a", "claudeMd", "x1", "x3", t)],
    ["chain- (trim started from another sha)", !trimLineage("a", "claudeMd", "x0", "x2", t)],
    ["chain- (other field)", !trimLineage("a", "toolsMd", "x1", "x2", t)],
    ["chain- (other agent)", !trimLineage("b", "claudeMd", "x1", "x2", t)],
  ];
  const results = cases.map(([name, pass]) => ({ name, pass }));
  return { ok: results.every((r) => r.pass), results };
}

// v6 (dreaming v3, plan-v3 Revision 1 §0.1): lane C lineage. hb-apply wrote Lead heartbeatMd = afterSha (disk first,
// then DB). The lead-disk session's Stop hook posts the same bytes back (session_sync), and later Lead sessions edit the
// new file (self_edit). Those rows are the claim's own chain. A row back at beforeSha is a revert; afterSha never
// appearing means the write never landed.
const HB_CHAIN_SOURCES = ["self_edit", "session_sync"];
// A self_edit made from a pre-draft copy (stale disk, Bash write) keeps the chain unbroken but brings the old
// text back with a new hash. Length is the cheap tell: the draft cut ~73% of the file.
export function hbRegrown(claim: any, currentSha: string, currentChars?: number): boolean {
  const d = Number(claim?.draftChars);
  if (!Number.isFinite(d) || d <= 0 || typeof currentChars !== "number" || currentSha === claim?.afterSha) return false;
  return currentChars > Math.max(d * 1.25, d + 2000);
}
export function hbLineage(claim: any, versions: any[], currentSha: string, currentChars?: number): { verdict: "confirmed" | "claimMismatch"; detail: string; explained: string[] } {
  const explained: string[] = [];
  if (!claim?.afterSha) return { verdict: "claimMismatch", detail: "hb claim has no afterSha", explained };
  const i = versions.findIndex((v) => v?.contentHash === claim.afterSha);
  if (i < 0) return currentSha === claim.afterSha ? { verdict: "confirmed", detail: "db sha = afterSha (landing row outside window)", explained } : { verdict: "claimMismatch", detail: `afterSha ${String(claim.afterSha).slice(0, 12)} never landed`, explained };
  explained.push(String(versions[i].id));
  const after = versions.slice(i + 1);
  const back = after.find((v) => v?.contentHash === claim.beforeSha);
  if (back) return { verdict: "claimMismatch", detail: `reverted-to-before: ${back.changeSource} row ${back.id}`, explained };
  // Chain rows: the same bytes again, or a Lead session edit. Anything else stays unexplained (-> unclaimed).
  for (const v of after) if (v?.contentHash === claim.afterSha || HB_CHAIN_SOURCES.includes(v?.changeSource)) explained.push(String(v.id));
  if (hbRegrown(claim, currentSha, currentChars)) return { verdict: "claimMismatch", detail: `regrown: db ${currentChars} chars vs draft ${claim.draftChars} after ${after.length} later row(s)`, explained };
  return { verdict: "confirmed", detail: currentSha === claim.afterSha ? "db sha = afterSha" : `chain of ${after.length} later row(s)`, explained };
}
// A Lead heartbeatMd row is unexplained unless a Lead session wrote it (self_edit/session_sync) or a claim explains it.
export function hbRowUnclaimed(r: any, explained: Set<string>): boolean {
  return !HB_CHAIN_SOURCES.includes(r?.changeSource) && !explained.has(String(r?.id));
}
function hbControls() {
  const claim = { beforeSha: "b", afterSha: "a" };
  const chain = [
    { id: "1", contentHash: "a", changeSource: "lead_coaching" },
    { id: "2", contentHash: "a", changeSource: "session_sync" },
    { id: "3", contentHash: "c", changeSource: "self_edit" },
  ];
  const pos = hbLineage(claim, chain, "c");
  const ex = new Set(pos.explained);
  const cases: Array<[string, boolean]> = [
    ["hb+ hb-state fixture (write, session_sync, self_edit) -> no claimMismatch", pos.verdict === "confirmed" && chain.every((r) => !hbRowUnclaimed(r, ex))],
    ["hb- unexplained api heartbeatMd row -> unclaimed", hbRowUnclaimed({ id: "9", contentHash: "x", changeSource: "api" }, new Set())],
    ["hb- unexplained lead_coaching row after the chain -> unclaimed", (() => { const v = [...chain, { id: "4", contentHash: "d", changeSource: "lead_coaching" }]; const l = hbLineage(claim, v, "d"); return l.verdict === "confirmed" && hbRowUnclaimed(v[3], new Set(l.explained)); })()],
    ["hb- chain back to beforeSha -> claimMismatch", hbLineage(claim, [chain[0], { id: "5", contentHash: "b", changeSource: "session_sync" }], "b").verdict === "claimMismatch"],
    ["hb- afterSha never landed -> claimMismatch", hbLineage(claim, [], "z").verdict === "claimMismatch"],
    ["hb- self_edit chain regrown past the draft -> claimMismatch", hbLineage({ ...claim, draftChars: 1000 }, chain, "c", 5000).verdict === "claimMismatch"],
    ["hb+ self_edit chain near draft size -> confirmed", hbLineage({ ...claim, draftChars: 1000 }, chain, "c", 1100).verdict === "confirmed"],
    ["hb+ self_edit row with no claim -> not unclaimed", !hbRowUnclaimed({ id: "6", contentHash: "e", changeSource: "self_edit" }, new Set())],
  ];
  const results = cases.map(([name, pass]) => ({ name, pass }));
  return { ok: results.every((r) => r.pass), results };
}

function memEditControls() {
  const pre = "Dokploy trigger returns ok but the deployment lags.\n\n" + "Observed lag and the check that confirms the deploy landed. ".repeat(20);
  const para = "2026-10-09 recurrence, larger lag; the queue stalled overnight.";
  const rewrite = pre.replace("lags.", "lags by up to 40 minutes.");
  const cases: Array<[string, { pre: string; next: string; mode: string; shrinkReason?: string }, boolean]> = [
    ["A12 literal as replace -> defect", { pre, next: `APPEND to the end of the existing text (keep everything above): ${para}`, mode: "replace" }, true],
    ["instruction in an append tail -> defect", { pre, next: `${pre.trimEnd()}\nAppend to the end of the existing text: ${para}`, mode: "append" }, true],
    ["keep everything above mid-body -> defect", { pre, next: `${rewrite} (keep everything above)`, mode: "replace" }, true],
    ["replace to <50% -> defect", { pre, next: para, mode: "replace" }, true],
    ["append that drops the pre-image -> defect", { pre, next: `other\n${para}`, mode: "append" }, true],
    ["unknown mode -> defect", { pre, next: rewrite, mode: "merge" }, true],
    ["legit full rewrite -> ok", { pre, next: rewrite, mode: "replace" }, false],
    ["legit append -> ok", { pre, next: `${pre.trimEnd()}\n${para}`, mode: "append" }, false],
    ["shrink with reason -> ok", { pre, next: para, mode: "replace", shrinkReason: "dedup: body moved to a skill" }, false],
    ["body starting with Replace, no edit object -> ok", { pre, next: `Replace \`bun test\` with the isolated DB runner. ${rewrite}`, mode: "replace" }, false],
  ];
  const results = cases.map(([name, e, want]) => ({ name, pass: memEditDefects(e).length > 0 === want }));
  return { ok: results.every((r) => r.pass), results };
}

/** Dreaming verify: synthesis claims vs real writes, unclaimed writes, silent refusals, survival, run ledger. */
export default async function (args: unknown, ctx: ScriptContext) {
  const a: any = args ?? {};
  LEAD = await resolveLead(ctx, (args as any)?.leadAgentId);
  const errors: string[] = [];
  const dry = a.dryRun === true || a.dryRun === "true";
  const replay = a.replay === true || a.replay === "true";
  const runId = typeof a.runId === "string" ? a.runId : "";
  // Replay: fill any input the caller did not pass from the run's own recorded step outputs.
  if (replay && runId) {
    const paths: Array<[string, string, string]> = [
      ["since", "gather", "$.result.generatedAt"],
      ["synth", "synthesize", "$.taskOutput"],
      ["apply", "apply", "$.result"],
      ["skills", "skills", "$.taskOutput"],
      ["scriptify", "scriptify", "$.taskOutput"],
      ["trim", "trim-apply", "$.result"],
      ["hb", "hb-apply", "$.result"],
    ];
    for (const [arg, nodeId, path] of paths) {
      if (a[arg] !== undefined) continue;
      try {
        const r = rows(await ctx.swarm.db_query({ sql: `SELECT json_extract(output, ?) v FROM workflow_run_steps WHERE runId = ? AND nodeId = ?`, params: [path, runId, nodeId] }));
        if (r[0]?.v != null) a[arg] = r[0].v;
      } catch (e: any) {
        errors.push(`replay ${arg}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  }
  const since = typeof a.since === "string" && a.since ? a.since : new Date(Date.now() - 3 * 3600000).toISOString();
  // Timestamp columns are ISO-8601 (`...T...Z`); compare as strings so indexes stay usable.
  // julianday(col) forced a full scan of context_versions and hit db_query_timeout (run 6851ba61).
  const sinceMs = Date.parse(since);
  const sinceIso = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : since;
  // Replay ignores writes made after the replayed verify step ran.
  let untilIso = "9999";
  if (replay && runId) {
    try {
      const v = rows(await ctx.swarm.db_query({ sql: `SELECT startedAt FROM workflow_run_steps WHERE runId = ? AND nodeId = 'verify'`, params: [runId] }));
      if (v[0]?.startedAt) untilIso = String(v[0].startedAt);
    } catch (e: any) {
      errors.push(`replay until: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  const synth = parseObj(a.synth);
  const apply = parseObj(a.apply);
  const skills = parseObj(a.skills);
  const scriptify = parseObj(a.scriptify);
  const trim = parseObj(a.trim) ?? {};
  const hb = parseObj(a.hb);
  const wfSnapshot = parseObj(a.wfSnapshot);

  const q = async (label: string, sql: string, params: unknown[] = []): Promise<any[]> => {
    try {
      return rows(await ctx.swarm.db_query({ sql, params }));
    } catch (e: any) {
      errors.push(`${label}: ${String(e?.message ?? e).slice(0, 200)}`);
      return [];
    }
  };
  const legacyRead = (dry || replay) && (a.legacyRead === true || a.legacyRead === "true");
  // Current memory rows with `content` = stored bytes via hex (legacyRead: the scrubbed plain read).
  const readMemory = async (label: string, cols: string, memoryId: unknown) =>
    (await q(label, `SELECT ${cols}, content, hex(CAST(content AS BLOB)) AS hx FROM agent_memory WHERE id = ?`, [memoryId])).map(
      ({ hx, ...r }: any) => ({ ...r, content: legacyRead ? String(r.content ?? "") : decodeHex(hx) }),
    );
  // Memory pre-image value as stored: hex(...) of its kv row, so the bodies in it come back unscrubbed (legacyRead: the
  // plain kv read, scrubbed like readMemory's plain side).
  const readPreimage = async (label: string, key: string) => {
    if (legacyRead) {
      const p: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key });
      return parseObj(p?.value) ?? p?.value ?? null;
    }
    const r = await q(label, `SELECT hex(CAST(value AS BLOB)) AS hx FROM kv_entries WHERE namespace = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)`, [NS, key, Date.now()]);
    return r.length ? parseObj(decodeHex(r[0].hx)) : null;
  };
  // v11 (2026-10-18): skills.content is hashed from stored bytes too. The plain read is scrubbed, so a skill holding a
  // key=value shape never matched the lane's sha (run 2026-10-18: patch-global-script-safely v3 plain 265b8e05fe52,
  // stored 59e0099389e1, claimed 59e0099389e1).
  const readSkill = async (label: string, cols: string, skillId: unknown) =>
    (await q(label, `SELECT ${cols}, content, hex(CAST(content AS BLOB)) AS hx FROM skills WHERE id = ?`, [String(skillId ?? "")])).map(
      ({ hx, ...r }: any) => ({ ...r, plain: String(r.content ?? ""), content: legacyRead ? String(r.content ?? "") : decodeHex(hx) }),
    );
  // Pre-image body on the same side as readMemory (legacyRead: plain `content` on both sides).
  const preOf = (m: any) => (legacyRead ? String(m?.content ?? "") : preBody(m));
  // Read control, every run. A secret-looking memory gets an append edit, then is reverted to its pre-image. The
  // pre-image row is read as readPreimage reads it: hex of the kv value apply writes ({rows: [{content: stored}]}).
  // Positive: preBody(row) against the hex read: the edit claim is clean and the revert classifies as reverted.
  // Negatives, each must alarm: legacyRead (plain content on both sides: the scrubbed body fails apply's afterSha);
  // preImagePlain (scrubbed pre-image vs hex read: append prefix false alarm and the revert missed as drifted).
  const readControls = async () => {
    const c: any = { ok: false };
    try {
      const fx = "api" + "_key=sk-" + "fixture-9f8e7d6c5b4a39281706f5e4d3c2b1a0\nsecond line of the memory body";
      const nx = `${fx}\nthird line appended by the edit`;
      const kvValue = JSON.stringify({ rows: [{ content: fx }] });
      const p = (await q("readControl", `SELECT ? AS plain, hex(CAST(? AS BLOB)) AS hx, ? AS nplain, hex(CAST(? AS BLOB)) AS nhx, hex(CAST(? AS BLOB)) AS vhx`, [fx, fx, nx, nx, kvValue]))[0] ?? {};
      const hexRead = decodeHex(p.hx), plain = String(p.plain ?? "");
      // `row`: the hex kv read; `plainRow`: the same row through the scrubbed kv_get read.
      const row = parseObj(decodeHex(p.vhx))?.rows?.[0] ?? {};
      const plainRow = { content: plain };
      const roundTrip = hexRead === fx && decodeHex(p.nhx) === nx;
      const scrubberActive = plain !== fx && markers(plain) > 0;
      const nxSha = await sha(nx);
      // pre: pre-image body; edited: edit read back; reverted: read back after a revert to the pre-image.
      const verdict = async (pre: string, edited: string, reverted: string) => ({
        editDefects: (await editClaimDefects(pre, edited, "append", "", nxSha)).length,
        revert: classifySurvival({ exists: true, present: false, currentSha: await sha(reverted), preimageSha: await sha(pre), trimmedBy: null }),
      });
      const pb = preBody(row);
      const hv = await verdict(pb, decodeHex(p.nhx), hexRead);
      const lv = await verdict(String(plainRow.content), String(p.nplain ?? ""), plain);
      const mv = await verdict(String(plainRow.content), decodeHex(p.nhx), hexRead);
      c.positive = { fixture: "secret-looking key=value", preimage: "hex kv read of {rows: [{content}]}", roundTrip, scrubberActive, preIsStored: pb === fx, ...hv, ok: roundTrip && scrubberActive && pb === fx && hv.editDefects === 0 && hv.revert === "reverted" };
      c.legacyRead = { ...lv, ok: lv.editDefects > 0 };
      c.preImagePlain = { ...mv, ok: mv.editDefects > 0 && mv.revert !== "reverted" };
      // v11 skills lane: the fixture as a skill body claimed at its stored sha confirms on the hex read, mismatches on
      // the plain read (v10), and a bogus claim still flags.
      const claim = { versionAfter: 3, contentSha256: await sha(fx) };
      const hexSha = await sha(hexRead);
      c.skillRead = {
        hex: skillClaimDetail(3, hexSha, claim) ?? "confirmed",
        plainV10: skillClaimDetail(3, await sha(plain), claim) ?? "confirmed",
        bogus: skillClaimDetail(3, hexSha, { ...claim, contentSha256: "0".repeat(64) }) ?? "confirmed",
      };
      c.skillRead.ok = c.skillRead.hex === "confirmed" && c.skillRead.plainV10 !== "confirmed" && c.skillRead.bogus !== "confirmed";
      c.ok = c.positive.ok && c.legacyRead.ok && c.preImagePlain.ok && c.skillRead.ok;
    } catch (e: any) {
      c.error = String(e?.message ?? e).slice(0, 200);
    }
    return c;
  };
  const readControl = await readControls();

  // 0. Lane completeness: a lane whose gate routed to `run` must hand verify a result.
  // A missing result means the lane never ran or failed (run bcdfd5ea: trim-plan had
  // 3 targets, trim/trim-apply never executed, verify still said ok). Fail loudly.
  const missingLanes: any[] = [];
  if (runId) {
    const gateSteps = await q(
      "laneGates",
      `SELECT nodeId, status, json_extract(output, '$.port') port,
         json_array_length(json_extract(output, '$.result.targets')) nTargets
       FROM workflow_run_steps
       WHERE runId = ? AND nodeId IN ('synthesize', 'apply', 'skills-gate', 'scriptify-gate', 'trim-plan', 'hb-gate')
       ORDER BY startedAt`,
      [runId],
    );
    const gate = new Map<string, any>();
    for (const s of gateSteps) gate.set(s.nodeId, s);
    const lanes: Array<[string, boolean, unknown, string]> = [
      ["synthesize", !!gate.get("synthesize"), synth, "synthesize.taskOutput"],
      ["apply", !!synth, apply, "apply.result"],
      ["skills", gate.get("skills-gate")?.port === "run", skills, "skills.taskOutput"],
      ["scriptify", gate.get("scriptify-gate")?.port === "run", scriptify, "scriptify.taskOutput"],
      ["trim-apply", gate.get("trim-plan")?.status === "completed", parseObj(a.trim), "trim-apply.result"],
      ["hb-apply", gate.get("hb-gate")?.port === "run", hb, "hb-apply.result"],
    ];
    for (const [lane, expected, result, path] of lanes) {
      if (!expected || result) continue;
      const nTargets = lane === "trim-apply" ? Number(gate.get("trim-plan")?.nTargets ?? 0) : undefined;
      missingLanes.push({ lane, path, nTargets });
      errors.push(
        `lane-missing: ${lane} was due to run but ${path} is missing` +
          (nTargets !== undefined ? ` (trim-plan had ${nTargets} target(s))` : "") +
          "; the lane never ran or failed",
      );
    }
  }

  const claimMismatch: any[] = [];
  const unclaimed: any[] = [];
  const concurrent: any[] = [];
  const dryRunViolations: any[] = [];
  const confirmed: any[] = [];

  // This run's own tasks and the agents that ran them.
  const runTasks = runId ? await q("runTasks", `SELECT id, agentId, workflowRunStepId FROM agent_tasks WHERE workflowRunId = ?`, [runId]) : [];
  const taskIds = runTasks.map((t: any) => t.id);
  const runAgents = [...new Set([LEAD, ...runTasks.map((t: any) => t.agentId)])];

  // 1. Skills claims.
  const skillResults: any[] = Array.isArray(skills?.results) ? skills.results : [];
  const claimedSkillIds = new Set<string>();
  for (const r of skillResults) {
    if (r?.status !== "applied") continue;
    if (r.skillId) claimedSkillIds.add(String(r.skillId));
    const s = await readSkill("skillClaim", "version", r.skillId);
    if (!s.length) {
      claimMismatch.push({ actionId: r.actionId, lane: "skills", detail: "skill row missing" });
      continue;
    }
    const cSha = await sha(s[0].content);
    const detail = skillClaimDetail(s[0].version, cSha, r);
    if (!detail) confirmed.push({ actionId: r.actionId, lane: "skills", skillId: r.skillId, version: Number(s[0].version), contentSha256: cSha });
    else claimMismatch.push({ actionId: r.actionId, lane: "skills", detail });
  }

  // Apply claims are re-checked against the database, not trusted.
  const applied: any[] = Array.isArray(apply?.applied) ? apply.applied : [];
  const trimApplied: any[] = [...(Array.isArray(trim.applied) ? trim.applied : []), ...(Array.isArray(trim.reapplied) ? trim.reapplied.filter((x: any) => x?.ok) : [])];
  const claimedProfile = new Set<string>();
  const claimedMemoryIds = new Set<string>();
  const claimedMemoryNames = new Set<string>();
  for (const it of applied) {
    if (it.kind === "identity") {
      const field = FIELD[it.target?.file] ?? "";
      claimedProfile.add(`${it.target?.agentId}:${field}`);
      const r = field ? await q("identityClaim", `SELECT ${field} AS body FROM agents WHERE id = ?`, [it.target?.agentId]) : [];
      const s = await sha(String(r[0]?.body ?? ""));
      const viaTrim = it.afterSha && s !== it.afterSha ? trimLineage(it.target?.agentId, field, it.afterSha, s, trimApplied) : null;
      if (it.afterSha && s === it.afterSha) confirmed.push({ actionId: it.actionId, lane: "identity" });
      else if (viaTrim) confirmed.push({ actionId: it.actionId, lane: "identity", note: `then trimmed in this run ${String(it.afterSha).slice(0, 12)} -> ${s.slice(0, 12)}` });
      else concurrentOrMismatch(it, s);
    } else if (it.kind === "memory-store") {
      claimedMemoryNames.add(String(it.target?.name));
      const r = await q("storeClaim", `SELECT COUNT(*) n FROM agent_memory WHERE name = ?`, [it.target?.name]);
      if (Number(r[0]?.n) === 1) confirmed.push({ actionId: it.actionId, lane: "memory" });
      else claimMismatch.push({ actionId: it.actionId, lane: "memory", detail: `COUNT(name)=${r[0]?.n}` });
    } else if (it.kind === "memory-rename") {
      claimedMemoryNames.add(String(it.target?.name));
      const ids: string[] = it.target?.memoryIds ?? [];
      ids.forEach((x) => claimedMemoryIds.add(x));
      const n = await q("renameClaim", `SELECT COUNT(*) n FROM agent_memory WHERE name = ? AND COALESCE(chunkIndex, 0) = 0`, [it.target?.name]);
      const o = ids.length ? await q("renameOld", `SELECT COUNT(*) n FROM agent_memory WHERE id IN (${inList(ids.length)})`, ids) : [];
      if (Number(n[0]?.n) === 1 && Number(o[0]?.n ?? 0) === 0) confirmed.push({ actionId: it.actionId, lane: "memory" });
      else claimMismatch.push({ actionId: it.actionId, lane: "memory", detail: `rename: new name rows ${n[0]?.n}, old rows ${o[0]?.n}` });
    } else if (it.kind === "memory-delete" || it.kind === "memory-edit") {
      const ids: string[] = it.target?.memoryIds ?? [];
      ids.forEach((x) => claimedMemoryIds.add(x));
      if (it.kind === "memory-delete") {
        const r = ids.length ? await q("deleteClaim", `SELECT COUNT(*) n FROM agent_memory WHERE id IN (${inList(ids.length)})`, ids) : [];
        if (Number(r[0]?.n ?? 0) === 0) confirmed.push({ actionId: it.actionId, lane: "memory" });
        else claimMismatch.push({ actionId: it.actionId, lane: "memory", detail: `${r[0]?.n} rows still present` });
      } else {
        // Judge the edit against its KV pre-image, not against apply's own claim (A12 passed "re-read equals new").
        const preKey = String(it.preimageKey ?? `preimage:${runId}:${it.actionId}`);
        let pre: any = null;
        try {
          pre = await readPreimage("editPreimage", preKey);
        } catch (e: any) {
          errors.push(`editPreimage ${preKey}: ${String(e?.message ?? e).slice(0, 200)}`);
        }
        const preRow = Array.isArray(pre?.rows) ? pre.rows.find((x: any) => x?.id === ids[0]) ?? pre.rows[0] : null;
        let cur: any[] = ids.length ? await readMemory("editClaim", "id", ids[0]) : [];
        // v11 (2026-10-18): a later rename in this run re-stores the edited row under new ids (run 2026-10-18: A19
        // edited f853fa33, A20 renamed it to 0fb226ed, sha = A19's afterSha, yet "row missing"). Judge the edit by
        // the bytes the rename read (its pre-image row), or by the new name's single row when that pre-image is gone.
        const ren = !cur.length && ids.length ? renamedBy(ids[0]!, applied) : null;
        let via = "";
        if (ren) {
          const rKey = String(ren.preimageKey ?? `preimage:${runId}:${ren.actionId}`);
          let rp: any = null;
          try {
            rp = await readPreimage("renamePreimage", rKey);
          } catch (e: any) {
            errors.push(`renamePreimage ${rKey}: ${String(e?.message ?? e).slice(0, 200)}`);
          }
          const rRow = Array.isArray(rp?.rows) ? rp.rows.find((x: any) => x?.id === ids[0]) : null;
          const nr = await q("editRenamed", `SELECT id, content, hex(CAST(content AS BLOB)) AS hx FROM agent_memory WHERE name = ? ORDER BY chunkIndex`, [String(ren.target?.name ?? "")]);
          if (nr.length && typeof rRow?.content === "string") cur = [{ id: ids[0], content: preOf(rRow) }];
          else if (nr.length === 1) cur = [{ id: nr[0].id, content: legacyRead ? String(nr[0].content ?? "") : decodeHex(nr[0].hx) }];
          if (cur.length) via = ` via rename ${ren.actionId} to ${ren.target?.name} (${nr.map((r: any) => r.id).join(",")})`;
        }
        if (typeof preRow?.content !== "string") claimMismatch.push({ actionId: it.actionId, lane: "memory", detail: `memory-edit pre-image missing at ${preKey}` });
        else if (!cur.length) claimMismatch.push({ actionId: it.actionId, lane: "memory", detail: `memory-edit row ${ids[0]} missing${ren ? ` (renamed by ${ren.actionId}, new name ${ren.target?.name} unreadable)` : ""}` });
        else {
          const preText = preOf(preRow);
          const next = String(cur[0].content ?? "");
          const mode = String(it.mode ?? pre?.mode ?? "replace");
          const defects = await editClaimDefects(preText, next, mode, shrinkReason(it) || shrinkReason(pre), it.afterSha);
          if (defects.length) claimMismatch.push({ actionId: it.actionId, lane: "memory", kind: "memory-edit", memoryId: ids[0], preChars: preText.length, nowChars: next.length, detail: defects.join("; ") });
          else confirmed.push({ actionId: it.actionId, lane: "memory", note: `edit (${mode}) checked against pre-image: ${preText.length} -> ${next.length} chars${via}` });
        }
      }
    }
  }
  function concurrentOrMismatch(it: any, s: string) {
    claimMismatch.push({ actionId: it.actionId, lane: "identity", detail: `field sha now ${s.slice(0, 12)}, apply claimed ${String(it.afterSha ?? "").slice(0, 12)} (may be a later concurrent edit)` });
  }
  // Trim claims: every trimmed or re-applied field must re-read to its claimed sha.
  for (const it of trimApplied) {
    claimedProfile.add(`${it.agentId}:${it.field}`);
    if (!it.afterSha) {
      confirmed.push({ lane: "trim", agentId: it.agentId, field: it.field, note: "re-applied (trim-apply re-read)" });
      continue;
    }
    const f = Object.values(FIELD).includes(it.field) ? it.field : "NULL";
    const r = await q("trimClaim", `SELECT ${f} AS body FROM agents WHERE id = ?`, [it.agentId]);
    const s2 = await sha(String(r[0]?.body ?? ""));
    if (s2 === it.afterSha) confirmed.push({ lane: "trim", agentId: it.agentId, field: it.field });
    else claimMismatch.push({ lane: "trim", agentId: it.agentId, field: it.field, detail: `sha now ${s2.slice(0, 12)}, trim claimed ${String(it.afterSha).slice(0, 12)}` });
  }
  for (const m of Array.isArray(trim.memories) ? trim.memories : []) if (m?.name) claimedMemoryNames.add(String(m.name));
  // Lane C claim: lineage over Lead heartbeatMd versions since the run's gather.
  const hbExplained = new Set<string>();
  let hbVerdict: any = null;
  const hbWrote = typeof hb?.status === "string" && hb.status.startsWith("applied");
  if (hbWrote) {
    const vs = await q(
      "hbVersions",
      `SELECT id, contentHash, changeSource, changedByAgentId, createdAt FROM context_versions
       WHERE agentId = ? AND field = 'heartbeatMd' AND createdAt >= ? AND createdAt <= ? ORDER BY createdAt, version LIMIT 200`,
      [LEAD, sinceIso, untilIso],
    );
    const cur = await q("hbCurrent", `SELECT heartbeatMd AS body FROM agents WHERE id = ?`, [LEAD]);
    const curBody = String(cur[0]?.body ?? "");
    hbVerdict = hbLineage(hb, vs.filter((v: any) => v.createdAt <= untilIso), await sha(curBody), curBody.length);
    hbVerdict.explained.forEach((x: string) => hbExplained.add(x));
    if (hbVerdict.verdict === "confirmed") confirmed.push({ lane: "heartbeat", status: hb.status, note: hbVerdict.detail });
    else claimMismatch.push({ lane: "heartbeat", status: hb.status, detail: hbVerdict.detail });
    for (const m of Array.isArray(hb.memories) ? hb.memories : []) if (m?.name) claimedMemoryNames.add(String(m.name));
    if (dry) dryRunViolations.push({ kind: "hb-claimed-write", status: hb.status });
  }
  if (dry) for (const it of trimApplied) dryRunViolations.push({ kind: "trim-claimed-write", agentId: it.agentId, field: it.field });
  if (dry) for (const it of applied) dryRunViolations.push({ kind: "apply-claimed-write", actionId: it.actionId });
  if (dry) for (const r of skillResults) if (r?.status === "applied") dryRunViolations.push({ kind: "skills-claimed-write", actionId: r.actionId });

  // 2. Unclaimed writes since `since`.
  const cv = await q(
    "profileWrites",
    `SELECT id, agentId, field, changeSource, changedByAgentId, createdAt FROM context_versions
     WHERE agentId IN (${inList(runAgents.length)}) AND createdAt >= ?`,
    [...runAgents, sinceIso],
  );
  for (const r of cv) {
    if (r.createdAt > untilIso) continue;
    const key = `${r.agentId}:${r.field}`;
    if (claimedProfile.has(key)) continue;
    if (r.agentId === LEAD && r.field === "heartbeatMd") {
      // v5 put every Lead heartbeat row in concurrent, so a DB-side heartbeat write was invisible.
      const item = { table: "context_versions", id: r.id, agentId: r.agentId, field: r.field, changeSource: r.changeSource, createdAt: r.createdAt };
      if (hbRowUnclaimed(r, hbExplained)) {
        unclaimed.push(item);
        if (dry) dryRunViolations.push({ kind: "profile-write", ...item });
      } else concurrent.push(item);
      continue;
    }
    const leadOnOther = r.agentId !== LEAD && (r.changedByAgentId === LEAD || r.changeSource === "lead_coaching");
    const item = { table: "context_versions", id: r.id, agentId: r.agentId, field: r.field, changeSource: r.changeSource, createdAt: r.createdAt };
    if (leadOnOther) {
      unclaimed.push(item);
      if (dry) dryRunViolations.push({ kind: "profile-write", ...item });
    } else concurrent.push(item);
  }
  const sk = await q(
    "skillWrites",
    `SELECT id, name, version, systemDefault, lastUpdatedAt FROM skills WHERE lastUpdatedAt >= ?`,
    [sinceIso],
  );
  for (const r of sk) {
    if (claimedSkillIds.has(r.id) || r.lastUpdatedAt > untilIso) continue;
    const item = { table: "skills", id: r.id, name: r.name, version: r.version, lastUpdatedAt: r.lastUpdatedAt };
    if (Number(r.systemDefault)) {
      concurrent.push({ ...item, note: "systemDefault (deploy sync)" });
      continue;
    }
    unclaimed.push(item);
    if (dry) dryRunViolations.push({ kind: "skill-write", ...item });
  }
  const memTaskClause = taskIds.length ? `OR (sourceTaskId IN (${inList(taskIds.length)}) AND source NOT IN (${inList(AUTO_MEMORY_SOURCES.length)}))` : "";
  const mw = await q(
    "memoryWrites",
    `SELECT id, name, source, sourceTaskId, createdAt, updatedAt FROM agent_memory
     WHERE (createdAt >= ? OR updatedAt >= ?)
       AND ((tags GLOB '*"dreaming-v2"*') ${memTaskClause})`,
    [sinceIso, sinceIso, ...(taskIds.length ? [...taskIds, ...AUTO_MEMORY_SOURCES] : [])],
  );
  for (const r of mw) {
    if (claimedMemoryIds.has(r.id) || claimedMemoryNames.has(r.name)) continue;
    if (!(r.createdAt >= sinceIso && r.createdAt <= untilIso) && r.updatedAt > untilIso) continue;
    const item = { table: "agent_memory", id: r.id, name: r.name, source: r.source, sourceTaskId: r.sourceTaskId };
    unclaimed.push(item);
    if (dry) dryRunViolations.push({ kind: "memory-write", ...item });
  }
  // KV pre-images / receipts for this run (skills lane must not kv-set in dry run).
  if (dry && runId) {
    for (const prefix of [`preimage:${runId}:`, `applied:${runId}:`, `trim-preimage:${runId}:`, `owners:${runId}:`, `hb-preimage:${runId}`, `hb-state:${runId}`, `cuts:${runId}:`]) {
      try {
        const res: any = await ctx.swarm.kv_list({ namespace: NS, prefix, limit: 50 });
        const entries: any[] = res?.data?.entries ?? res?.entries ?? [];
        for (const e of entries) dryRunViolations.push({ kind: "kv-write", key: e.key });
      } catch (e: any) {
        errors.push(`kv_list ${prefix}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
  }

  // 3. Survival of the previous run's applied items.
  // trimmed / drifted are expected later rewrites and do not fail the run; reverted does.
  const survival = { prevRunId: null as string | null, checked: 0, survived: 0, trimmed: [] as any[], drifted: [] as any[], reverted: [] as any[] };
  const syntheticSurvival = { prevRunId: null as string | null, checked: 0, survived: 0, trimmed: [] as any[], drifted: [] as any[], reverted: [] as any[] };
  const controls: any = { survival: survivalControls(), lineage: lineageControls(), hb: hbControls(), memEdit: memEditControls(), renameEdit: renameEditControls(), read: readControl };
  controls.ok = controls.survival.ok && controls.lineage.ok && controls.hb.ok && controls.memEdit.ok && controls.renameEdit.ok && controls.read.ok;
  try {
    const last: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key: "last-run" });
    const prev = replay && typeof a.prevRunId === "string" && a.prevRunId ? a.prevRunId : last?.value ? String(last.value) : "";
    if (prev && prev !== runId) {
      survival.prevRunId = prev;
      const led: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key: `ledger:${prev}` });
      const items: any[] = led?.value?.applied ?? [];
      // Every trim since the previous run started (its own trim-apply included), oldest first.
      const trims = await q(
        "survivalTrims",
        `SELECT s.runId, s.startedAt, json_extract(j.value, '$.agentId') agentId, json_extract(j.value, '$.field') field,
           json_extract(j.value, '$.beforeSha') beforeSha, json_extract(j.value, '$.afterSha') afterSha
         FROM workflow_runs r JOIN workflow_run_steps s ON s.runId = r.id, json_each(s.output, '$.result.applied') j
         WHERE r.workflowId = (SELECT workflowId FROM workflow_runs WHERE id = ?)
           AND r.startedAt >= (SELECT startedAt FROM workflow_runs WHERE id = ?)
           AND s.nodeId = 'trim-apply' AND s.status = 'completed'
         ORDER BY s.startedAt`,
        [prev, prev],
      );
      const preimage = async (it: any) => {
        if (replay && it.syntheticPreimage) return it.syntheticPreimage;
        if (!it.preimageKey) return null;
        const p: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key: String(it.preimageKey) });
        return p?.value ?? null;
      };
      // The trim that removed this item's content: the field held it at the trim's beforeSha and lost it at afterSha.
      const findTrim = async (it: any, agentId: string, field: string) => {
        for (const t of trims.filter((x: any) => x.agentId === agentId && x.field === field)) {
          const v = await q(
            "survivalTrimVersions",
            `SELECT contentHash, content FROM context_versions WHERE agentId = ? AND field = ? AND contentHash IN (?, ?)`,
            [agentId, field, t.beforeSha, t.afterSha],
          );
          const before = v.find((x: any) => x.contentHash === t.beforeSha);
          const after = v.find((x: any) => x.contentHash === t.afterSha);
          if (before && after && identityPresent(String(before.content ?? ""), it) && !identityPresent(String(after.content ?? ""), it))
            return { runId: t.runId, at: t.startedAt, beforeSha: String(t.beforeSha).slice(0, 12), afterSha: String(t.afterSha).slice(0, 12) };
        }
        return null;
      };
      const checkItems = async (items: any[], out: typeof survival) => {
      for (const it of items) {
        out.checked++;
        let env: SurvivalEnv = { exists: true, present: false, currentSha: null, preimageSha: null, trimmedBy: null };
        if (it.kind === "identity") {
          const field = FIELD[it.target?.file] ?? "";
          const r = field ? await q("survivalProfile", `SELECT ${field} AS body FROM agents WHERE id = ?`, [it.target?.agentId]) : [];
          const body = String(r[0]?.body ?? "");
          const present = r.length > 0 && identityPresent(body, it);
          env = { exists: r.length > 0, present, currentSha: await sha(body), preimageSha: null, trimmedBy: null };
          if (!present && r.length) {
            env.preimageSha = (await preimage(it))?.sha256 ?? null;
            env.trimmedBy = await findTrim(it, String(it.target?.agentId), field);
          }
        } else if (it.kind === "memory-store") {
          const r = await q("survivalStore", `SELECT COUNT(*) n FROM agent_memory WHERE name = ?`, [it.target?.name]);
          env = { ...env, exists: Number(r[0]?.n) > 0, present: Number(r[0]?.n) === 1 };
        } else if (it.kind === "memory-delete") {
          // The preimage of a delete is the rows existing: any of them back is a revert.
          const ids: string[] = it.target?.memoryIds ?? [];
          const r = ids.length ? await q("survivalDelete", `SELECT COUNT(*) n FROM agent_memory WHERE id IN (${inList(ids.length)})`, ids) : [];
          const back = Number(r[0]?.n ?? 0) > 0;
          env = { ...env, present: !back, currentSha: back ? "rows-present" : "rows-absent", preimageSha: "rows-present" };
        } else if (it.kind === "memory-rename") {
          // v4 had no branch here, so every rename landed in reverted. Preimage = the old ids existing.
          const ids: string[] = it.target?.memoryIds ?? [];
          const n = await q("survivalRename", `SELECT COUNT(*) n FROM agent_memory WHERE name = ? AND COALESCE(chunkIndex, 0) = 0`, [it.target?.name]);
          const o = ids.length ? await q("survivalRenameOld", `SELECT COUNT(*) n FROM agent_memory WHERE id IN (${inList(ids.length)})`, ids) : [];
          const oldBack = Number(o[0]?.n ?? 0) > 0;
          env = { ...env, exists: Number(n[0]?.n) > 0, present: Number(n[0]?.n) === 1 && !oldBack, currentSha: oldBack ? "old-present" : "old-absent", preimageSha: "old-present" };
        } else if (it.kind === "memory-edit") {
          const r = await readMemory("survivalEdit", "contentHash", it.target?.memoryIds?.[0]);
          // v11: renamed in the same run: the edit lives on while the rename's new name does (its own item checks the rows).
          const ren = r.length ? null : renamedBy(String(it.target?.memoryIds?.[0] ?? ""), items);
          if (ren) {
            const n = await q("survivalEditRenamed", `SELECT COUNT(*) n FROM agent_memory WHERE name = ? AND COALESCE(chunkIndex, 0) = 0`, [ren.target?.name]);
            env = { ...env, exists: Number(n[0]?.n) > 0, present: Number(n[0]?.n) === 1 };
            const cls = classifySurvival(env);
            if (cls === "survived") out.survived++;
            else out[cls].push({ actionId: it.actionId, kind: it.kind, renamedBy: ren.actionId });
            continue;
          }
          const present = r.length > 0 && (!it.contentHash || r[0].contentHash === it.contentHash);
          env = { ...env, exists: r.length > 0, present, currentSha: r.length ? await sha(String(r[0].content ?? "")) : null };
          if (!present && r.length) {
            const pre = replay && it.syntheticPreimage ? it.syntheticPreimage : it.preimageKey ? await readPreimage("survivalEditPreimage", String(it.preimageKey)) : null;
            const preRow = pre?.rows?.[0];
            env.preimageSha = typeof preRow?.content === "string" ? await sha(preOf(preRow)) : null;
          }
        } else if (it.kind === "skill") {
          // A disabled skill is a soft delete, so it counts as a deleted row.
          const r = await readSkill("survivalSkill", "isEnabled", it.skillId);
          const cur = r.length ? await sha(r[0].content) : null;
          env = { ...env, exists: r.length > 0 && Number(r[0].isEnabled ?? 1) !== 0, present: cur === it.contentSha256, currentSha: cur };
          if (!env.present && env.exists) {
            const pre = await preimage(it);
            const preRow = typeof pre?.content === "string" ? pre : pre?.rows?.[0];
            env.preimageSha = typeof preRow?.content === "string" ? await sha(preOf(preRow)) : null;
            // A pre-image without contentHex was read scrubbed: compare it with the scrubbed read of the skill.
            if (!preRow?.contentHex && env.preimageSha) env.currentSha = await sha(String(r[0].plain ?? ""));
          }
        } else {
          errors.push(`survival: no check for kind ${it.kind} (${it.actionId})`);
          out.checked--;
          continue;
        }
        const cls = classifySurvival(env);
        const rec = { actionId: it.actionId, kind: it.kind, ...(env.trimmedBy && cls === "trimmed" ? { trimmedBy: env.trimmedBy } : {}) };
        if (cls === "survived") out.survived++;
        else out[cls].push(rec);
      }
      };
      await checkItems(items, survival);
      // Replay-only data-path controls: synthetic ledger items checked against the live DB, reported apart.
      if (replay && Array.isArray(a.survivalItems)) await checkItems(a.survivalItems, syntheticSurvival);
    }
  } catch (e: any) {
    errors.push(`survival: ${String(e?.message ?? e).slice(0, 200)}`);
  }

  // 4. Metrics.
  const steps = runId
    ? await q(
        "steps",
        // agent_tasks has no workflowRunStepId index: a per-step correlated subquery scanned the whole
        // table once per step (3.2s of a 5.4s run on d28ed434, past 60s under fleet load). Pre-aggregate
        // through idx_agent_tasks_workflow_run instead.
        `SELECT s.nodeId, s.status, s.startedAt, s.finishedAt,
           ROUND((julianday(COALESCE(s.finishedAt, 'now')) - julianday(s.startedAt)) * 86400) secs,
           sc.costUsd
         FROM workflow_run_steps s
         LEFT JOIN (SELECT t.workflowRunStepId sid, ROUND(SUM(c.totalCostUsd), 2) costUsd
                      FROM agent_tasks t JOIN session_costs c ON c.taskId = t.id
                     WHERE t.workflowRunId = ? GROUP BY t.workflowRunStepId) sc ON sc.sid = s.id
         WHERE s.runId = ? ORDER BY s.startedAt LIMIT 500`,
        [runId, runId],
      )
    : [];
  const totalCost = runId
    ? await q("cost", `SELECT ROUND(SUM(c.totalCostUsd), 2) usd FROM session_costs c JOIN agent_tasks t ON t.id = c.taskId WHERE t.workflowRunId = ?`, [runId])
    : [];
  const actions: any[] = Array.isArray(synth?.actions) ? synth.actions : [];
  const rejected: any[] = Array.isArray(synth?.rejected) ? synth.rejected : [];
  const perLane: Record<string, any> = {};
  for (const lane of LANES) {
    const la = actions.filter((x) => x?.lane === lane);
    const ids = new Set(la.map((x) => x.id));
    const inIds = (arr: any[]) => (arr ?? []).filter((x: any) => ids.has(x.actionId)).length;
    const skillRes = skillResults.filter((r) => ids.has(r.actionId));
    perLane[lane] = {
      proposed: la.length,
      auto: la.filter((x) => x.tier === "auto").length,
      applied: lane === "identity" || lane === "memory" ? inIds(apply?.applied) : skillRes.filter((r) => r.status === "applied").length,
      wouldApply: inIds(apply?.wouldApply) + skillRes.filter((r) => r.status === "dry-run").length,
      refused: inIds(apply?.refused) + skillRes.filter((r) => r.status === "refused").length,
      refusedSilently: inIds(apply?.refusedSilently),
      built: lane === "scriptify" ? (scriptify?.built ?? []).filter((b: any) => b?.status === "built").length : undefined,
    };
  }
  const metrics = {
    nodes: steps.map((s: any) => ({ nodeId: s.nodeId, status: s.status, secs: Number(s.secs ?? 0), costUsd: s.costUsd === null ? null : Number(s.costUsd) })),
    totalCostSoFarUsd: Number(totalCost[0]?.usd ?? 0),
    rejected: rejected.length,
    missingReports: Array.isArray(synth?.missingReports) ? synth.missingReports.length : null,
    perLane,
    claimMismatch: claimMismatch.length,
    unclaimed: unclaimed.length,
    trims: { applied: (trim.applied ?? []).length, wouldApply: (trim.wouldApply ?? []).length, refused: (trim.refused ?? []).length, reapplied: (trim.reapplied ?? []).length },
    heartbeat: hb ? { status: hb.status ?? null, draftChars: hb.draftChars ?? null, removed: hb.removed ?? null, lineage: hbVerdict?.verdict ?? null } : null,
  };
  // Trim survival is measured by trim-apply before tonight's writes (every earlier trim, not just last night's).
  const trimSurvival = trim.survival ?? null;

  // 5. Ledger (live only).
  let ledgerKey: string | null = null;
  if (!controls.survival.ok || !controls.lineage.ok || !controls.hb.ok || !controls.memEdit.ok || !controls.renameEdit.ok) errors.push("controls: classifier self-test failed");
  if (!controls.read.ok) errors.push("controls: memory hex-read self-test failed");
  const ok = claimMismatch.length === 0 && unclaimed.length === 0 && dryRunViolations.length === 0 && errors.length === 0;
  if (!dry && !replay && runId) {
    try {
      ledgerKey = `ledger:${runId}`;
      const ledgerApplied = [
        ...applied,
        ...skillResults
          .filter((r) => r?.status === "applied")
          .map((r) => ({ actionId: r.actionId, kind: "skill", skillId: r.skillId, contentSha256: r.contentSha256, preimageKey: r.preimageKey })),
      ];
      await ctx.swarm.kv_set({
        namespace: NS,
        key: ledgerKey,
        value: { runId, at: new Date().toISOString(), ok, applied: ledgerApplied, claimMismatch, unclaimed, survival, metrics } as any,
      });
      await ctx.swarm.kv_set({ namespace: NS, key: "last-run", value: runId as any });
      if (wfSnapshot && typeof wfSnapshot === "object" && Object.keys(wfSnapshot).length)
        await ctx.swarm.kv_set({ namespace: NS, key: "wf-snapshot", value: { runId, at: new Date().toISOString(), nodes: wfSnapshot } as any });
    } catch (e: any) {
      errors.push(`ledger: ${String(e?.message ?? e).slice(0, 200)}`);
      ledgerKey = null;
    }
  }

  return { ok, mode: dry ? "dry-run" : replay ? "replay" : "live", since, controls, metrics, confirmed, claimMismatch, unclaimed, concurrent: concurrent.slice(0, 30), concurrentCount: concurrent.length, dryRunViolations, missingLanes, survival, ...(replay ? { syntheticSurvival } : {}), trimSurvival, ledgerKey, errors };
}


