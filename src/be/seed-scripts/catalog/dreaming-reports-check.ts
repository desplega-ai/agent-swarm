import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming-v2 report guard. Spec: agent-fs dreaming-v2/design.md section 8 (reports-check).
// Pass 1 (no retryResults): validate each foreach report against its slot; list the slots to retry once.
// Pass 2 (retryResults set): merge the retry pass; a slot still invalid is rejected and reported missing.
// A report is valid only if its JSON parses, carries the required keys, and its agentId equals the slot. Never throws.

export const argsSchema = z.object({
  agents: z.unknown().optional(),
  results: z.unknown().optional(),
  retryResults: z.unknown().optional(),
});

const REQUIRED_ARRAYS = ["repeatedProcedures", "skillFriction", "scriptCandidates", "identityOps", "memoryOps"];

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
const list = (v: unknown): any[] => {
  const p = parse(v);
  return Array.isArray(p) ? p : Array.isArray(p?.results) ? p.results : [];
};

function check(r: any, slot: string): { ok: true; report: any; taskId: string | null } | { ok: false; reason: string; taskId: string | null; reportAgentId?: string } {
  const o = parse(r?.output) ?? {};
  const taskId = typeof o.taskId === "string" ? o.taskId : null;
  if (!r) return { ok: false, reason: "no result for slot", taskId };
  if (r.status !== "completed") return { ok: false, reason: `child ${r.status}: ${String(typeof r.output === "string" ? r.output : o.error ?? "").slice(0, 160)}`, taskId };
  const rep = parse(o.taskOutput);
  if (!rep || typeof rep !== "object") return { ok: false, reason: "taskOutput is not a JSON object (structured output failure)", taskId };
  if (typeof rep.agentId !== "string") return { ok: false, reason: "schema: agentId missing", taskId };
  if (rep.agentId !== slot) return { ok: false, reason: `agent mismatch: slot ${slot} got a report for ${rep.agentId}`, taskId, reportAgentId: rep.agentId };
  if (typeof rep.summary !== "string") return { ok: false, reason: "schema: summary missing", taskId };
  const bad = REQUIRED_ARRAYS.filter((k) => !Array.isArray(rep[k]));
  if (bad.length) return { ok: false, reason: `schema: not arrays: ${bad.join(", ")}`, taskId };
  return { ok: true, report: rep, taskId };
}

/** Dreaming: check agent self-reports against the roster, list retries, merge first and retry results. */
export default async function (args: unknown, _ctx: ScriptContext) {
  const a: any = args ?? {};
  const agents = list(a.agents);
  const first = list(a.results);
  const second = a.retryResults === undefined || a.retryResults === null || a.retryResults === "" ? null : list(a.retryResults);
  const reports: any[] = [];
  const retry: any[] = [];
  const rejected: any[] = [];
  const missing: string[] = [];
  const retried: any[] = [];

  for (const ag of agents) {
    const slot = String(ag?.id ?? "");
    if (!slot) continue;
    const c1 = check(first.find((x: any) => x?.itemKey === slot), slot);
    if (c1.ok) {
      reports.push({ itemKey: slot, status: "completed", output: { taskId: c1.taskId, taskOutput: c1.report } });
      continue;
    }
    rejected.push({ slot, name: ag.name, pass: 1, reason: c1.reason, taskId: c1.taskId, reportAgentId: (c1 as any).reportAgentId ?? null });
    if (second === null) {
      retry.push({ ...ag, firstFailure: c1.reason });
      continue;
    }
    const c2 = check(second.find((x: any) => x?.itemKey === slot), slot);
    if (c2.ok) {
      retried.push({ slot, name: ag.name, ok: true });
      reports.push({ itemKey: slot, status: "completed", output: { taskId: c2.taskId, taskOutput: c2.report }, retried: true });
      continue;
    }
    retried.push({ slot, name: ag.name, ok: false });
    rejected.push({ slot, name: ag.name, pass: 2, reason: c2.reason, taskId: c2.taskId, reportAgentId: (c2 as any).reportAgentId ?? null });
    missing.push(`${ag.name} (${slot}): ${c2.reason}`);
    reports.push({ itemKey: slot, status: "failed", output: `[FAILED: ${c2.reason}]` });
  }
  return { pass: second === null ? 1 : 2, validCount: reports.filter((r) => r.status === "completed").length, reports, retry, retried, rejected, missing };
}
