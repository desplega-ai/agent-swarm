import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming v3 lane C: Lead HEARTBEAT triage and prune. Spec: agent-fs dreaming-v2/plan-v3.md section 5 + Revision 1.
// mode "plan":     parse Lead heartbeatMd, list deterministic + LLM candidates, pins, Tracked Items pin drain candidates, deferred ops, handshake, survival.
// mode "text":     live Lead heartbeatMd + sha (hb-draft reads it over REST).
// mode "stage":    hb-draft stores its draft text in KV hb-draft:<runId>; check/apply read it from there.
// mode "check":    validate a draft (validator port, pins + pin harvest, size, removed coverage), then wait for a quiet window.
// mode "quiet":    read-only: is any Lead heartbeat-checklist task live? lead-disk runs it right before the disk copy.
// mode "apply":    DB write after lead-disk wrote the disk (live + v3Writes=on only); else wouldApply.
// mode "restore-db": set the DB back to the run's pre-image once Lead has restored the disk copy.
// mode "revert":   return the Lead brief for a rollback (no writes).
// mode "verify":   survival of the last applied prune (read-only).
// mode "selftest": validator parity with src/tests/heartbeat-expiry.test.ts + check/handshake controls.
// Never throws.

export const argsSchema = z.object({
  mode: z.enum(["plan", "text", "stage", "check", "quiet", "apply", "restore-db", "revert", "verify", "selftest"]),
  leadAgentId: z.string().optional(),
  text: z.string().optional(),
  runId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  writes: z.unknown().optional(),
  date: z.string().optional(),
  apply: z.unknown().optional(),
  plan: z.unknown().optional(),
  check: z.unknown().optional(),
  draft: z.unknown().optional(),
  disk: z.unknown().optional(),
  waitMs: z.number().int().min(0).max(270000).optional(),
  confirmDiskSha: z.string().optional(),
  skillName: z.string().optional(),
  // Seeded workflow: run from a Lead agent-task with args loaded from the run, or return that stored result.
  fromRun: z.boolean().optional(),
  loadResult: z.boolean().optional(),
});

const NS = "dreaming-v2";
// The agent-fs path hb-plan gives the heartbeat draft. lead-disk uses it in a Bash command, so nothing else passes.
const DRAFT_PATH_RE = /^dreaming-v2\/drafts\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9-]{1,40}\/lead-heartbeat\.md$/;
const PROCEDURES_SKILL = "lead-heartbeat-procedures";
const TARGETS = { firstRunChars: 60000, steadyChars: 50000, trackedItemsChars: 25000, itemChars: 500, standingOrdersChars: 25000 };
const MAX_MEMORIES = 10;
// Tracked-Items 📌 lines drained into memory per night (on top of MAX_MEMORIES): ~30 pins clear in 3 runs.
const MAX_PIN_MEMORIES = 12;
const BUSY = ["unassigned", "offered", "reviewing", "pending", "in_progress", "paused"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

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
const isOn = (v: unknown) => v === true || v === "on" || v === "true";

// ---- Port of src/utils/heartbeat-expiry.ts (agent-swarm main ac98bebc2, blob 362c973106abcd6689e360d6742d0961a6494813).
// Same regex and order; scrubSecrets dropped (the message is never posted anywhere).
const EXPIRY = /delete\s+(on\s+)?\d{2}-\d{2}/i;
function trackedLines(markdown: string): string[] {
  const marker = "## Tracked Items";
  const start = markdown.lastIndexOf(marker);
  if (start < 0) return [];
  const lineEnd = markdown.indexOf("\n", start);
  if (lineEnd < 0) return [];
  const section = markdown.slice(lineEnd + 1).split(/^#{1,2}\s/m)[0] ?? "";
  return section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/, ""))
    .filter((line) => line && !line.startsWith("#") && !/^[-*_]{3,}$/.test(line));
}
function title(line: string): string | undefined {
  return /^\*\*([^*]+)\*\*/.exec(line)?.[1];
}
function isShortening(old: string, next: string): boolean {
  let cursor = 0;
  for (const character of next) {
    const index = old.indexOf(character, cursor);
    if (index < 0) return false;
    cursor = index + character.length;
  }
  return true;
}
class HeartbeatExpiryError extends Error {
  constructor(line: string) {
    super(`Update rejected for heartbeatMd: new tracked item requires DELETE <MM-DD> (or DELETE on <MM-DD>): ${line}`);
    this.name = "HeartbeatExpiryError";
  }
}
export function validateHeartbeatExpiry(currentValue: string, nextValue: string): void {
  const previous = trackedLines(currentValue);
  const incoming = trackedLines(nextValue);
  const changed = incoming.filter((line) => {
    const index = previous.indexOf(line);
    if (index < 0) return true;
    previous.splice(index, 1);
    return false;
  });
  for (const line of changed) {
    if (!line.startsWith("📌") && !EXPIRY.test(line)) continue;
    const itemTitle = title(line.replace(/^📌\s*/, ""));
    const index = previous.findIndex((old) => line.includes(old) || (itemTitle !== undefined && itemTitle === title(old)));
    if (index >= 0) previous.splice(index, 1);
  }
  for (const line of changed) {
    if (line.startsWith("📌") || EXPIRY.test(line)) continue;
    const itemTitle = title(line);
    const index = previous.findIndex(
      (old) => !old.startsWith("📌") && !EXPIRY.test(old) && (isShortening(old, line) || (itemTitle !== undefined && itemTitle === title(old))),
    );
    if (index < 0) throw new HeartbeatExpiryError(line);
    previous.splice(index, 1);
  }
}
// ---- end port

const strip = (line: string) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/, "");
const probeOf = (norm: string) => {
  const t = title(norm.replace(/^📌\s*/, ""));
  return (t ? `**${t}**` : norm).slice(0, 80);
};
// Every 📌 line in the whole file (validator form), verbatim.
const pinLines = (text: string) => text.split(/\r?\n/).map(strip).filter((l) => l.startsWith("📌"));
// Bold title of a 📌 line, past any emoji run after the pin ("📌🔑 **T**" -> "T").
const pinTitle = (norm: string) => /^\*\*(.+?)\*\*/.exec(norm.replace(/^📌[^\w*`]*/u, ""))?.[1] ?? null;
// Short reference key for a pin title: the head before " (", " — ", ": " or ". " when that is distinctive, else 60 chars.
const pinKey = (t: string) => {
  const head = t.split(/ \(| — |: |\. /)[0]!.trim();
  return head.length >= 12 ? head : t.slice(0, 60);
};
// A pin whose head says its item is over. Case-sensitive on DEAD/GONE/CLOSED so "a dead job" in a rule does not count.
const CLOSED_HEAD = /\bitems? [^.;)]{0,40}?\b(?:closed|CLOSED|deleted|retired)\b|\b(?:DEAD|GONE|CLOSED|RETIRED|DELETED)\b|\b(?:deleted|retired|expired)\b|⚰️/;
const sectionText = (text: string, heading: string) => {
  const i = text.indexOf(`\n${heading}`);
  if (i < 0) return "";
  const rest = text.slice(i + 1);
  const m = /\n## /.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
};
const memKey = (r: any) => String(r?.memory ?? "").trim();

// MM-DD -> Date in the year that puts it nearest to (and not >180 days after) today.
function mmdd(m: string, d: string, today: Date): Date {
  let y = today.getUTCFullYear();
  let dt = new Date(Date.UTC(y, Number(m) - 1, Number(d)));
  if (dt.getTime() - today.getTime() > 180 * 86400000) dt = new Date(Date.UTC(y - 1, Number(m) - 1, Number(d)));
  return dt;
}

type Item = { line: number; raw: string; norm: string; probe: string; title: string | null; chars: number; pinned: boolean; expiry: Date | null; closedAt: Date | null; closed: boolean; taskIds: string[] };

function parseHeartbeat(text: string, today: Date) {
  const lines = text.split("\n");
  const sections: Array<{ line: number; heading: string; level: number; chars: number }> = [{ line: 0, heading: "(top)", level: 1, chars: 0 }];
  lines.forEach((l, i) => {
    const m = /^(#{2,3}) /.exec(l);
    if (m) sections.push({ line: i, heading: l.slice(0, 120), level: m[1]!.length, chars: 0 });
    sections[sections.length - 1]!.chars += l.length + 1;
  });
  let tStart = -1;
  lines.forEach((l, i) => {
    if (l.startsWith("## Tracked Items")) tStart = i;
  });
  const items: Item[] = [];
  if (tStart >= 0) {
    for (let i = tStart + 1; i < lines.length; i++) {
      if (/^#{1,2}\s/.test(lines[i]!)) break;
      const norm = strip(lines[i]!);
      if (!norm || norm.startsWith("#") || /^[-*_]{3,}$/.test(norm)) continue;
      const ex = /delete\s+(?:on\s+)?(\d{2})-(\d{2})/i.exec(norm);
      const cl = /(?:CLOSED|MERGED)\s+(\d{2})-(\d{2})/.exec(norm);
      items.push({
        line: i,
        raw: lines[i]!,
        norm,
        probe: probeOf(norm),
        title: title(norm.replace(/^📌\s*/, "")) ?? null,
        chars: lines[i]!.length,
        pinned: norm.startsWith("📌"),
        expiry: ex ? mmdd(ex[1]!, ex[2]!, today) : null,
        closedAt: cl ? mmdd(cl[1]!, cl[2]!, today) : null,
        closed: /⚰️|\bCLOSED\b/.test(norm),
        taskIds: [...new Set(norm.match(UUID) ?? [])],
      });
    }
  }
  return { lines, sections, items, trackedStart: tStart };
}

const shingles = (s: string, k = 8) => {
  const w = s.toLowerCase().replace(/[^a-z0-9#@._/-]+/g, " ").split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
};

// Pure draft check, shared by mode "check" and selftest.
export function checkDraft(env: { live: string; next: string; removed: any[]; deferred: any[]; mustKeep: string[]; maxChars: number; pinMemories?: string[]; lockedPins?: string[] }): string[] {
  const reasons: string[] = [];
  const { live, next } = env;
  try {
    validateHeartbeatExpiry(live, next);
  } catch (e: any) {
    reasons.push(`validator: ${String(e?.message ?? e).slice(0, 220)}`);
  }
  if (!next.includes("## Tracked Items")) reasons.push("draft has no ## Tracked Items heading");
  if (next.length > env.maxChars) reasons.push(`draft ${next.length} chars > ${env.maxChars}`);
  if (next.length >= live.length) reasons.push(`not net-smaller: ${live.length} -> ${next.length}`);
  const nextPins = new Set(pinLines(next));
  // Candidate (2026-10-13): deferred pin edits must agree with the deferred checks below.
  const lostPins = pinLines(live).filter((p) => !nextPins.has(p) && !env.deferred.some((d) => {
    const f = String(d?.find ?? d?.anchor ?? "").trim();
    return f && (p.includes(f) || f.includes(p));
  }));
  // A 📌 line may leave only from Tracked Items, only when the plan did not lock it, and only with a removed[] entry whose
  // `memory` names a memory that exists (or that apply stores before the DB write). Everything else stays locked.
  const liveTracked = new Set(trackedLines(live));
  const known = new Set(env.pinMemories ?? []);
  const locked = (env.lockedPins ?? []).filter(Boolean);
  let harvested = 0;
  const unharvested = lostPins.filter((p) => {
    if (!liveTracked.has(p) || locked.some((k) => p.includes(k))) return true;
    const r = env.removed.find((x: any) => {
      const k = String(x?.title ?? x?.probe ?? "").replace(/^\*\*|\*\*$/g, "");
      return k && (p.includes(k) || k.includes(p.slice(0, 60)));
    });
    if (r && memKey(r) && known.has(memKey(r))) {
      harvested++;
      return false;
    }
    return true;
  });
  if (unharvested.length) reasons.push(`📌 lines changed or dropped: ${unharvested.length} (first: ${unharvested[0]!.slice(0, 80)}; a Tracked Items pin may leave only unlocked, with removed[].memory naming an existing or harvested memory)`);
  if (harvested > MAX_PIN_MEMORIES) reasons.push(`too many pins drained: ${harvested} > ${MAX_PIN_MEMORIES}`);
  // Every live tracked item that is gone (no line with its title, and no line it shortens to) needs a removed[] entry.
  const nextTracked = trackedLines(next);
  const removedKeys = env.removed.map((r: any) => String(r?.title ?? r?.probe ?? "")).filter(Boolean);
  const gone = trackedLines(live).filter((old) => {
    const t = title(old.replace(/^📌\s*/, ""));
    if (t !== undefined && nextTracked.some((l) => title(l.replace(/^📌\s*/, "")) === t)) return false;
    if (nextTracked.includes(old)) return false;
    return !nextTracked.some((l) => l.length >= 20 && isShortening(old, l));
  });
  const unexplained = gone.filter((old) => !removedKeys.some((k) => old.includes(k.replace(/^\*\*|\*\*$/g, "")) || k.includes(old.slice(0, 60))));
  if (unexplained.length) reasons.push(`removed without a removed[] reason: ${unexplained.length} (first: ${unexplained[0]!.slice(0, 80)})`);
  for (const d of env.deferred) {
    const f = String(d?.find ?? d?.anchor ?? "").trim();
    if (f && next.includes(f)) reasons.push(`deferred removal not done: ${d?.actionId ?? f.slice(0, 40)}`);
    const content = String(d?.content ?? "").trim();
    if (content && !next.includes(content)) reasons.push(`deferred replacement not done: ${d?.actionId ?? content.slice(0, 40)}`);
  }
  for (const p of env.mustKeep) if (p && live.includes(p) && !next.includes(p)) reasons.push(`pinned probe dropped: ${p.slice(0, 80)}`);
  // Rule #N labels outside Tracked Items stay (rubric rule 2); a removed[] entry naming the label as retired explains one.
  const outside = (t: string) => {
    const i = t.lastIndexOf("## Tracked Items");
    if (i < 0) return t;
    const rest = t.slice(i);
    const m = /\n#{1,2}\s/.exec(rest.slice(1));
    return t.slice(0, i) + (m ? rest.slice(m.index + 1) : "");
  };
  const labels = (t: string) => new Set(t.match(/Rule #\d+\b/g) ?? []);
  const nextLabels = labels(next);
  const retired = env.removed.map((r: any) => `${r?.title ?? ""} ${r?.probe ?? ""} ${r?.reason ?? ""}`).join(" ");
  const dropped = [...labels(outside(live))].filter((l) => !nextLabels.has(l) && !(retired.includes(l) && /retired/i.test(retired)));
  if (dropped.length) reasons.push(`Rule labels dropped outside Tracked Items: ${dropped.join(", ")}`);
  return reasons;
}

// Handshake: may night N+1 cut Standing Orders text whose probe the procedures skill should now carry?
export function handshake(skill: { systemDefault: number; content: string } | null, probes: string[]) {
  if (!skill) return { status: "no-skill", ready: [] as string[], waiting: probes };
  if (Number(skill.systemDefault)) return { status: "refused: system-default", ready: [] as string[], waiting: probes };
  const ready = probes.filter((p) => skill.content.includes(p));
  return { status: "ok", ready, waiting: probes.filter((p) => !ready.includes(p)) };
}

async function runScript(args: unknown, ctx: ScriptContext) {
  const p = argsSchema.safeParse(args ?? {});
  if (!p.success) return { ok: false, errors: [p.error.message] };
  const a = p.data;
  LEAD = await resolveLead(ctx, (args as any)?.leadAgentId);
  const dry = a.dryRun === true || a.dryRun === "true";
  const writesOn = isOn(a.writes);
  const runId = a.runId ?? "";
  const now = new Date();
  const date = a.date ?? now.toISOString().slice(0, 10);
  const today = new Date(`${date}T00:00:00Z`);
  const errors: string[] = [];
  const q = async (sql: string, params: unknown[] = []) => rows(await ctx.swarm.db_query({ sql, params }));
  const kvGet = async (key: string): Promise<any> => {
    const v = (await ctx.swarm.kv_getOrNull({ namespace: NS, key }))?.value;
    return parse(v) ?? v ?? null;
  };
  const kvSet = async (key: string, value: unknown) => ctx.swarm.kv_set({ namespace: NS, key, value: value as any });
  const kvList = async (prefix: string): Promise<any[]> => {
    try {
      const r: any = await ctx.swarm.kv_list({ namespace: NS, prefix, limit: 200 });
      return (r?.data?.entries ?? r?.entries ?? []).map((e: any) => ({ key: e.key, value: parse(e.value) ?? e.value }));
    } catch (e: any) {
      errors.push(`kv_list ${prefix}: ${String(e?.message ?? e).slice(0, 160)}`);
      return [];
    }
  };
  const liveHb = async () => String((await q(`SELECT heartbeatMd FROM agents WHERE id = ?`, [LEAD]))[0]?.heartbeatMd ?? "");
  const pinsC = async () => (await kvList("pin:C:")).map((e) => String(e.value?.probe ?? "")).filter(Boolean);
  // Every Lead heartbeat that can still run or write: not just in_progress. Fail-closed: a stuck row blocks lane C until cancelled.
  const busyHb = async () =>
    (await q(`SELECT id, status, createdAt FROM agent_tasks WHERE agentId = ? AND taskType = 'heartbeat-checklist' AND status IN (${BUSY.map(() => "?").join(", ")}) ORDER BY createdAt`, [LEAD, ...BUSY])).map((r) => ({
      id: String(r.id),
      status: String(r.status),
      createdAt: String(r.createdAt),
    }));

  try {
    // ---------------- selftest ----------------
    if (a.mode === "selftest") {
      const section = (...l: string[]) => `## Tracked Items\n${l.join("\n")}\n`;
      const passes = (cur: string, next: string) => {
        try {
          validateHeartbeatExpiry(cur, next);
          return true;
        } catch {
          return false;
        }
      };
      // [name, current, next, expectPass] — every case of src/tests/heartbeat-expiry.test.ts "heartbeat expiry validation".
      const V: Array<[string, string, string, boolean]> = [
        ["accepts DELETE 09-30", "", section("- New item. DELETE 09-30"), true],
        ["accepts delete on 09-30", "", section("- New item. delete on 09-30"), true],
        ["accepts DeLeTe ON 09-30", "", section("- New item. DeLeTe ON 09-30"), true],
        ["rejects new undated item", "", section("- Check the queue"), false],
        ["pin durable 1", "", section("📌 Permanent rule"), true],
        ["pin durable 2", "", section("- 📌 Permanent rule"), true],
        ["pin durable 3", "", section("- [ ] 📌 Permanent rule"), true],
        ["pin mid-line not exempt", "", section("- Check 📌 status"), false],
        ...["- **Queue:** Check the queue every morning and evening", "- **Queue:** Check the queue", "- **Queue:** Inspect pending work weekly"].map(
          (l, i) => [`legacy edit ${i}`, section("- **Queue:** Check the queue every morning and evening", "- Keep this item"), section(l, "- Keep this item"), true] as [string, string, string, boolean],
        ),
        ["legacy shorten", section("- Check the queue daily"), section("- Check the queue"), true],
        ["pure deletion", section("- Old undated item"), section(), true],
        ["delete whole section", section("- Old undated item"), "", true],
        ["last marker", "", "## Tracked Items\n- Earlier example\n## Tracked Items (current)\n- New. DELETE 09-30\n## Notes\nUndated notes", true],
        ["marker mid-line", "", "Mention ## Tracked Items here\n- Undated", false],
        ["marker only", "", "## Tracked Items", true],
        ["other section", "", "## Other\n- Undated", true],
        ["token on marker", "", "## Tracked Items DELETE 09-30\n- Undated", false],
        ["token on other line", "", section("- Dated DELETE 09-30", "- Undated"), false],
        ["reordered one-to-one", section("- **Old:** Keep", "- **Other:** Keep"), section("- **Other:** Keep", "- **Old:** Updated"), true],
        ["one old cannot sponsor two", section("- **Old:** Keep", "- **Other:** Keep"), section("- **Old:** Keep", "- **Old:** New"), false],
        ["unrelated new", section("- **Old:** Keep", "- **Other:** Keep"), section("- **Unrelated:** New"), false],
        ["condense middle", section("- Check the large queue daily"), section("- Check the queue"), true],
        ...[
          ["- **Old:** New", "- **Old:** Updated DELETE 09-30"],
          ["- **Old:** Updated DELETE 09-30", "- **Old:** New"],
          ["- Legacy text DELETE 09-30", "- Legacy"],
        ].map((l, i) => [`dating cannot authorize copy ${i}`, section("- **Old:** Original", "- Legacy text"), section(...l), false] as [string, string, string, boolean]),
        ["no date removal", section("- **Old:** DELETE 09-30"), section("- **Old:** Undated"), false],
        ["no pin removal", section("📌 Permanent"), section("Permanent"), false],
      ];
      const parity = V.map(([name, c, n, want]) => ({ name, want: want ? "pass" : "throw", got: passes(c, n) ? "pass" : "throw" }));
      // Check controls on a 12-item fixture.
      const base = Array.from({ length: 12 }, (_, i) => `- **Item ${i}:** undated tracked item number ${i} with some detail text`);
      const live = `# HB\n\n## Standing Orders\n- do things\n\n${section("📌 keep me forever", ...base)}\n## Reference\n- ref\n`;
      const pureDeletion = live.replace(base.slice(0, 10).join("\n") + "\n", "");
      const removed10 = base.slice(0, 10).map((_, i) => ({ title: `Item ${i}:`, reason: "fixture" }));
      const rewriteNoTitle = live.replace(base[0]!, "- a rewritten undated item without its title");
      const c = (next: string, removed: any[]) => checkDraft({ live, next, removed, deferred: [], mustKeep: [], maxChars: 60000 });
      const deferredPin = "📌 keep me forever";
      const deferred = [{ actionId: "A1", op: "replace", find: deferredPin, content: "📌 keep me" }];
      const unrelatedPin = "📌 unrelated durable rule";
      const deferredLive = live.replace(deferredPin, deferredPin + "\n" + unrelatedPin);
      const applied = pureDeletion.replace(deferredPin, deferred[0]!.content).replace(deferred[0]!.content, deferred[0]!.content + "\n" + unrelatedPin);
      const dc = (next: string) => checkDraft({ live: deferredLive, next, removed: [...removed10, { title: deferredPin, reason: "deferred A1 replacement" }], deferred, mustKeep: [], maxChars: 60000 });
      const deferredChecks = [
        { name: "deferred+ pin replacement applied", reasons: dc(applied), expected: "" },
        { name: "deferred- unrelated pin dropped", reasons: dc(applied.replace(unrelatedPin + "\n", "")), expected: "📌 lines changed or dropped" },
        { name: "deferred- pin replacement not applied", reasons: dc(pureDeletion.replace(deferredPin, deferredPin + "\n" + unrelatedPin)), expected: "deferred removal not done" },
        { name: "deferred- replacement content missing", reasons: dc(applied.replace(deferred[0]!.content + "\n", "")), expected: "deferred replacement not done" },
      ].map((x) => ({ name: x.name, pass: x.expected ? x.reasons.some((r) => r.startsWith(x.expected)) : x.reasons.length === 0, reasons: x.reasons }));
      const checks = [
        { name: "check- rewrite of undated item drops its **title** -> refused", got: c(rewriteNoTitle, []), wantRefused: true },
        { name: "check+ pure deletion of 10 items with reasons -> passes", got: c(pureDeletion, removed10), wantRefused: false },
        { name: "check- pure deletion with no removed[] reasons -> refused", got: c(pureDeletion, []), wantRefused: true },
        { name: "check- Rule #N label in Standing Orders dropped -> refused", got: checkDraft({ live: live.replace("- do things", "- do things per Rule #7"), next: pureDeletion, removed: removed10, deferred: [], mustKeep: [], maxChars: 60000 }), wantRefused: true },
        { name: "check- 📌 line dropped -> refused", got: c(pureDeletion.replace("📌 keep me forever\n", ""), removed10), wantRefused: true },
      ].map((x) => ({ name: x.name, pass: (x.got.length > 0) === x.wantRefused, reasons: x.got.slice(0, 2) }));
      // Pin drain controls: a Tracked Items pin leaves only unlocked and with removed[].memory naming a known memory.
      const pinLive = live.replace("## Standing Orders\n- do things", "## Standing Orders\n- do things\n- 📌 standing pin");
      const pinGone = pureDeletion.replace("📌 keep me forever\n", "");
      const pinRm = (memory?: string) => [...removed10, { probe: "📌 keep me forever", reason: "closed", movedTo: "memory", ...(memory ? { memory } : {}) }];
      const pc = (next: string, removed: any[], extra: { pinMemories?: string[]; lockedPins?: string[] } = {}) =>
        checkDraft({ live: pinLive, next, removed, deferred: [], mustKeep: [], maxChars: 60000, ...extra });
      const pinChecks = [
        { name: "pin+ tracked pin removed with a known memory -> passes", got: pc(pinGone.replace("- do things", "- do things\n- 📌 standing pin"), pinRm("pin-mem"), { pinMemories: ["pin-mem"] }), wantRefused: false },
        { name: "pin- tracked pin removed, memory unknown -> refused", got: pc(pinGone.replace("- do things", "- do things\n- 📌 standing pin"), pinRm("pin-mem"), { pinMemories: [] }), wantRefused: true },
        { name: "pin- tracked pin removed, no removed[].memory -> refused", got: pc(pinGone.replace("- do things", "- do things\n- 📌 standing pin"), pinRm(), { pinMemories: ["pin-mem"] }), wantRefused: true },
        { name: "pin- tracked pin locked by plan -> refused", got: pc(pinGone.replace("- do things", "- do things\n- 📌 standing pin"), pinRm("pin-mem"), { pinMemories: ["pin-mem"], lockedPins: ["📌 keep me"] }), wantRefused: true },
        { name: "pin- 📌 outside Tracked Items dropped -> refused", got: pc(pureDeletion, [...removed10, { probe: "📌 standing pin", reason: "closed", memory: "pin-mem" }], { pinMemories: ["pin-mem"] }), wantRefused: true },
        { name: "pin+ drained draft passes the server validator", got: passes(pinLive, pinGone) ? [] : ["validator"], wantRefused: false },
      ].map((x) => ({ name: x.name, pass: (x.got.length > 0) === x.wantRefused, reasons: x.got.slice(0, 2) }));
      const pt = [
        { name: "pinTitle skips the emoji run", pass: pinTitle("📌🔑 **BLG GONE: cancelled 10-03** rest") === "BLG GONE: cancelled 10-03" },
        { name: "closed head+ item N closed", pass: CLOSED_HEAD.test("PRE-PUSH DURABLES (item 255 closed on #1317)") },
        { name: "closed head- lowercase dead in a rule", pass: !CLOSED_HEAD.test("it cannot distinguish a dead job from a correctly-infrequent one") },
      ];
      const hs = [
        { name: "handshake- systemDefault skill refused", pass: handshake({ systemDefault: 1, content: "probe A" }, ["probe A"]).status === "refused: system-default" },
        { name: "handshake+ probe present -> ready", pass: handshake({ systemDefault: 0, content: "x probe A y" }, ["probe A"]).ready.length === 1 },
        { name: "handshake- probe absent -> waiting", pass: handshake({ systemDefault: 0, content: "x y" }, ["probe A"]).waiting.length === 1 },
      ];
      const ok = parity.every((r) => r.want === r.got) && checks.every((x) => x.pass) && deferredChecks.every((x) => x.pass) && pinChecks.every((x) => x.pass) && pt.every((x) => x.pass) && hs.every((x) => x.pass);
      return { ok, mode: "selftest", parity: { cases: parity.length, results: parity.map((r) => ({ name: r.name, pass: r.want === r.got })), mismatches: parity.filter((r) => r.want !== r.got) }, checks, deferredChecks, pinChecks, pinParse: pt, handshake: hs };
    }

    // ---------------- plan ----------------
    if (a.mode === "plan") {
      const live = await liveHb();
      const planSha = await sha(live);
      const hb = parseHeartbeat(live, today);
      const items = hb.items;
      const dayMs = 86400000;
      // Terminal-task lookup for every referenced task id (bounded).
      const ids = [...new Set(items.flatMap((i) => i.taskIds))].slice(0, 400);
      const term = new Map<string, any>();
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const r = await q(`SELECT id, status, finishedAt FROM agent_tasks WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
        for (const x of r) term.set(x.id, x);
      }
      const isOld = (t: any) => ["completed", "failed", "cancelled"].includes(String(t?.status)) && t?.finishedAt && now.getTime() - Date.parse(t.finishedAt) > 7 * dayMs;
      const seen = new Map<string, number>();
      const remove: any[] = [];
      const review: any[] = [];
      for (const it of items) {
        if (it.pinned) continue;
        const row = { line: it.line, probe: it.probe, chars: it.chars };
        if (it.expiry && it.expiry.getTime() <= today.getTime()) remove.push({ ...row, reason: `due: DELETE ${it.expiry.toISOString().slice(5, 10)}` });
        else if (it.closed && it.closedAt && now.getTime() - it.closedAt.getTime() > 2 * dayMs) remove.push({ ...row, reason: `closed ${it.closedAt.toISOString().slice(5, 10)} (>48h)` });
        else if (it.norm.length >= 20 && seen.has(it.norm)) remove.push({ ...row, reason: `exact duplicate of line ${seen.get(it.norm)}` });
        else if (it.taskIds.length && it.taskIds.every((id) => isOld(term.get(id)))) review.push({ ...row, reason: `all ${it.taskIds.length} referenced task(s) terminal >7d` });
        seen.set(it.norm, it.line);
      }
      const closedUndated = items.filter((i) => !i.pinned && i.closed && !i.closedAt).map((i) => ({ line: i.line, probe: i.probe, reason: "⚰️/CLOSED without a date" }));
      // Tracked Items 📌 lines are drain candidates. Locked when Standing Orders, Reference, a named script or a workflow
      // definition references the bold title (its key). The draft keeps a candidate that holds an open next action.
      const refText: Array<[string, string]> = [
        ["standing-orders", sectionText(live, "## Standing Orders")],
        ["reference", sectionText(live, "## Reference")],
      ];
      const pinCandidates: any[] = [];
      for (const it of items.filter((i) => i.pinned)) {
        const t = pinTitle(it.norm);
        const key = t ? pinKey(t) : it.norm.replace(/^📌[^\w*`]*/u, "").slice(0, 60);
        const refs = refText.filter(([, s]) => s.includes(key)).map(([k]) => k);
        const sr = await q(`SELECT name, scope FROM scripts WHERE isScratch = 0 AND name NOT GLOB 'dreaming-heartbeat*' AND instr(source, ?) > 0 LIMIT 3`, [key]);
        refs.push(...sr.map((r) => `script:${r.name}/${r.scope}`));
        const wr = await q(`SELECT id, name FROM workflows WHERE instr(definition, ?) > 0 LIMIT 3`, [key]);
        refs.push(...wr.map((r) => `workflow:${r.name}/${String(r.id).slice(0, 8)}`));
        pinCandidates.push({ line: it.line, probe: it.norm.slice(0, 80), title: t, key, chars: it.chars, closedHead: !!t && CLOSED_HEAD.test(t), refs, locked: refs.length > 0 });
      }
      // Pins the last applied draft kept (open next action) sit out for 7 days, so they do not wake lane C every night.
      const stPins = await kvGet("hb-state:lead");
      const kept: string[] = stPins?.at && now.getTime() - Date.parse(stPins.at) < 7 * dayMs && Array.isArray(stPins.keptPins) ? stPins.keptPins.map(String).filter(Boolean) : [];
      for (const c of pinCandidates) c.kept = kept.some((k) => c.probe.startsWith(k.slice(0, 60)) || k.startsWith(c.probe.slice(0, 60)));
      // Closed heads first, then the largest; the draft drains at most MAX_PIN_MEMORIES a night.
      pinCandidates.sort((x, y) => Number(y.closedHead) - Number(x.closedHead) || y.chars - x.chars);
      // memory-search each unlocked candidate so the draft updates an existing memory instead of creating a twin.
      const searchable = pinCandidates.filter((c) => !c.locked).slice(0, MAX_PIN_MEMORIES * 2);
      for (let i = 0; i < searchable.length; i += 6) {
        await Promise.all(
          searchable.slice(i, i + 6).map(async (c) => {
            try {
              const r: any = await ctx.swarm.memory_search({ query: String(c.title ?? c.key).slice(0, 200), intent: "dreaming lane C: find an existing memory before draining a heartbeat pin", scope: "swarm", limit: 3 });
              const hits: any[] = r?.data?.results ?? r?.results ?? r?.data?.memories ?? r?.memories ?? [];
              c.memoryHits = hits.slice(0, 3).map((h: any) => ({ id: h.id, name: h.name, similarity: h.similarity ?? h.score ?? null }));
            } catch (e: any) {
              c.memoryHits = [];
              errors.push(`memory_search pin ${c.line}: ${String(e?.message ?? e).slice(0, 120)}`);
            }
          }),
        );
      }
      // LLM candidates.
      const over500 = items.filter((i) => i.chars > TARGETS.itemChars).map((i) => ({ line: i.line, probe: i.probe, chars: i.chars }));
      const soIdx = hb.sections.findIndex((s) => s.heading.startsWith("## Standing Orders"));
      const so = soIdx >= 0 ? hb.sections.slice(soIdx + 1).filter((s, i, arr) => s.level === 3 && arr.slice(0, i).every((x) => x.level === 3)) : [];
      const soTotal = so.reduce((n, s) => n + s.chars, 0);
      const perSection = so.length ? Math.floor(TARGETS.standingOrdersChars / so.length) : 0;
      const sectionsOver = so.filter((s) => s.chars > perSection).map((s) => ({ heading: s.heading, chars: s.chars, target: perSection }));
      // Duplicates with Lead's other fields and the procedures skill (8-word shingles, overlap >= 0.6).
      const lead = (await q(`SELECT claudeMd, toolsMd, soulMd, identityMd FROM agents WHERE id = ?`, [LEAD]))[0] ?? {};
      const skillRows = await q(`SELECT id, name, systemDefault, content FROM skills WHERE name IN (?, 'heartbeat-runbook')`, [a.skillName ?? PROCEDURES_SKILL]);
      const procSkill = skillRows.find((s: any) => s.name === (a.skillName ?? PROCEDURES_SKILL)) ?? null;
      const others: Array<[string, string]> = [
        ["claudeMd", String(lead.claudeMd ?? "")],
        ["toolsMd", String(lead.toolsMd ?? "")],
        ["soulMd", String(lead.soulMd ?? "")],
        ["identityMd", String(lead.identityMd ?? "")],
        ...skillRows.map((s: any) => [`skill:${s.name}`, String(s.content ?? "")] as [string, string]),
      ];
      const otherSh = others.map(([k, t]) => [k, shingles(t)] as [string, Set<string>]);
      const dupes: any[] = [];
      hb.lines.forEach((l, i) => {
        if (l.length < 200) return;
        const sh = shingles(l);
        if (sh.size < 5) return;
        for (const [k, o] of otherSh) {
          let n = 0;
          for (const s of sh) if (o.has(s)) n++;
          const r = n / sh.size;
          if (r >= 0.6) {
            dupes.push({ line: i, probe: probeOf(strip(l)), chars: l.length, dupOf: k, overlap: Math.round(r * 100) / 100 });
            break;
          }
        }
      });
      const applyRes = parse(a.apply) ?? {};
      const deferred: any[] = Array.isArray(applyRes.deferredToHeartbeat) ? applyRes.deferredToHeartbeat : [];
      const pins = await pinsC();
      // Restores queued by apply (synthesis restores[] on lane C cuts): the next draft re-inserts these lines.
      const mustRestore: any[] = [];
      for (const v of (await kvList("hb-restore:")).map((e) => e.value).filter((v) => v?.probe)) {
        const pre = await kvGet(`hb-preimage:${v.runId}`);
        const line = typeof pre?.text === "string" ? pre.text.split("\n").find((l: string) => l.includes(v.probe)) ?? null : null;
        mustRestore.push({ cutId: v.cutId, probe: v.probe, line, present: live.includes(v.probe) });
      }
      // Handshake for last night's runbookAdds.
      const adds = await kvGet("hb-runbook-adds:latest");
      const addProbes: string[] = Array.isArray(adds?.adds) ? adds.adds.map((x: any) => String(x?.probe ?? "")).filter(Boolean) : [];
      const hs = handshake(procSkill ? { systemDefault: Number(procSkill.systemDefault), content: String(procSkill.content ?? "") } : null, addProbes);
      // Survival of the last applied prune.
      const st = await kvGet("hb-state:lead");
      let survival: any = { status: "none" };
      if (st?.afterSha) {
        if (planSha === st.afterSha) survival = { status: "intact", runId: st.runId };
        else if (planSha === st.beforeSha) survival = { status: "reverted", runId: st.runId, action: "re-run lead-disk + hb-apply with hb-state.afterText" };
        else {
          const back = (Array.isArray(st.removedProbes) ? st.removedProbes : []).filter((pr: string) => pr && live.includes(pr));
          survival = { status: back.length ? "reintroduced" : "drifted", runId: st.runId, reintroduced: back.slice(0, 30) };
        }
      }
      const pinCount = pinLines(live).length;
      const trackedChars = items.reduce((n, i) => n + i.chars + 1, 0);
      const runShort = (runId || "manual").slice(0, 8);
      return {
        ok: true,
        mode: dry ? "dry-run" : "live",
        runId,
        date,
        planSha,
        chars: live.length,
        lines: hb.lines.length,
        targets: { ...TARGETS, maxChars: st?.afterSha ? TARGETS.steadyChars : TARGETS.firstRunChars },
        sections: hb.sections.map((s) => ({ heading: s.heading, chars: s.chars })),
        tracked: {
          count: items.length,
          chars: trackedChars,
          pinned: items.filter((i) => i.pinned).length,
          dated: items.filter((i) => i.expiry).length,
          undated: items.filter((i) => !i.expiry && !i.pinned).length,
          over500: over500.length,
          over1000: items.filter((i) => i.chars > 1000).length,
          due: remove.filter((r) => r.reason.startsWith("due")).length,
        },
        pinLines: pinCount,
        standingOrders: { chars: soTotal, target: TARGETS.standingOrdersChars, sections: so.map((s) => ({ heading: s.heading, chars: s.chars })) },
        candidates: { remove, review, closedUndated, over500, sectionsOver, dupes: dupes.slice(0, 60), pins: pinCandidates },
        pinDrain: {
          cap: MAX_PIN_MEMORIES,
          candidates: pinCandidates.length,
          unlocked: pinCandidates.filter((c) => !c.locked).length,
          closedHead: pinCandidates.filter((c) => c.closedHead).length,
          // Wakes lane C on its own only for closed-head pins (the pile-up); other unlocked pins drain when lane C drafts anyway.
          drainable: pinCandidates.filter((c) => !c.locked && !c.kept && c.closedHead).length,
        },
        lockedPins: pinCandidates.filter((c) => c.locked).map((c) => c.probe),
        deferredToHeartbeat: deferred,
        pins,
        mustRestore,
        handshake: { skill: procSkill ? { id: procSkill.id, name: procSkill.name, systemDefault: Number(procSkill.systemDefault) } : null, ...hs },
        runbookSkill: a.skillName ?? PROCEDURES_SKILL,
        survival,
        draftPath: `dreaming-v2/drafts/${date}/${runShort}/lead-heartbeat.md`,
        backupPath: `dreaming-v2/backups/${date}/lead/heartbeatMd.md`,
        errors,
      };
    }

    // ---------------- quiet (read-only; lead-disk calls it inside its copy command) ----------------
    if (a.mode === "quiet") {
      const busy = await busyHb();
      return { ok: true, quiet: busy.length === 0, busy, at: now.toISOString() };
    }

    // ---------------- text / stage ----------------
    if (a.mode === "text") {
      const live = await liveHb();
      return { ok: true, planSha: await sha(live), chars: live.length, text: live };
    }
    if (a.mode === "stage") {
      const text = a.text ?? "";
      if (!runId || !text.trim()) return { ok: false, errors: ["stage needs runId and text"] };
      const draftSha = await sha(text);
      await kvSet(`hb-draft:${runId}`, { runId, text, sha256: draftSha, chars: text.length, at: now.toISOString() });
      const back = await kvGet(`hb-draft:${runId}`);
      return { ok: back?.sha256 === draftSha && (await sha(String(back?.text ?? ""))) === draftSha, draftKey: `hb-draft:${runId}`, draftSha, chars: text.length };
    }

    const plan = parse(a.plan) ?? {};
    const draftRaw = parse(a.draft) ?? {};
    const draft = parse(draftRaw.taskOutput) ?? draftRaw;
    if (typeof draft.heartbeat !== "string" && typeof draft.draftKey === "string" && draft.draftKey.startsWith("hb-draft:")) {
      const staged = await kvGet(draft.draftKey);
      if (typeof staged?.text === "string") draft.heartbeat = staged.text;
    }

    // ---------------- check ----------------
    if (a.mode === "check") {
      const reasons: string[] = [];
      const next = typeof draft.heartbeat === "string" ? draft.heartbeat : "";
      if (!plan.planSha) reasons.push("no plan");
      if (!next.trim()) reasons.push("no draft text (hb-draft failed or returned no heartbeat)");
      const live = await liveHb();
      const liveSha = await sha(live);
      if (plan.planSha && liveSha !== plan.planSha) reasons.push(`db-drift since plan: ${liveSha.slice(0, 12)} != ${String(plan.planSha).slice(0, 12)}`);
      const draftSha = next ? await sha(next) : null;
      if (next && draft.draftSha && draft.draftSha !== draftSha) reasons.push(`draftSha mismatch: returned ${String(draft.draftSha).slice(0, 12)}, text hashes to ${String(draftSha).slice(0, 12)}`);
      if (next && !draft.draftPath) reasons.push("no draftPath (lead-disk needs the agent-fs copy)");
      // The draft comes from a pool worker and lead-disk puts the path in a Lead shell command: accept only the
      // plan's own path, and only in the shape the plan builds.
      const pathOk = DRAFT_PATH_RE.test(String(plan.draftPath ?? "")) && draft.draftPath === plan.draftPath;
      if (next && draft.draftPath && !pathOk) reasons.push(`draftPath is not the plan's draftPath: ${JSON.stringify(String(draft.draftPath).slice(0, 120))}`);
      const removed: any[] = Array.isArray(draft.removed) ? draft.removed : [];
      // Memories a removed pin may name: one that exists now (name or id), or one this draft harvests (apply stores it first).
      const harvest = (Array.isArray(draft.movedToMemory) ? draft.movedToMemory : []).filter((m: any) => /^[a-z0-9-]{3,90}$/.test(String(m?.name ?? "")) && String(m?.content ?? "").trim());
      const pinMemories: string[] = harvest.map((m: any) => String(m.name));
      const named = [...new Set(removed.map(memKey).filter((k) => k && !pinMemories.includes(k)))];
      for (const k of named) if ((await q(`SELECT 1 FROM agent_memory WHERE name = ? OR id = ? LIMIT 1`, [k, k])).length) pinMemories.push(k);
      if (next) {
        reasons.push(
          ...checkDraft({
            live,
            next,
            removed,
            deferred: Array.isArray(plan.deferredToHeartbeat) ? plan.deferredToHeartbeat : [],
            mustKeep: Array.isArray(plan.pins) ? plan.pins : [],
            maxChars: Number(plan.targets?.maxChars ?? TARGETS.firstRunChars),
            pinMemories,
            lockedPins: Array.isArray(plan.lockedPins) ? plan.lockedPins : [],
          }),
        );
      }
      const diskMode = !dry && writesOn ? "live" : "dry";
      // Quiet window: no live Lead heartbeat (pending, in_progress, paused...). Live writes wait (poll every 30 s); dry checks once.
      // lead-disk re-checks with mode "quiet" inside its copy command, so the gap until the copy is covered too.
      let busyRows = await busyHb();
      const waitMs = diskMode === "live" ? (a.waitMs ?? 240000) : 0;
      const t0 = Date.now();
      while (busyRows.length > 0 && Date.now() - t0 + 30000 <= waitMs) {
        await new Promise((r) => setTimeout(r, 30000));
        busyRows = await busyHb();
      }
      const quiet = busyRows.length === 0;
      if (diskMode === "live" && !quiet) reasons.push(`no quiet window: ${busyRows.length} live Lead heartbeat task(s) after ${Math.round((Date.now() - t0) / 1000)}s: ${busyRows.map((b) => `${b.id.slice(0, 8)}/${b.status}`).join(", ")}`);
      const ready = reasons.length === 0;
      return {
        ok: true,
        mode: dry ? "dry-run" : "live",
        ready,
        port: ready ? "run" : "skip",
        diskMode,
        reasons,
        quiet,
        busy: busyRows,
        planSha: plan.planSha ?? null,
        draftSha,
        draftPath: pathOk ? plan.draftPath : null,
        stats: {
          liveChars: live.length,
          draftChars: next.length,
          pinsBefore: pinLines(live).length,
          pinsAfter: pinLines(next).length,
          trackedBefore: trackedLines(live).length,
          trackedAfter: trackedLines(next).length,
          removed: removed.length,
          compressed: Array.isArray(draft.compressed) ? draft.compressed.length : 0,
          movedToMemory: Array.isArray(draft.movedToMemory) ? draft.movedToMemory.length : 0,
          pinsDrained: pinLines(live).length - pinLines(next).length,
          pinMemories: [...new Set(removed.map(memKey).filter(Boolean))].length,
          runbookAdds: Array.isArray(draft.runbookAdds) ? draft.runbookAdds.length : 0,
        },
        errors,
      };
    }

    // ---------------- apply ----------------
    if (a.mode === "apply") {
      const check = parse(a.check) ?? {};
      const diskRaw = parse(a.disk) ?? {};
      const disk = parse(diskRaw.taskOutput) ?? diskRaw;
      const next = typeof draft.heartbeat === "string" ? draft.heartbeat : "";
      const draftSha = next ? await sha(next) : "";
      const removed: any[] = Array.isArray(draft.removed) ? draft.removed : [];
      const diskField = (Array.isArray(disk.fields) ? disk.fields : []).find((f: any) => f?.field === "heartbeatMd") ?? null;
      const base = { ok: true, runId, planSha: plan.planSha ?? null, draftSha, draftChars: next.length, removed: removed.length, disk: disk.mode ? { mode: disk.mode, ...diskField } : null };
      if (!check.ready) return { ...base, status: "skipped", reason: `check not ready: ${(check.reasons ?? []).slice(0, 3).join("; ") || "no check"}`, errors };
      const diskDryOk = !!diskField && diskField.diskBeforeSha === plan.planSha && diskField.draftShaOk === true;
      if (dry || !writesOn || check.diskMode !== "live") {
        return { ...base, status: "wouldApply", gate: dry ? "dryRun" : !writesOn ? "v3Writes off" : "check.diskMode dry", diskDryOk, errors };
      }
      if (disk.mode !== "live" || !diskField || diskField.diskAfterSha !== draftSha) {
        return { ...base, ok: false, status: "refused: disk-not-written", detail: diskField?.stopReason ?? `disk after ${String(diskField?.diskAfterSha ?? "none").slice(0, 12)} != draft ${draftSha.slice(0, 12)}`, errors };
      }
      const backupPath = String(draft.backupPath ?? plan.backupPath ?? "");
      const diskBackup = `/workspace/personal/heartbeat-backups/${runId}.md`;
      // Memories land BEFORE the DB write, so a drained pin is never only in a backup. A pin memory whose name already
      // exists (or an entry with updateOf) is appended to that memory instead of creating a twin.
      const pinNames = new Set(removed.map(memKey).filter(Boolean));
      // A tool refusal comes back as HTTP 200 with data.success false, so judge the tool's verdict, not the transport's.
      const refusal = (r: any) =>
        !r || r.success === false || r.isError || r.data?.success === false || r.data?.isError
          ? String(r?.data?.message ?? r?.data?.error ?? r?.message ?? `status ${r?.status ?? "none"}`).slice(0, 160)
          : "";
      const storeMemory = async (name: string, content: string, tags: string[]) => {
        const r: any = await ctx.swarm.memory_store({ name, content, scope: "swarm", tags, intent: `dreaming lane C ${runId}` } as any);
        const why = refusal(r);
        const id = String(r?.data?.memoryIds?.[0] ?? "");
        if (why || !id) throw new Error(why || "memory_store returned no id");
        return id;
      };
      // A fact is one harvested line, compared after whitespace and case normalization only: a sign, digit or
      // punctuation mark that differs makes it a different fact. A fact must be a whole line of the document, never
      // part of a longer one: "Never use X." does not hold "Use X.".
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const factsOf = (text: string) => [...new Set(text.split("\n").map(norm).filter(Boolean))];
      // The chunker (src/be/chunking.ts) cuts a section longer than CHUNK at "\n\n", "\n", ". " or " " (or mid-word),
      // drops that separator, and starts the next chunk with an optional heading line, then an overlap per split level:
      // the last 100 characters of the cut piece (all of it when shorter), or of the overlapped piece one level up.
      // Returns the raw text after the overlaps, or null when `chunk` does not start so.
      const CHUNK = 2000;
      const afterCut = (prev: string, prevOwn: string, chunk: string) => {
        const glues = [prev.slice(-100), prevOwn.slice(-100)].filter(Boolean).sort((x, y) => y.length - x.length);
        let rest = chunk.replace(/^#{1,3} [^\n]*\n\n/, "");
        let cut = false;
        for (let g = glues.find((x) => rest.startsWith(x)); g; g = glues.find((x) => rest.startsWith(x))) {
          rest = rest.slice(g.length);
          cut = true;
        }
        return cut ? rest : null;
      };
      // The facts of `text` that a document's chunks lack. Each fact must equal a whole line. A line at a cut is whole
      // only when the cut is provably between lines: the heading changes, a neighbour holds a line break (the pieces of
      // a cut line never do), or the two pieces are too short to be one line the chunker had to cut. Otherwise the fact
      // must span the cut, missing only the separator the chunker dropped there.
      const lacking = (chunks: string[], text: string) => {
        const n = chunks.length;
        const heads = chunks.map((c) => (n > 1 ? (/^(#{1,3} [^\n]*)\n\n/.exec(c)?.[1] ?? "") : ""));
        const first = (i: number) => i === 0 || heads[i] !== heads[i - 1];
        const pieces: Array<{ own: string; cut: boolean; hidden: boolean; nl: boolean; dot: boolean }> = [];
        chunks.forEach((c, i) => {
          const rest = first(i) ? null : afterCut(chunks[i - 1] ?? "", pieces[i - 1]?.own ?? "", c);
          const own = rest ?? c.slice(heads[i] ? (heads[i] ?? "").length + 2 : 0);
          // An overlap the cut check could not confirm hides at the start, with line breaks of the chunk before it.
          const hidden = !first(i) && rest === null;
          // A section's first piece under 50 characters is dropped, and its text glues onto the next one unseparated.
          const skip = hidden ? 200 : first(i) ? 49 : 0;
          const tail = own.slice(skip);
          pieces.push({ own, cut: rest !== null, hidden, nl: tail.includes("\n"), dot: !hidden && tail.includes(". ") });
        });
        const lineCut = (i: number) => {
          const a = pieces[i - 1];
          const b = pieces[i];
          if (!a || !b || b.hidden) return false;
          if (heads[i] !== heads[i - 1] || a.nl || b.nl) return true;
          // A cut inside a line packs whole sentences: the next one would not have fit in the piece before. That holds
          // only when the piece before packs sentences itself (it holds ". "): after a sentence too long for one chunk,
          // cut at spaces, the next sentence starts a fresh chunk whatever its length. And the next sentence must be
          // whole in view: it ends inside this piece, or this piece ends the section.
          const next = b.own.split("\n")[0] ?? "";
          if (!a.dot || (!next.includes(". ") && i < n - 1 && !first(i + 1))) return false;
          return a.own.length + 2 + (next.split(". ")[0] ?? "").length <= CHUNK;
        };
        const starts = (i: number) => i === 0 || lineCut(i);
        const ends = (i: number) => i === n - 1 || lineCut(i + 1);
        // The ways a piece may split into lines: its own line breaks, plus, at a section's first piece, the end of a
        // dropped short piece (no whitespace on either side, and a part long enough to have forced the cut after it).
        const views = (i: number) => {
          const t = pieces[i]?.own ?? "";
          const out = [t.split("\n")];
          if (n < 2 || !first(i)) return out;
          for (let k = 1; k < Math.min(50, t.length); k++) {
            if (!/\S/.test(t[k - 1] ?? "") || !/\S/.test(t[k] ?? "")) continue;
            const part = t.slice(k).split("\n\n")[0] ?? "";
            const goesOn = part.length === t.length - k && i + 1 < n && !first(i + 1);
            if (part.length < CHUNK - k - 2 && !goesOn) continue;
            const twice = t.startsWith(t.slice(0, k), k);
            out.push(`${t.slice(0, k)}\n${twice ? `${t.slice(k, 2 * k)}\n${t.slice(2 * k)}` : t.slice(k)}`.split("\n"));
          }
          return out;
        };
        const whole = new Set<string>();
        const joins: Array<[string, string]> = [];
        for (let i = 0; i < n; i++) {
          // The heading line joins the section's heading stack with " > "; each heading line is a run of it.
          const stack = (heads[i] ?? "").split(" > ");
          for (let s = 0; s < stack.length; s++) for (let e = s + 1; e <= stack.length; e++) if (norm(stack.slice(s, e).join(" > "))) whole.add(norm(stack.slice(s, e).join(" > ")));
          for (const lines of views(i)) {
            lines.forEach((l, j) => {
              if (j === 0 && (pieces[i]?.hidden || !starts(i))) return;
              if (j === lines.length - 1 && !ends(i)) return;
              if (norm(l)) whole.add(norm(l));
            });
            const next = pieces[i + 1];
            const h = lines[lines.length - 1] ?? "";
            const opens = lines.length > 1 || (starts(i) && !pieces[i]?.hidden);
            if (next?.cut && !lineCut(i + 1) && opens && ends(i + 1)) joins.push([h, next.own.split("\n")[0] ?? ""]);
          }
        }
        return factsOf(text).filter((f) => !whole.has(f) && !joins.some(([h, r]) => ["", " ", ". "].some((sep) => norm(`${h}${sep}${r}`) === f)));
      };
      // The whole document a row belongs to, whether any chunk expires, and whether every chunk was found. Chunks of an
      // explicit key share it. An auto key (scope/source/id) differs per chunk, so its siblings are the rows of the same
      // store: same name, scope, owner, source and totalChunks, one per chunkIndex, created nearest to this row.
      const docOf = async (id: string) => {
        const row = (await q(`SELECT id, key, name, scope, source, agentId, totalChunks, content, expiresAt, createdAt FROM agent_memory WHERE id = ? LIMIT 1`, [id]))[0];
        if (!row) return null;
        const total = Math.max(1, Number(row.totalChunks ?? 1));
        let parts: any[] = [row];
        if (row.key && row.key !== `${row.scope}/${row.source}/${row.id}`) {
          parts = await q(`SELECT content, expiresAt FROM agent_memory WHERE key = ? AND scope = ? AND agentId IS ? ORDER BY chunkIndex`, [row.key, row.scope, row.agentId]);
        } else if (total > 1) {
          const at = Date.parse(String(row.createdAt));
          const gap = (r: any) => Math.abs(Date.parse(String(r.createdAt)) - at);
          const rows = await q(`SELECT chunkIndex, content, expiresAt, createdAt FROM agent_memory WHERE name = ? AND scope = ? AND agentId IS ? AND source = ? AND totalChunks = ? AND (key IS NULL OR key = scope || '/' || source || '/' || id)`, [row.name, row.scope, row.agentId, row.source, total]);
          parts = [];
          for (let i = 0; i < total; i++) {
            const near = rows.filter((r: any) => Number(r.chunkIndex) === i && gap(r) <= 60000).sort((x: any, y: any) => gap(x) - gap(y))[0];
            if (near) parts.push(near);
          }
        }
        const chunks = parts.map((p: any) => String(p.content ?? ""));
        return { id: String(row.id), chunks, text: chunks.join("\n"), expiring: parts.some((p: any) => p.expiresAt != null), complete: parts.length === total };
      };
      // The draft comes from a worker task, so its updateOf (or a name it shares with an old row) is a claim, not
      // authority. Only a row the Lead's plan found for an unlocked pin candidate may be edited in place, and never a
      // curated /longterm doc; any other target gets a new sibling row that points back.
      const editable = new Set<string>(
        (Array.isArray(plan.candidates?.pins) ? plan.candidates.pins : [])
          .filter((c: any) => c && !c.locked)
          .flatMap((c: any) => (Array.isArray(c.memoryHits) ? c.memoryHits : []).map((h: any) => String(h?.id ?? "")))
          .filter(Boolean),
      );
      const editRefusal = (hit: any) => {
        const key = String(hit?.key ?? "");
        if (key === "/longterm" || key.startsWith("/longterm/")) return "curated /longterm doc";
        if (!editable.has(String(hit?.id ?? ""))) return "not a plan pin-candidate memory hit";
        if (Number(hit?.totalChunks ?? 1) !== 1) return "multi-chunk";
        return "";
      };
      const pinTags = ["dreaming-v2", runId, "heartbeat", "heartbeat-pin"];
      // Pin key (entry name and its updateOf) -> the row that now holds the text, and the text whose facts must be in it.
      const held = new Map<string, { id: string; text: string }>();
      // Pin keys whose entry failed to write: an older row under the same name does not hold this run's text.
      const failed = new Set<string>();
      const memories: any[] = [];
      let general = 0;
      let pinned = 0;
      for (const m of Array.isArray(draft.movedToMemory) ? draft.movedToMemory : []) {
        const name = String(m?.name ?? "");
        const content = String(m?.content ?? "");
        const target = String(m?.updateOf ?? "").trim();
        const isPin = pinNames.has(name) || (!!target && pinNames.has(target));
        if (isPin ? ++pinned > MAX_PIN_MEMORIES : ++general > MAX_MEMORIES) { memories.push({ name, status: "refused: cap" }); continue; }
        if (!/^[a-z0-9-]{3,90}$/.test(name) || !content.trim()) { memories.push({ name, status: "refused" }); continue; }
        const keep = (id: string, status: string, extra: Record<string, unknown> = {}) => {
          memories.push({ name, id, status, ...extra });
          if (isPin) for (const k of [name, target]) if (k) held.set(k, { id, text: content });
        };
        try {
          const ex = await q(`SELECT id, key, name, totalChunks, content FROM agent_memory WHERE id = ? OR (name = ? AND chunkIndex = 0) ORDER BY createdAt DESC LIMIT 1`, [target || name, target || name]);
          const hit = ex[0];
          if (hit && (isPin || target)) {
            // Only a document that already holds every harvested fact counts; a shared opening is not enough.
            const doc = await docOf(String(hit.id));
            if (doc && !lacking(doc.chunks, content).length) { keep(String(hit.id), "exists: already holds it"); continue; }
            const noEdit = editRefusal(hit);
            if (!noEdit) {
              try {
                const er: any = await ctx.swarm.memory_edit({ memoryId: String(hit.id), mode: "replace", content: `${String(hit.content).trimEnd()}\n\n${content.trim()}`, intent: `dreaming lane C ${runId}: drained heartbeat pin` });
                const why = refusal(er);
                if (why) throw new Error(why);
                keep(String(hit.id), "updated");
                continue;
              } catch (e: any) {
                errors.push(`memory_edit ${name}: ${String(e?.message ?? e).slice(0, 160)}`);
              }
            }
            // A row that may not be edited (or an edit that was refused): keep the text in a sibling that points back.
            const taken = (await q(`SELECT 1 FROM agent_memory WHERE name = ? LIMIT 1`, [name])).length > 0;
            const sibling = taken ? `${name.slice(0, 80)}-${date.slice(5)}` : name;
            const sid = await storeMemory(sibling, `Addendum to memory "${String(hit.name).slice(0, 120)}" (${hit.id}).\n\n${content}`, pinTags);
            keep(sid, "stored-sibling", { target: String(hit.id), sibling, ...(noEdit ? { editRefused: noEdit } : {}) });
            continue;
          }
          if (hit) { memories.push({ name, status: "exists" }); continue; }
          keep(await storeMemory(name, content, isPin ? pinTags : ["dreaming-v2", runId, "heartbeat"]), "stored");
        } catch (e: any) {
          errors.push(`memory_store ${name}: ${String(e?.message ?? e).slice(0, 160)}`);
          memories.push({ name, status: "failed" });
          if (isPin) for (const k of [name, target]) if (k) failed.add(k);
        }
      }
      // Re-read every drained pin's memory before the prune: it must exist, hold every fact this run harvested (or, when the
      // pin only points at it, re-read whole), and not expire. A reused document that expires (task_completion,
      // session_summary) gets a durable manual copy of all its chunks, or its facts vanish with the line.
      const missingPin: string[] = [];
      const durable = new Map<string, string>();
      for (const k of pinNames) {
        const h = held.get(k);
        const id = h?.id ?? String((await q(`SELECT id FROM agent_memory WHERE id = ? OR (name = ? AND chunkIndex = 0) ORDER BY createdAt DESC LIMIT 1`, [k, k]))[0]?.id ?? "");
        const doc = id && (h || !failed.has(k)) ? await docOf(id) : null;
        if (!doc || (h ? lacking(doc.chunks, h.text).length > 0 : !doc.complete)) { missingPin.push(k); continue; }
        if (!doc.expiring || durable.has(doc.id)) continue;
        try {
          const cid = await storeMemory(`${k.slice(0, 80)}-durable`, `Durable copy of memory ${doc.id}, which expires; kept because a drained heartbeat pin points at it.\n\n${doc.text}`, pinTags);
          const copy = await docOf(cid);
          if (!copy || copy.expiring || !copy.complete || lacking(copy.chunks, `${doc.text}\n${h?.text ?? ""}`).length) throw new Error(`durable copy ${cid} did not re-read`);
          durable.set(doc.id, cid);
          memories.push({ name: k, id: cid, status: "stored-durable-copy", from: doc.id });
        } catch (e: any) {
          errors.push(`durable copy ${k}: ${String(e?.message ?? e).slice(0, 160)}`);
          missingPin.push(k);
        }
      }
      if (missingPin.length) {
        await ctx.swarm.task_send({
          agentId: LEAD,
          routingReason: "human_pinned",
          routingNote: "dreaming lane C: restore HEARTBEAT.md after a pin memory failed to store",
          task: `dreaming lane C (run ${runId}): ${missingPin.length} drained pin memory(ies) did not store (${missingPin.slice(0, 3).join(", ")}), so the prune was not applied. Restore your disk copy with ONE bash call and no Write/Edit tool: \`cp ${diskBackup} /workspace/HEARTBEAT.md && sha256sum /workspace/HEARTBEAT.md\`. Expected sha ${plan.planSha}. Reply with the sha.`,
        });
        return { ...base, ok: false, status: "refused: pin-memory-missing", missingPin, memories, restoreTask: "sent to Lead", errors };
      }
      const live = await liveHb();
      const dbSha = await sha(live);
      let status = "";
      if (dbSha === plan.planSha) {
        await kvSet(`hb-preimage:${runId}`, { text: live, sha256: dbSha, backupPath, diskBackup, at: now.toISOString() });
        try {
          await ctx.swarm.profile_update({ agentId: LEAD, heartbeatMd: next } as any);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          // The disk already holds the draft; put it back so disk and DB both hold the old text.
          await ctx.swarm.task_send({
            agentId: LEAD,
            routingReason: "human_pinned",
            routingNote: "dreaming lane C: restore HEARTBEAT.md after a rejected DB write",
            task: `dreaming lane C (run ${runId}): the DB rejected the heartbeat prune (${msg.slice(0, 200)}). Restore your disk copy with ONE bash call and no Write/Edit tool: \`cp ${diskBackup} /workspace/HEARTBEAT.md && sha256sum /workspace/HEARTBEAT.md\`. Expected sha ${dbSha}. Reply with the sha.`,
          });
          return { ...base, ok: false, status: "rejected", detail: msg.slice(0, 300), restoreTask: "sent to Lead", errors };
        }
        const reSha = await sha(await liveHb());
        status = reSha === draftSha ? "applied" : "";
        if (!status) return { ...base, ok: false, status: "refused: re-read mismatch", detail: `re-read ${reSha.slice(0, 12)} != draft ${draftSha.slice(0, 12)}`, errors };
      } else if (dbSha === draftSha) {
        status = "applied-via-self-edit";
      } else {
        const back = removed.map((r: any) => String(r?.probe ?? r?.title ?? "")).filter((pr) => pr && live.includes(pr));
        if (!back.length && trackedLines(next).every((l) => live.includes(l))) status = "applied-via-self-edit";
        else {
          await ctx.swarm.task_send({
            agentId: LEAD,
            routingReason: "human_pinned",
            routingNote: "dreaming lane C: restore HEARTBEAT.md after db-drift",
            task: `dreaming lane C (run ${runId}): your heartbeatMd changed in the DB while the prune ran, so the prune was not applied. Restore your disk copy with ONE bash call and no Write/Edit tool: \`cp ${diskBackup} /workspace/HEARTBEAT.md && sha256sum /workspace/HEARTBEAT.md\`. Reply with the sha.`,
          });
          return { ...base, ok: false, status: "refused: db-drift", detail: `db ${dbSha.slice(0, 12)} is neither plan nor draft; ${back.length} removed probe(s) present`, restoreTask: "sent to Lead", errors };
        }
      }
      const removedProbes = removed.map((r: any) => String(r?.probe ?? r?.title ?? "").slice(0, 80)).filter(Boolean);
      const keptPins = (Array.isArray(draft.keptPins) ? draft.keptPins : []).map((k: any) => String(k).slice(0, 80)).filter(Boolean).slice(0, 40);
      const state = { runId, at: now.toISOString(), beforeSha: plan.planSha, afterSha: draftSha, afterChars: next.length, afterText: next, backupPath, diskBackup, removedProbes, keptPins, status };
      await kvSet("hb-state:lead", state);
      await kvSet(`hb-state:${runId}`, { ...state, afterText: undefined });
      await kvSet(`cuts:${runId}:C`, {
        runId,
        lane: "C",
        at: now.toISOString(),
        cuts: removed.map((r: any, i: number) => ({
          cutId: `${runId.slice(0, 8)}:C:${i}`,
          lane: "C",
          target: { kind: "heartbeat", agentId: LEAD, field: "heartbeatMd" },
          probe: String(r?.probe ?? r?.title ?? "").slice(0, 80),
          kind: String(r?.reason ?? "removed").slice(0, 60),
          movedTo: r?.movedTo ?? "none",
          backupRef: backupPath,
        })),
      });
      const adds: any[] = Array.isArray(draft.runbookAdds) ? draft.runbookAdds : [];
      if (adds.length) await kvSet("hb-runbook-adds:latest", { runId, at: now.toISOString(), skill: plan.runbookSkill ?? PROCEDURES_SKILL, adds });
      return { ...base, status, stateKey: "hb-state:lead", cutsKey: `cuts:${runId}:C`, beforeSha: plan.planSha, afterSha: draftSha, memories, runbookAdds: adds.length, errors };
    }

    // ---------------- restore-db ----------------
    if (a.mode === "restore-db") {
      const pre = await kvGet(`hb-preimage:${runId}`);
      if (typeof pre?.text !== "string") return { ok: false, errors: [`no hb-preimage:${runId}`] };
      if (a.confirmDiskSha !== pre.sha256) return { ok: false, errors: ["confirmDiskSha must equal the pre-image sha (restore the disk copy first)"], preimageSha: pre.sha256 };
      if (dry) return { ok: true, mode: "dry-run", wouldRestoreChars: pre.text.length };
      await ctx.swarm.profile_update({ agentId: LEAD, heartbeatMd: pre.text } as any);
      const ok = (await sha(await liveHb())) === pre.sha256;
      if (ok) await kvSet("hb-state:lead", { runId, revertedAt: now.toISOString(), afterSha: null });
      return { ok, mode: "live", restoredChars: pre.text.length };
    }

    // ---------------- revert ----------------
    if (a.mode === "revert") {
      const pre = await kvGet(`hb-preimage:${runId}`);
      if (!pre?.sha256) return { ok: false, errors: [`no hb-preimage:${runId}`] };
      return {
        ok: true,
        brief: [
          `Lead, one bash call, no Write/Edit tool: cp ${pre.diskBackup} /workspace/HEARTBEAT.md && sha256sum /workspace/HEARTBEAT.md (expect ${pre.sha256}).`,
          `Then: script-run name="dreaming-heartbeat" scope="global" args={"mode":"restore-db","runId":"${runId}","confirmDiskSha":"${pre.sha256}"}`,
        ],
      };
    }

    // ---------------- verify ----------------
    const st = await kvGet("hb-state:lead");
    const live = await liveHb();
    const s = await sha(live);
    if (!st?.afterSha) return { ok: true, mode: "verify", status: "none", chars: live.length };
    const back = (Array.isArray(st.removedProbes) ? st.removedProbes : []).filter((pr: string) => pr && live.includes(pr));
    return {
      ok: true,
      mode: "verify",
      runId: st.runId,
      status: s === st.afterSha ? "intact" : s === st.beforeSha ? "reverted" : back.length ? "reintroduced" : "drifted",
      chars: live.length,
      underTarget: live.length <= TARGETS.firstRunChars,
      reintroduced: back.slice(0, 30),
    };
  } catch (e: any) {
    return { ok: false, mode: a.mode, errors: [...errors, String(e?.message ?? e).slice(0, 300)] };
  }
}

// fromRun / loadResult, for the seeded `dreaming` workflow. These writes need Lead authority, which a seeded
// workflow's script node does not have, so a Lead agent-task runs `{ mode, runId, fromRun: true }` from its own
// session. Every arg the caller did not pass loads from the run's recorded step outputs (a step that never ran
// reads as "", as interpolation renders it), the result is stored in KV, and the task returns a small pointer. The
// next node runs `{ mode, runId, loadResult: true }` and returns the stored result, so downstream mappings keep
// reading `<node>.result`. Without either flag the script runs exactly as before.
const RUN_NODE = "hb-apply";
const RUN_MODE: string | null = "apply";
// [arg, step nodeId, JSON path in the step output, required]. A missing required step stops before any write.
const RUN_PATHS: Array<[string, string, string, boolean]> = [
  ["dryRun", "gather", "$.result.dryRun", true],
  ["writes", "gather", "$.result.v3Writes", true],
  ["leadAgentId", "gather", "$.result.leadAgentId", true],
  ["plan", "hb-plan", "$.result", true],
  ["check", "hb-check", "$.result", false],
  ["draft", "hb-draft", "$.taskOutput", false],
  ["disk", "lead-disk", "$.taskOutput", false],
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

/** Dreaming lane C: the lead's HEARTBEAT triage and prune (plan, stage, check, apply, revert, selftest); fromRun / loadResult for apply. */
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
