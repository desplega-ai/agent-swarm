import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming-v2 manual rollback (Lead runs it by hand; not part of the nightly graph).
// Reads KV dreaming-v2/ledger:<runId>, undoes each applied item in reverse order, re-reads after each restore.
// Spec: agent-fs dreaming-v2/design.md section 3. Never throws.

export const argsSchema = z.object({
  runId: z.string(),
  actionIds: z.array(z.string()).optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  // dryRun only: run the read control on the plain (scrubbed) read. Negative control, never live.
  legacyRead: z.union([z.boolean(), z.string()]).optional(),
});

const NS = "dreaming-v2";
const FIELD: Record<string, string> = {
  SOUL: "soulMd",
  IDENTITY: "identityMd",
  CLAUDE: "claudeMd",
  TOOLS: "toolsMd",
  HEARTBEAT: "heartbeatMd",
};

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
// Every ctx.swarm response (db_query and kv reads) passes the secret scrubber, which rewrites secret-looking
// `key=value` text to `[REDACTED:<key>]`. Apply's memory pre-image rows hold stored bytes in `content`, so the
// pre-image is read as hex(...) of its kv row and the re-read uses hex(...) too; plain reads would corrupt or false-fail.
const MARK = "[REDACTED:";
const markers = (s: string) => String(s ?? "").split(MARK).length - 1;
const decodeHex = (hx: unknown) =>
  new TextDecoder().decode(new Uint8Array((String(hx ?? "").match(/../g) ?? []).map((h) => parseInt(h, 16))));
// Stored bytes of a pre-image row: `content` of the hex kv read; contentHex when present (rows apply wrote before the sweep covered pre-images).
const preBody = (m: any) => (typeof m?.contentHex === "string" && m.contentHex ? decodeHex(m.contentHex) : String(m?.content ?? ""));
const once = (text: string, s: string) => {
  const i = s ? text.indexOf(s) : -1;
  return i >= 0 && text.indexOf(s, i + 1) < 0 ? i : -1;
};

/** Dreaming manual rollback: undoes one run's ledger items in reverse, re-reading after each restore. */
export default async function (args: unknown, ctx: ScriptContext) {
  const a: any = args ?? {};
  const restored: any[] = [];
  const failed: any[] = [];
  const planned: any[] = [];
  const dry = a.dryRun === true || a.dryRun === "true";
  const runId = typeof a.runId === "string" ? a.runId : "";
  if (!runId) return { restored, failed: [{ actionId: null, reason: "runId required" }], planned };
  const only: string[] = Array.isArray(a.actionIds) ? a.actionIds.map(String) : [];
  const q = async (sql: string, params: unknown[] = []) => rows(await ctx.swarm.db_query({ sql, params }));
  const legacyRead = dry && (a.legacyRead === true || a.legacyRead === "true");
  // Stored bytes of one memory's content via hex (legacy: the scrubbed plain read, dryRun control only).
  const readMemory = async (memoryId: string, legacy = false) => {
    const r = await q(`SELECT content, hex(CAST(content AS BLOB)) AS hx FROM agent_memory WHERE id = ?`, [memoryId]);
    return r.length ? (legacy ? String(r[0].content ?? "") : decodeHex(r[0].hx)) : null;
  };
  // A pre-image value as stored: hex(...) of its kv row, so the scrubber never rewrites the memory bodies in it.
  const readPreimage = async (key: string) => {
    const r = await q(
      `SELECT hex(CAST(value AS BLOB)) AS hx FROM kv_entries WHERE namespace = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [NS, key, Date.now()],
    );
    if (!r.length) return null;
    try { return JSON.parse(decodeHex(r[0].hx)); } catch { return null; }
  };
  // Read control, every run. Positive: a secret-looking pre-image row read as hex of its kv value (as readPreimage
  // does) restores the stored bytes, and the hex re-read of those bytes matches. Negative
  // (legacyRead): the plain re-read of the same bytes differs, the false "re-read differs" failure.
  const controls: any = { ok: false, legacyRead };
  try {
    const fx = "api" + "_key=sk-" + "fixture-9f8e7d6c5b4a39281706f5e4d3c2b1a0\nsecond line of the memory body";
    const kvValue = JSON.stringify({ rows: [{ content: fx }] });
    const p = (await q(`SELECT ? AS plain, hex(CAST(? AS BLOB)) AS hx, hex(CAST(? AS BLOB)) AS vhx`, [fx, fx, kvValue]))[0] ?? {};
    const plain = String(p.plain ?? "");
    const row = JSON.parse(decodeHex(p.vhx)).rows[0];
    const body = preBody(row);
    const reread = (legacy: boolean) => (legacy ? plain : decodeHex(p.hx));
    const scrubberActive = plain !== fx && markers(plain) > 0;
    controls.positive = { fixture: "secret-looking key=value", scrubberActive, bodyIsStored: body === fx, rereadMatches: reread(legacyRead) === body };
    controls.positive.ok = scrubberActive && controls.positive.bodyIsStored && controls.positive.rereadMatches;
    controls.negative = { rereadMatches: reread(true) === body };
    controls.negative.ok = !controls.negative.rereadMatches;
    controls.ok = controls.positive.ok && controls.negative.ok;
  } catch (e: any) {
    controls.error = String(e?.message ?? e).slice(0, 200);
  }
  // Live memory writes need preBody to yield stored bytes. Not gated on scrubberActive: a scrubber change must
  // never block an emergency rollback.
  const bodyGate = () => controls.positive?.bodyIsStored === true;
  const BODY_GATE = "skipped: controls.positive.bodyIsStored is not true, preBody may not yield stored bytes";

  let ledger: any = null;
  try {
    ledger = (await ctx.swarm.kv_getOrNull({ namespace: NS, key: `ledger:${runId}` }))?.value ?? null;
  } catch (e: any) {
    return { restored, failed: [{ actionId: null, reason: `ledger read: ${String(e?.message ?? e).slice(0, 200)}` }], planned, controls };
  }
  if (!ledger || !Array.isArray(ledger.applied)) return { restored, failed: [{ actionId: null, reason: `no ledger:${runId}` }], planned, controls };

  const items = [...ledger.applied].filter((x: any) => !only.length || only.includes(String(x.actionId))).reverse();
  for (const it of items) {
    const id = String(it.actionId);
    try {
      const pre: any = it.preimageKey ? await readPreimage(String(it.preimageKey)) : null;

      if (it.kind === "identity") {
        const field = FIELD[it.target?.file] ?? "";
        const agentId = String(it.target?.agentId ?? "");
        if (!field || !pre) { failed.push({ actionId: id, reason: "missing field or pre-image" }); continue; }
        const cur = String((await q(`SELECT ${field} AS body FROM agents WHERE id = ?`, [agentId]))[0]?.body ?? "");
        let next: string | null = null;
        let how = "";
        if ((await sha(cur)) === it.afterSha && pre.contextVersionId) {
          const cv = await q(`SELECT content FROM context_versions WHERE id = ?`, [pre.contextVersionId]);
          if (cv.length && (await sha(String(cv[0].content ?? ""))) === pre.sha256) {
            next = String(cv[0].content);
            how = "full pre-image from context_versions";
          }
        }
        if (next === null) {
          // Field changed since our write (or pointer mismatch): splice back only our section.
          const op = String(it.target?.op ?? pre.op ?? "");
          const content = String(pre.content ?? it.content ?? "").trim();
          const section = String(pre.section ?? "");
          if (op === "remove-section") {
            next = `${cur.replace(/\s*$/, "")}\n\n${section.trim()}\n`;
            how = "re-appended removed section at end of file";
          } else if (op === "replace-exact") {
            const i = content ? once(cur, content) : -1;
            if (i >= 0) { next = cur.slice(0, i) + section + cur.slice(i + content.length); how = "replace-exact reversed"; }
          } else if (op === "append-under") {
            const i = once(cur, content);
            if (i >= 0) { next = (cur.slice(0, i).replace(/\n+$/, "\n") + cur.slice(i + content.length).replace(/^\n+/, "\n")); how = "appended text removed"; }
          } else if (op === "replace-section") {
            const i = once(cur, content);
            if (i >= 0) {
              const body = section.replace(/^## .*\r?\n?/, "").trim();
              next = cur.slice(0, i) + body + cur.slice(i + content.length);
              how = "section body restored";
            }
          }
          if (next === null) { failed.push({ actionId: id, reason: `cannot splice back ${op}: our text no longer occurs exactly once` }); continue; }
        }
        const want = await sha(next);
        if (dry) { planned.push({ actionId: id, kind: "identity", agentId, field, how, netChars: next.length - cur.length }); continue; }
        await ctx.swarm.profile_update({ agentId, [field]: next });
        const re = String((await q(`SELECT ${field} AS body FROM agents WHERE id = ?`, [agentId]))[0]?.body ?? "");
        if ((await sha(re)) === want) restored.push({ actionId: id, kind: "identity", how });
        else failed.push({ actionId: id, reason: "re-read sha differs after restore" });
      } else if (it.kind === "memory-store") {
        const mid = String(it.target?.memoryId ?? "");
        const r = mid ? await q(`SELECT COUNT(*) n FROM agent_memory WHERE id = ?`, [mid]) : [];
        if (!mid || Number(r[0]?.n) === 0) { failed.push({ actionId: id, reason: "stored memory already gone or id unknown" }); continue; }
        if (dry) { planned.push({ actionId: id, kind: "memory-store", how: `memory_delete ${mid}` }); continue; }
        await ctx.swarm.memory_delete({ id: mid });
        const r2 = await q(`SELECT COUNT(*) n FROM agent_memory WHERE id = ?`, [mid]);
        if (Number(r2[0]?.n) === 0) restored.push({ actionId: id, kind: "memory-store", how: "deleted" });
        else failed.push({ actionId: id, reason: "row still present after delete" });
      } else if (it.kind === "memory-delete") {
        const pr: any[] = pre?.rows ?? [];
        if (!pr.length) { failed.push({ actionId: id, reason: "no pre-image rows" }); continue; }
        if (dry) { planned.push({ actionId: id, kind: "memory-delete", how: `re-store ${pr.length} row(s) (new ids)` }); continue; }
        if (!bodyGate()) { failed.push({ actionId: id, reason: BODY_GATE }); continue; }
        for (const m of pr) {
          let tags: string[] = [];
          try { tags = Array.isArray(m.tags) ? m.tags : JSON.parse(m.tags ?? "[]"); } catch {}
          await ctx.swarm.memory_store({ name: String(m.name), content: preBody(m), scope: m.scope === "agent" ? "agent" : "swarm", tags: [...tags, "dreaming-v2-restored"], intent: `dreaming-rollback ${runId} ${id}` });
          const c = await q(`SELECT COUNT(*) n FROM agent_memory WHERE name = ?`, [m.name]);
          if (Number(c[0]?.n) >= 1) restored.push({ actionId: id, kind: "memory-delete", how: `re-stored ${m.name}` });
          else failed.push({ actionId: id, reason: `re-store of ${m.name} not visible` });
        }
      } else if (it.kind === "memory-edit") {
        const m = pre?.rows?.[0];
        if (!m) { failed.push({ actionId: id, reason: "no pre-image row" }); continue; }
        if (dry) { planned.push({ actionId: id, kind: "memory-edit", how: `memory_edit ${m.id} back to pre-image` }); continue; }
        if (!bodyGate()) { failed.push({ actionId: id, reason: BODY_GATE }); continue; }
        const body = preBody(m);
        await ctx.swarm.memory_edit({ memoryId: m.id, mode: "replace", content: body, intent: `dreaming-rollback ${runId} ${id}` });
        const r = await readMemory(m.id, legacyRead);
        if (r !== null && r === body) restored.push({ actionId: id, kind: "memory-edit", how: "content restored" });
        else failed.push({ actionId: id, reason: "re-read differs after restore" });
      } else if (it.kind === "skill") {
        const skillId = String(it.skillId ?? "");
        if (!skillId) { failed.push({ actionId: id, reason: "skillId missing" }); continue; }
        if (pre?.content) {
          if (dry) { planned.push({ actionId: id, kind: "skill", how: "skill_update content back to pre-image" }); continue; }
          await ctx.swarm.skill_update({ skillId, content: String(pre.content) });
          const r = await q(`SELECT content FROM skills WHERE id = ?`, [skillId]);
          if (r.length && String(r[0].content) === String(pre.content)) restored.push({ actionId: id, kind: "skill", how: "content restored" });
          else failed.push({ actionId: id, reason: "skill content differs after restore" });
        } else {
          // No pre-image: a skill-create. Disable (reversible); delete after the week-1 review.
          if (dry) { planned.push({ actionId: id, kind: "skill", how: "skill_update isEnabled:false (created skill)" }); continue; }
          await ctx.swarm.skill_update({ skillId, isEnabled: false });
          const r = await q(`SELECT isEnabled FROM skills WHERE id = ?`, [skillId]);
          if (r.length && !Number(r[0].isEnabled)) restored.push({ actionId: id, kind: "skill", how: "disabled" });
          else failed.push({ actionId: id, reason: "skill still enabled after disable" });
        }
      } else failed.push({ actionId: id, reason: `unknown kind ${it.kind}` });
    } catch (e: any) {
      failed.push({ actionId: id, reason: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return { mode: dry ? "dry-run" : "live", runId, restored, failed, planned, controls };
}
