import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming-v2 trim lane. Spec: agent-fs dreaming-v2/design.md section 8.
// mode "plan":   pick tonight's fields (reverted first, then deferred net-positive edits, over-target, rotation).
// mode "apply":  write each drafted trim that ends net-smaller; re-apply reverted trims; record trim-state.
// mode "revert": restore one field from its KV pre-image. Never throws.
// v3 (plan-v3 Phase 1): live trims also write the cut ledger KV cuts:<runId>:A (one record per removed block, with a
// probe dreaming-learn scores). mode "selftest": survival + cut-extraction controls on fixtures (no reads, no writes).

export const argsSchema = z.object({
  mode: z.enum(["plan", "apply", "revert", "selftest"]),
  runId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  date: z.string().optional(),
  maxTrims: z.number().int().min(0).max(12).default(3),
  deferred: z.unknown().optional(),
  plan: z.unknown().optional(),
  drafts: z.unknown().optional(),
  agentId: z.string().optional(),
  field: z.string().optional(),
  // Seeded workflow: run from a Lead agent-task with args loaded from the run, or return that stored result.
  fromRun: z.boolean().optional(),
  loadResult: z.boolean().optional(),
});

const NS = "dreaming-v2";
const FIELDS = ["claudeMd", "toolsMd", "soulMd", "identityMd"] as const;
const FILE_OF: Record<string, string> = { claudeMd: "CLAUDE", toolsMd: "TOOLS", soulMd: "SOUL", identityMd: "IDENTITY" };
// claudeMd and toolsMd are each cut at BOOTSTRAP_MAX_CHARS when injected; soul/identity have no hard cap.
const TARGET: Record<string, number | null> = { claudeMd: 20000, toolsMd: 20000, soulMd: null, identityMd: null };
const ROTATION_MIN_CHARS = 6000;
const ROTATION_COOLDOWN_DAYS = 14;
const MIN_CHARS: Record<string, number> = { soulMd: 500, identityMd: 500, claudeMd: 200, toolsMd: 200 };
const MAX_MEMORIES_PER_TRIM = 5;

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
const slug = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const revertLine = (runId: string, agentId: string, field: string) =>
  `script-run name="dreaming-trim" scope="global" args={"mode":"revert","runId":"${runId}","agentId":"${agentId}","field":"${field}"}`;

// Survival of one earlier trim against the live field sha. "reverted" carries the text to re-apply.
export function trimSurvival(st: any, liveSha: string): { status: "skip" | "intact" | "reverted" | "drifted"; restoreText: string | null } {
  if (!st?.afterSha || st?.revertedAt) return { status: "skip", restoreText: null };
  if (liveSha === st.afterSha) return { status: "intact", restoreText: null };
  if (liveSha === st.beforeSha && typeof st.afterText === "string") return { status: "reverted", restoreText: st.afterText };
  return { status: "drifted", restoreText: null };
}

// Cut ledger: one record per block of lines the trim removed. probe = a distinctive <=80-char phrase that is in
// `before` and not in `after`; line/nLines index the block in the pre-image so a restore can re-insert it after `anchor`.
export function cutsFrom(before: string, after: string, max = 40) {
  const afterSet = new Set(after.split("\n").map((l) => l.trim()).filter(Boolean));
  const lines = before.split("\n");
  const blocks: Array<{ line: number; nLines: number; lines: string[]; anchor: string | null }> = [];
  let cur: any = null;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t && !afterSet.has(t)) {
      if (!cur) {
        cur = { line: i, nLines: 0, lines: [], anchor: null };
        for (let k = i - 1; k >= 0; k--) {
          const u = lines[k]!.trim();
          if (u && afterSet.has(u)) { cur.anchor = lines[k]; break; }
        }
        blocks.push(cur);
      }
      cur.lines.push(l);
      cur.nLines = i - cur.line + 1;
    } else if (t) cur = null;
  });
  const out: any[] = [];
  for (const b of blocks) {
    if (out.length >= max) break;
    const cand = b.lines.map((x) => x.trim()).filter((x) => x.length >= 12);
    const head = cand.find((x) => /^#{1,4} /.test(x)) ?? [...cand].sort((x, y) => y.length - x.length)[0] ?? "";
    let probe = head.replace(/^[#>*\-\s\d.)]+/, "").slice(0, 80).trim();
    if (!probe || after.includes(probe)) probe = head.slice(0, 80).trim();
    if (probe.length < 8 || after.includes(probe) || !before.includes(probe)) continue;
    out.push({ probe, line: b.line, nLines: b.nLines, anchor: b.anchor ? b.anchor.slice(0, 300) : null, chars: b.lines.join("\n").length });
  }
  return out;
}

async function runScript(args: unknown, ctx: ScriptContext) {
  const p = argsSchema.safeParse(args ?? {});
  if (!p.success) return { ok: false, errors: [p.error.message], targets: [], slackLine: "Trims: none (bad args)" };
  const a = p.data;
  const dry = a.dryRun === true || a.dryRun === "true";
  const runId = a.runId ?? "";
  const date = a.date ?? new Date().toISOString().slice(0, 10);
  const errors: string[] = [];
  const q = async (sql: string, params: unknown[] = []) => rows(await ctx.swarm.db_query({ sql, params }));
  const kvGet = async (key: string) => ctx.swarm.kv_getOrNull({ namespace: NS, key });
  const kvSet = async (key: string, value: unknown) => ctx.swarm.kv_set({ namespace: NS, key, value: value as any });
  const trimStates = async (): Promise<any[]> => {
    try {
      const r: any = await ctx.swarm.kv_list({ namespace: NS, prefix: "trim-state:", limit: 200 });
      return (r?.data?.entries ?? r?.entries ?? []).map((e: any) => ({ key: e.key, ...(parse(e.value) ?? {}) }));
    } catch (e: any) {
      errors.push(`kv_list trim-state: ${String(e?.message ?? e).slice(0, 200)}`);
      return [];
    }
  };

  // ---------------- selftest ----------------
  if (a.mode === "selftest") {
    const before = "## Rules\n- keep this rule line\n## Stories\n- 2026-08-01 a long incident story about a stale disk copy\n- proven again on 08-02 with evidence\n## Tools\n- host api:3013\n";
    const after = "## Rules\n- keep this rule line\n## Tools\n- host api:3013\n";
    const st = { afterSha: await sha(after), beforeSha: await sha(before), afterText: after };
    const sv = [
      { name: "survival+ live = pre-image -> reverted, restores afterText", got: trimSurvival(st, await sha(before)), want: "reverted", restore: after },
      { name: "survival- drifted live (third text) -> drifted, no restore", got: trimSurvival(st, await sha(before + "x")), want: "drifted", restore: null },
      { name: "survival+ live = afterText -> intact", got: trimSurvival(st, st.afterSha), want: "intact", restore: null },
      { name: "survival- reverted but no afterText stored -> drifted", got: trimSurvival({ ...st, afterText: undefined }, st.beforeSha), want: "drifted", restore: null },
      { name: "survival- reverted by hand (revertedAt) -> skip", got: trimSurvival({ ...st, revertedAt: "x" }, st.beforeSha), want: "skip", restore: null },
    ].map((x) => ({ name: x.name, pass: x.got.status === x.want && x.got.restoreText === x.restore, got: x.got.status }));
    const cuts = cutsFrom(before, after);
    const ct = [
      { name: "cuts+ one block removed -> one cut", pass: cuts.length === 1 },
      { name: "cuts+ probe in before, not in after", pass: cuts.every((c) => before.includes(c.probe) && !after.includes(c.probe)) },
      { name: "cuts+ anchor survives in after", pass: cuts.every((c) => c.anchor !== null && after.includes(c.anchor)) },
      { name: "cuts+ block re-inserted after anchor rebuilds before", pass: (() => { const c = cuts[0]; const bl = before.split("\n"); const block = bl.slice(c.line, c.line + c.nLines).join("\n"); return after.replace(c.anchor + "\n", c.anchor + "\n" + block + "\n") === before; })() },
      { name: "cuts- identical texts -> no cut", pass: cutsFrom(before, before).length === 0 },
    ];
    return { ok: sv.every((x) => x.pass) && ct.every((x) => x.pass), mode: "selftest", survival: sv, cuts: ct, sample: cuts };
  }

  // ---------------- revert ----------------
  if (a.mode === "revert") {
    const agentId = a.agentId ?? "";
    const field = a.field ?? "";
    if (!runId || !agentId || !(FIELDS as readonly string[]).includes(field)) return { ok: false, errors: ["revert needs runId, agentId, field"] };
    const pre: any = await kvGet(`trim-preimage:${runId}:${agentId}:${field}`);
    const text = pre?.value?.text;
    if (typeof text !== "string") return { ok: false, errors: ["no pre-image for that runId/agentId/field"] };
    if (dry) return { ok: true, mode: "dry-run", wouldRestoreChars: text.length };
    await ctx.swarm.profile_update({ agentId, [field]: text });
    const rr = await q(`SELECT ${field} AS body FROM agents WHERE id = ?`, [agentId]);
    const ok = (await sha(String(rr[0]?.body ?? ""))) === (await sha(text));
    if (ok) await kvSet(`trim-state:${agentId}:${field}`, { agentId, field, revertedAt: new Date().toISOString(), revertedRunId: runId });
    return { ok, mode: "live", restoredChars: text.length, verifiedBy: ok ? "sha256(re-read) = sha256(pre-image)" : "MISMATCH after restore" };
  }

  const agents = await q(
    `SELECT id, name, isLead, status, claudeMd, toolsMd, soulMd, identityMd FROM agents
     WHERE name NOT LIKE 'ext:%' AND status != 'offline' ORDER BY isLead DESC, name`,
  );
  const byId = new Map(agents.map((x: any) => [x.id, x]));
  const states = await trimStates();
  const stateOf = (agentId: string, field: string) => states.find((s) => s.agentId === agentId && s.field === field);

  // ---------------- plan ----------------
  if (a.mode === "plan") {
    const deferred: any[] = Array.isArray(parse(a.deferred)) ? parse(a.deferred) : (parse(a.deferred)?.deferredToTrim ?? []);
    const cands: any[] = [];
    for (const ag of agents) {
      for (const f of FIELDS) {
        const body = String(ag[f] ?? "");
        if (!body.trim()) continue;
        const st = stateOf(ag.id, f);
        const bodySha = await sha(body);
        const reverted = !!st?.beforeSha && bodySha === st.beforeSha && !st.revertedAt;
        const recent = st?.at && Date.now() - Date.parse(st.at) < ROTATION_COOLDOWN_DAYS * 86400000;
        const edits = deferred.filter((d) => d?.agentId === ag.id && d?.field === f);
        const tgt = TARGET[f] as number | null;
        const over = tgt !== null && body.length > tgt ? body.length - tgt : 0;
        let rank = -1;
        let reason = "";
        if (reverted) { rank = 3; reason = "reverted: live text equals the pre-trim text; re-applied deterministically"; }
        else if (edits.length) { rank = 2; reason = `folds ${edits.length} net-positive edit(s): ${edits.map((e) => e.actionId).join(", ")}`; }
        else if (over > 0) { rank = 1; reason = `over target by ${over} chars (target ${tgt})`; }
        else if (!recent && body.length >= ROTATION_MIN_CHARS) { rank = 0; reason = "rotation"; }
        if (rank < 0) continue;
        cands.push({
          slot: `${slug(ag.name)}-${f}`,
          agentId: ag.id,
          agentName: ag.name,
          isLead: !!ag.isLead,
          field: f,
          file: FILE_OF[f],
          chars: body.length,
          sha256: bodySha,
          targetChars: tgt,
          reason,
          rank,
          over,
          deferredEdits: edits,
          lastTrimAt: st?.at ?? null,
          backupPath: `dreaming-v2/backups/${date}/${slug(ag.name)}/${f}.md`,
        });
      }
    }
    const reapply = cands.filter((c) => c.rank === 3);
    // One field per agent per night, so the rotation spreads across agents.
    const llm = cands
      .filter((c) => c.rank < 3)
      .sort((x, y) => y.rank - x.rank || y.over - x.over || y.chars - x.chars);
    const seen = new Set<string>();
    const targets: any[] = [];
    for (const c of llm) {
      if (targets.length >= a.maxTrims) break;
      if (seen.has(c.agentId) && c.rank < 2) continue;
      seen.add(c.agentId);
      targets.push(c);
    }
    const deferredUnplanned = deferred.filter((d) => !targets.some((t) => t.agentId === d.agentId && t.field === d.field));
    return {
      ok: true,
      mode: dry ? "dry-run" : "live",
      date,
      maxTrims: a.maxTrims,
      targets,
      reapply: reapply.map((c) => ({ agentId: c.agentId, agentName: c.agentName, field: c.field })),
      deferredUnplanned,
      backlog: llm.filter((c) => !targets.includes(c)).map((c) => ({ slot: c.slot, chars: c.chars, reason: c.reason })),
      errors,
    };
  }

  // ---------------- apply ----------------
  const plan = parse(a.plan) ?? {};
  const targets: any[] = Array.isArray(plan.targets) ? plan.targets : [];
  const draftsRaw = parse(a.drafts);
  const results: any[] = Array.isArray(draftsRaw) ? draftsRaw : Array.isArray(draftsRaw?.results) ? draftsRaw.results : [];
  const out = {
    ok: true,
    mode: dry ? "dry-run" : "live",
    applied: [] as any[],
    wouldApply: [] as any[],
    refused: [] as any[],
    reapplied: [] as any[],
    memories: [] as any[],
    survival: { checked: 0, intact: 0, reverted: [] as any[], drifted: [] as any[] },
    slackLine: "",
    errors,
  };

  // Survival of every earlier trim; a reverted field is re-applied from its stored trimmed text.
  for (const st of states) {
    if (!st.afterSha || st.revertedAt) continue;
    const ag: any = byId.get(st.agentId);
    if (!ag) continue;
    out.survival.checked++;
    const body = String(ag[st.field] ?? "");
    const s = await sha(body);
    const sv = trimSurvival(st, s);
    if (sv.status === "intact") { out.survival.intact++; continue; }
    if (sv.status === "reverted") {
      out.survival.reverted.push({ agentId: st.agentId, agentName: ag.name, field: st.field, runId: st.runId });
      if (dry) continue;
      try {
        // trim-state lives in a KV namespace any agent can write. Re-apply only a text that a lead really wrote
        // to this field before (context_versions keeps every profile version), never arbitrary KV text.
        const seen = await q(
          `SELECT 1 AS x FROM context_versions WHERE agentId = ? AND field = ? AND contentHash = ? AND changedByAgentId IN (SELECT id FROM agents WHERE isLead = 1) LIMIT 1`,
          [st.agentId, st.field, await sha(String(st.afterText ?? ""))],
        );
        if (!seen.length) {
          errors.push(`reapply ${st.agentId}:${st.field}: stored text is not a lead-written version of this field; skipped`);
          continue;
        }
        await ctx.swarm.profile_update({ agentId: st.agentId, [st.field]: st.afterText });
        const rr = await q(`SELECT ${st.field} AS body FROM agents WHERE id = ?`, [st.agentId]);
        const ok = (await sha(String(rr[0]?.body ?? ""))) === st.afterSha;
        out.reapplied.push({ agentId: st.agentId, agentName: ag.name, field: st.field, ok });
        if (ok) await kvSet(st.key, { ...st, key: undefined, reappliedAt: new Date().toISOString(), reappliedRunId: runId });
      } catch (e: any) {
        errors.push(`reapply ${st.agentId}:${st.field}: ${String(e?.message ?? e).slice(0, 160)}`);
      }
      continue;
    }
    out.survival.drifted.push({ agentId: st.agentId, agentName: ag.name, field: st.field, chars: body.length, trimmedChars: st.afterChars, note: "edited since the trim; back in rotation" });
  }

  const cutLedger: any[] = [];
  for (const t of targets) {
    const refuse = (reason: string) => out.refused.push({ slot: t.slot, agentId: t.agentId, agentName: t.agentName, field: t.field, reason });
    try {
      const r = results.find((x: any) => String(x?.itemKey ?? "") === t.slot) ?? null;
      if (!r) { refuse("no draft result for this slot"); continue; }
      if (r.status && r.status !== "completed" && r.status !== "success") { refuse(`draft task ${r.status}`); continue; }
      const o = parse(r.output) ?? {};
      const d = parse(o.taskOutput ?? r.taskOutput);
      if (!d || typeof d !== "object") { refuse("draft output is not JSON"); continue; }
      if (d.agentId !== t.agentId || d.field !== t.field) { refuse(`slot mismatch: draft is ${d.agentId}:${d.field}`); continue; }
      const next = typeof d.trimmed === "string" ? d.trimmed : "";
      if (!next.trim()) { refuse("empty draft"); continue; }
      if (/^## /m.test(next) === false && /^## /m.test(String(byId.get(t.agentId)?.[t.field] ?? ""))) { refuse("draft dropped every H2 heading"); continue; }
      if (next.length < (MIN_CHARS[t.field] ?? 200)) { refuse(`draft shorter than ${MIN_CHARS[t.field]} chars`); continue; }
      const live = String(byId.get(t.agentId)?.[t.field] ?? "");
      const liveSha = await sha(live);
      if (liveSha !== t.sha256) { refuse(`field changed since plan (${liveSha.slice(0, 12)} != ${String(t.sha256).slice(0, 12)})`); continue; }
      if (next.length >= live.length) { refuse(`not net-smaller: ${live.length} -> ${next.length}`); continue; }
      const missing = (t.deferredEdits ?? []).filter((e: any) => {
        const probe = String(e?.content ?? "").trim().slice(0, 60);
        return probe && !next.includes(probe);
      });
      if (missing.length) { refuse(`deferred edit(s) not folded in: ${missing.map((e: any) => e.actionId).join(", ")}`); continue; }
      const afterSha = await sha(next);
      const row = {
        slot: t.slot,
        agentId: t.agentId,
        agentName: t.agentName,
        field: t.field,
        beforeChars: live.length,
        afterChars: next.length,
        beforeSha: liveSha,
        afterSha,
        backupPath: String(d.backupPath ?? t.backupPath),
        foldedEdits: (t.deferredEdits ?? []).map((e: any) => e.actionId),
        overTarget: t.targetChars !== null && next.length > t.targetChars,
        revert: revertLine(runId, t.agentId, t.field),
      };
      const mems: any[] = (Array.isArray(d.movedToMemory) ? d.movedToMemory : []).slice(0, MAX_MEMORIES_PER_TRIM);
      if (dry) {
        out.wouldApply.push({ ...row, memories: mems.map((m) => m?.name), cuts: cutsFrom(live, next).length });
        continue;
      }
      if (!d.backupPath) { refuse("live trim without backupPath (agent-fs backup not confirmed)"); continue; }
      await kvSet(`trim-preimage:${runId}:${t.agentId}:${t.field}`, { text: live, sha256: liveSha, chars: live.length, backupPath: d.backupPath, at: new Date().toISOString() });
      // Re-check immediately before the write: the smallest window we can get without CAS on update-profile.
      const again = await q(`SELECT ${t.field} AS body FROM agents WHERE id = ?`, [t.agentId]);
      if ((await sha(String(again[0]?.body ?? ""))) !== liveSha) { refuse("field changed between plan and write"); continue; }
      await ctx.swarm.profile_update({ agentId: t.agentId, [t.field]: next });
      const rr = await q(`SELECT ${t.field} AS body FROM agents WHERE id = ?`, [t.agentId]);
      const reSha = await sha(String(rr[0]?.body ?? ""));
      if (reSha !== afterSha) { refuse(`re-read sha ${reSha.slice(0, 12)} != ${afterSha.slice(0, 12)} after write`); continue; }
      await kvSet(`trim-state:${t.agentId}:${t.field}`, {
        agentId: t.agentId, field: t.field, runId, at: new Date().toISOString(),
        beforeSha: liveSha, beforeChars: live.length, afterSha, afterChars: next.length, afterText: next, backupPath: d.backupPath,
      });
      out.applied.push({ ...row, verifiedBy: `sha256(re-read ${t.field}) = ${afterSha.slice(0, 12)}` });
      for (const c of cutsFrom(live, next))
        cutLedger.push({
          cutId: `${runId.slice(0, 8)}:A:${cutLedger.length}`,
          lane: "A",
          target: { kind: "profile", agentId: t.agentId, field: t.field },
          kind: "removed-block",
          ...c,
          backupRef: d.backupPath,
          preimageKey: `trim-preimage:${runId}:${t.agentId}:${t.field}`,
        });
      for (const m of mems) {
        const name = String(m?.name ?? "");
        const content = String(m?.content ?? "");
        if (!/^[a-z0-9-]{3,90}$/.test(name) || !content.trim()) { out.memories.push({ name, status: "refused", reason: "bad name or empty" }); continue; }
        const c = await q(`SELECT COUNT(*) n FROM agent_memory WHERE name = ?`, [name]);
        if (Number(c[0]?.n) > 0) { out.memories.push({ name, status: "exists" }); continue; }
        await ctx.swarm.memory_store({ name, content, scope: m?.scope === "agent" ? "agent" : "swarm", tags: ["dreaming-v2", runId, "trim"], intent: `dreaming-v2 ${runId} trim ${t.slot}` });
        const c2 = await q(`SELECT COUNT(*) n FROM agent_memory WHERE name = ? AND COALESCE(chunkIndex, 0) = 0`, [name]);
        out.memories.push({ name, status: Number(c2[0]?.n) === 1 ? "stored" : "store-unverified", fromSlot: t.slot });
      }
    } catch (e: any) {
      errors.push(`${t.slot}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  if (!dry && runId && cutLedger.length) {
    try {
      await kvSet(`cuts:${runId}:A`, { runId, lane: "A", at: new Date().toISOString(), cuts: cutLedger });
      (out as any).cutsKey = `cuts:${runId}:A`;
    } catch (e: any) {
      errors.push(`cuts ledger: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  (out as any).cuts = cutLedger.length;
  const done = dry ? out.wouldApply : out.applied;
  const parts = done.map((x) => `${x.agentName} ${x.field} ${x.beforeChars}→${x.afterChars}`);
  for (const x of out.reapplied) parts.push(`${x.agentName} ${x.field} re-applied`);
  out.slackLine = parts.length ? `Trims${dry ? " (dry run, not written)" : ""}: ${parts.join("; ")}` : "Trims: none tonight";
  if (out.refused.length) out.slackLine += ` (${out.refused.length} refused)`;
  out.ok = errors.length === 0;
  return out;
}

// fromRun / loadResult, for the seeded `dreaming` workflow. These writes need Lead authority, which a seeded
// workflow's script node does not have, so a Lead agent-task runs `{ mode, runId, fromRun: true }` from its own
// session. Every arg the caller did not pass loads from the run's recorded step outputs (a step that never ran
// reads as "", as interpolation renders it), the result is stored in KV, and the task returns a small pointer. The
// next node runs `{ mode, runId, loadResult: true }` and returns the stored result, so downstream mappings keep
// reading `<node>.result`. Without either flag the script runs exactly as before.
const RUN_NODE = "trim-apply";
const RUN_MODE: string | null = "apply";
// [arg, step nodeId, JSON path in the step output, required]. A missing required step stops before any write.
const RUN_PATHS: Array<[string, string, string, boolean]> = [
  ["dryRun", "gather", "$.result.dryRun", true],
  ["plan", "trim-plan", "$.result", true],
  ["drafts", "trim", "$.results", false],
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

/** Dreaming profile trims: plan, apply with a net-smaller check and survival ledger, revert, selftest; fromRun / loadResult for apply. */
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
