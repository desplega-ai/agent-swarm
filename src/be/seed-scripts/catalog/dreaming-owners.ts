import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming-v2 owners node: nothing stays parked. Every action no lane handled tonight becomes an item in
// ONE task per named owner. Spec: agent-fs dreaming-v2/design.md section 8 (owners). Never throws.

export const argsSchema = z.object({
  runId: z.string().optional(),
  leadAgentId: z.string().optional(),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  synth: z.unknown().optional(),
  apply: z.unknown().optional(),
  skills: z.unknown().optional(),
  scriptify: z.unknown().optional(),
  trim: z.unknown().optional(),
  // Coding agent that owns scriptify follow-ups (workflow input coderAgentId). Falls back to Lead.
  coderAgentId: z.string().optional(),
});

const NS = "dreaming-v2";
const MAX_ITEMS_PER_TASK = 12;

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
  if (!Array.isArray(d?.rows)) return [];
  const c: string[] = d?.columns ?? [];
  return d.rows.map((x: any[]) => Object.fromEntries(c.map((k, i) => [k, x[i]])));
};

// Lead agent id: the `leadAgentId` arg when set (workflow input), else the swarm's lead (agents.isLead = 1).
// A failed lookup records an error and yields "", so the node keeps its never-throws contract.
let LEAD = "";
async function resolveLead(ctx: ScriptContext, id: unknown, errors: string[]): Promise<string> {
  if (typeof id === "string" && id.trim()) return id.trim();
  try {
    const r = rows(await ctx.swarm.db_query({ sql: `SELECT id FROM agents WHERE isLead = 1 ORDER BY createdAt ASC LIMIT 1` }));
    return String(r[0]?.id ?? "");
  } catch (e: any) {
    errors.push(`lead lookup: ${String(e?.message ?? e).slice(0, 200)}`);
    return "";
  }
}

/** Dreaming owners: sends follow-up tasks for proposals that need an owner. */
export default async function (args: unknown, ctx: ScriptContext) {
  const a: any = args ?? {};
  const errors: string[] = [];
  LEAD = await resolveLead(ctx, (args as any)?.leadAgentId, errors);
  const CODER = typeof a.coderAgentId === "string" ? a.coderAgentId.trim() : "";
  const dry = a.dryRun === true || a.dryRun === "true";
  const runId = typeof a.runId === "string" ? a.runId : "";
  const synth = parse(a.synth);
  const apply = parse(a.apply) ?? {};
  const skills = parse(a.skills) ?? {};
  const scriptify = parse(a.scriptify) ?? {};
  const trim = parse(a.trim) ?? {};
  const actions: any[] = Array.isArray(synth?.actions) ? synth.actions : [];
  if (!actions.length) return { mode: dry ? "dry-run" : "live", sent: [], wouldSend: [], handled: [], errors: synth ? errors : [...errors, "no synthesis output"] };

  const ids = (arr: any): Set<string> => new Set((Array.isArray(arr) ? arr : []).map((x: any) => String(x?.actionId ?? x)));
  const appliedIds = new Set([...ids(apply.applied), ...ids(apply.wouldApply), ...ids(apply.alreadyApplied)]);
  const folded = new Set<string>(
    [...(trim.applied ?? []), ...(trim.wouldApply ?? [])].flatMap((x: any) => (Array.isArray(x?.foldedEdits) ? x.foldedEdits : [])),
  );
  const skillDone = new Set((skills.results ?? []).filter((r: any) => r?.status === "applied" || r?.status === "dry-run").map((r: any) => String(r.actionId)));
  const built = (scriptify.built ?? []).filter((b: any) => b?.status === "built" || b?.status === "dry-run");
  const builtIds = new Set(built.map((b: any) => String(b.actionId)));

  let agents: any[] = [];
  try {
    agents = rows(await ctx.swarm.db_query({ sql: `SELECT id, name FROM agents WHERE name NOT LIKE 'ext:%'` }));
  } catch (e: any) {
    // Without the roster, owners fall back to Lead / coder defaults.
    errors.push(`agent lookup: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  const resolve = (o: unknown): string | null => {
    const s = String(o ?? "").trim();
    if (!s) return null;
    const hit = agents.find((x: any) => x.id === s || x.id.startsWith(s) || String(x.name).toLowerCase() === s.toLowerCase());
    return hit ? hit.id : null;
  };
  const defaultOwner = (act: any): string => {
    if (act.lane === "identity") return resolve(act.target?.agentId) ?? LEAD;
    if (act.lane === "scriptify") return CODER || LEAD;
    return LEAD;
  };

  const handled: string[] = [];
  const items: any[] = [];
  for (const act of actions) {
    const id = String(act?.id ?? "");
    const done =
      appliedIds.has(id) || folded.has(id) || skillDone.has(id) || builtIds.has(id);
    if (done) {
      handled.push(id);
      continue;
    }
    const why = act.tier === "propose" ? "proposed, no lane may apply it" : "auto but not applied tonight";
    const refusal = [...(apply.refused ?? []), ...(apply.refusedSilently ?? [])].find((x: any) => x?.actionId === id);
    items.push({
      actionId: id,
      owner: resolve(act.owner) ?? defaultOwner(act),
      lane: act.lane,
      op: act.op,
      target: act.target ?? {},
      reason: String(act.reason ?? "").slice(0, 300),
      why: refusal ? `refused: ${refusal.reason ?? refusal.detail}` : why,
    });
  }
  // Built scripts are agent-scoped until promoted; promotion to global is Lead-only.
  for (const b of built) {
    if (b.status !== "built") continue;
    items.push({ actionId: String(b.actionId), owner: LEAD, lane: "scriptify", op: "promote-script", target: { name: b.name, scope: "agent", contentHash: b.contentHash }, reason: `built with controls (positive ${b.positiveRunId}, negative ${b.negativeRunId})`, why: "global promotion is Lead-only" });
  }

  const byOwner = new Map<string, any[]>();
  for (const it of items) byOwner.set(it.owner, [...(byOwner.get(it.owner) ?? []), it]);
  const sent: any[] = [];
  const wouldSend: any[] = [];
  for (const [owner, list] of byOwner) {
    const name = agents.find((x: any) => x.id === owner)?.name ?? owner;
    const shown = list.slice(0, MAX_ITEMS_PER_TASK);
    const lines = shown.map((it) => `- ${it.actionId} [${it.lane}/${it.op}] ${JSON.stringify(it.target).slice(0, 220)}\n  why owned: ${it.why}. ${it.reason}`);
    const task = [
      `dreaming-v2 run ${runId}: ${list.length} item(s) handed to you (${name}) because no lane could close them tonight. Decide each: do it, or reply why not.`,
      `Full context: workflow_run_steps runId=${runId} nodeId=synthesize (output.taskOutput.actions, by id).`,
      "",
      ...lines,
      list.length > shown.length ? `- ... and ${list.length - shown.length} more in the synthesize output.` : "",
      "",
      "Nothing here is owed to a human. Report per item: done (with the re-read proof), declined (with the reason), or re-routed (to whom).",
      "Any PR you open carries a `## Why this exists` section: what was found, how it was found, and why the swarm fixed it rather than filing it. The repo may be public: no Slack ids, task UUIDs, customer names or internal URLs.",
    ].filter((l) => l !== "").join("\n");
    const row = { owner, ownerName: name, actionIds: list.map((x) => x.actionId) };
    if (dry) {
      wouldSend.push({ ...row, preview: task.slice(0, 400) });
      continue;
    }
    if (!owner) {
      errors.push(`no owner for ${row.actionIds.length} item(s): lead unresolved`);
      continue;
    }
    const key = `owners:${runId}:${owner}`;
    try {
      const prev: any = await ctx.swarm.kv_getOrNull({ namespace: NS, key });
      if (prev?.value?.taskId) {
        sent.push({ ...row, taskId: prev.value.taskId, note: "already sent" });
        continue;
      }
      const res: any = await ctx.swarm.task_send({
        task,
        agentId: owner,
        routingReason: "skill",
        routingNote: "dreaming-v2 owners node: items no lane closed tonight",
        tags: ["dreaming-v2", "dreaming-v2-owner"],
      } as any);
      const taskId = res?.data?.task?.id ?? res?.task?.id ?? res?.data?.id ?? res?.id ?? null;
      await ctx.swarm.kv_set({ namespace: NS, key, value: { taskId, at: new Date().toISOString(), actionIds: row.actionIds } as any });
      sent.push({ ...row, taskId });
    } catch (e: any) {
      errors.push(`send to ${name}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return { mode: dry ? "dry-run" : "live", handled, items: items.length, sent, wouldSend, errors };
}
