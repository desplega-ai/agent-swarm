import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// dreaming-v2 node 1: deterministic last-N-day gather. Spec: agent-fs dreaming-v2/design.md section 2, node 1.
// Never throws: a thrown swarm-script error fails the whole run even under onNodeFailure:"continue".

// Nightly budget the changelog compares cost against (the $25 set at build time).
const BUDGET_USD = 25;
const CAPS = {
  identityOpsTotal: 6,
  identityOpsPerAgent: 1,
  memoryStore: 5,
  memoryEdit: 5,
  memoryDelete: 10,
  skillCreate: 1,
  skillUpdate: 3,
  scriptSpecs: 2,
  scriptBuilds: 2,
};

export const argsSchema = z.object({
  runId: z.string().optional(),
  days: z.number().int().positive().default(1),
  dryRun: z.union([z.boolean(), z.string()]).optional(),
  onlyAgentIds: z.union([z.array(z.string()), z.string()]).optional(),
  minTasks: z.number().int().min(0).default(1),
  digestDate: z.string().optional(), // control runs only; defaults to today (UTC)
  // Override for the daily-blocker-digest schedule id. Unset: resolved by schedule name; none found = digest task state skipped.
  digestScheduleId: z.string().optional(),
  // v3: the one write flag Lead flips (workflow input v3Writes = "on"). Anything else = off. Never on in a dryRun.
  v3Writes: z.unknown().optional(),
  // Assignees (workflow inputs). Empty lead = the swarm's lead (agents.isLead = 1); empty coder or writer = "", which
  // leaves those agent-tasks in the unassigned pool for any worker to claim.
  leadAgentId: z.string().optional(),
  coderAgentId: z.string().optional(),
  writerAgentId: z.string().optional(),
});

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

// Same rule as dream-manual-gather getH2Anchors: H2 lines outside fenced code.
function maskFenced(text: string): string {
  const lines = text.split(/(?<=\n)/);
  const masked = [...lines];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.replace(/\r?\n$/, "").match(/^ {0,3}(`{3,}|~{3,})/);
    if (!m) continue;
    const ch = m[1]![0]!;
    const len = m[1]!.length;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.replace(/\r?\n$/, "").trim();
      if (t.length >= len && [...t].every((c) => c === ch)) {
        close = j;
        break;
      }
    }
    if (close === -1) continue;
    for (let k = i; k <= close; k++) masked[k] = lines[k]!.replace(/[^\r\n]/g, " ");
    i = close;
  }
  return masked.join("");
}
const h2 = (t: string) =>
  maskFenced(t ?? "")
    .split(/\r?\n/)
    .filter((l) => /^## (?!#)/.test(l));

function joinChunks(parts: string[]): string {
  // Two chunkers exist: markdown-section chunks start with a "# Title > ## Section" breadcrumb line;
  // sliding-window chunks overlap the previous chunk's tail.
  let out = parts[0] ?? "";
  for (const raw of parts.slice(1)) {
    const crumb = raw.match(/^# [^\n]*? > (#{2,6} [^\n]*)/);
    if (crumb) {
      out = `${out.replace(/\s+$/, "")}\n\n${crumb[1]}${raw.slice(crumb[0].length)}`;
      continue;
    }
    let k = 0;
    for (let n = Math.min(out.length, raw.length); n >= 20; n--) {
      if (out.endsWith(raw.slice(0, n))) {
        k = n;
        break;
      }
    }
    out += k ? raw.slice(k) : `\n${raw}`;
  }
  return out;
}
// Bullet lines under any heading that mentions blockers (the digest's verified-blocker list).
function digestBlockers(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const l of text.split(/\r?\n/)) {
    if (/^#{2,4} /.test(l)) inBlock = /blocker|verified/i.test(l) && !/resolved/i.test(l);
    else if (inBlock && /^\s*[-*] /.test(l)) out.push(l.trim().slice(0, 300));
  }
  return out;
}

function parseOnly(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.length > 0);
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.filter((x) => typeof x === "string");
    } catch {}
  }
  return [];
}

/** Dreaming step 1: read-only gather of the last day of work, profiles, skills and memory; resolves lead, coder and writer ids. */
export default async function (args: unknown, ctx: ScriptContext) {
  const errors: string[] = [];
  const p = argsSchema.safeParse(args ?? {});
  if (!p.success) return { ok: false, errors: [p.error.message], agents: [], skippedAgents: [], swarm: {} };
  const a = p.data;
  const dryRun = a.dryRun === true || a.dryRun === "true";
  const only = parseOnly(a.onlyAgentIds);
  const win = `-${a.days} days`;
  const generatedAt = new Date().toISOString();
  const windowStart = new Date(Date.now() - a.days * 86400000).toISOString();

  const q = async (label: string, sql: string, params: unknown[] = []): Promise<any[] | null> => {
    try {
      return rows(await ctx.swarm.db_query({ sql, params }));
    } catch (e: any) {
      errors.push(`${label}: ${String(e?.message ?? e).slice(0, 200)}`);
      return null;
    }
  };

  // Self-exclusion: every run of THIS workflow, by durable workflowId (survives renames).
  const SELF = `(SELECT r.id FROM workflow_runs r WHERE r.workflowId = (SELECT workflowId FROM workflow_runs WHERE id = ?))`;
  const selfP = [a.runId ?? ""];

  const roster =
    (await q(
      "roster",
      `SELECT id, name, isLead, soulMd, identityMd, claudeMd, toolsMd, heartbeatMd
       FROM agents WHERE status IN ('idle','busy') AND name NOT LIKE 'ext:%' ORDER BY isLead DESC, name`,
    )) ?? [];
  const stats =
    (await q(
      "taskStats",
      `SELECT agentId, COUNT(*) total, SUM(status='completed') completed, SUM(status='failed') failed,
         SUM(status='cancelled') cancelled, SUM(scheduleId IS NOT NULL) fromSchedules
       FROM agent_tasks WHERE julianday(createdAt) > julianday('now', ?)
         AND (workflowRunId IS NULL OR workflowRunId NOT IN ${SELF}) GROUP BY agentId`,
      [win, ...selfP],
    )) ?? [];
  const cost =
    (await q(
      "cost",
      `SELECT agentId, ROUND(SUM(totalCostUsd), 2) usd FROM session_costs
       WHERE julianday(createdAt) > julianday('now', ?) GROUP BY agentId`,
      [win],
    )) ?? [];
  const recent =
    (await q(
      "recent",
      `SELECT * FROM (SELECT t.agentId, t.id, t.status, COALESCE(t.title, substr(t.task,1,160)) title,
         s.name scheduleName, t.failureReason,
         ROW_NUMBER() OVER (PARTITION BY t.agentId ORDER BY (t.scheduleId IS NULL) DESC, t.createdAt DESC) rn
       FROM agent_tasks t LEFT JOIN scheduled_tasks s ON s.id = t.scheduleId
       WHERE julianday(t.createdAt) > julianday('now', ?)
         AND (t.workflowRunId IS NULL OR t.workflowRunId NOT IN ${SELF})) WHERE rn <= 12`,
      [win, ...selfP],
    )) ?? [];
  const invokes = await q(
    "skillInvokes",
    `SELECT agentId, json_extract(data,'$.skillName') name, COUNT(*) n FROM events
     WHERE event = 'skill.invoke' AND createdAt > strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
     GROUP BY agentId, name`,
    [win],
  );
  const installed =
    (await q(
      "installedSkills",
      `SELECT agentId, COUNT(*) n FROM agent_skills WHERE isActive = 1 GROUP BY agentId`,
    )) ?? [];
  const mems =
    (await q(
      "memoriesWritten",
      `SELECT * FROM (SELECT agentId, id, name, scope,
         ROW_NUMBER() OVER (PARTITION BY agentId ORDER BY createdAt DESC) rn
       FROM agent_memory WHERE source = 'manual' AND julianday(createdAt) > julianday('now', ?)
         AND COALESCE(chunkIndex, 0) = 0
         AND (tags IS NULL OR tags NOT GLOB '*"dreaming-v2"*')) WHERE rn <= 10`,
      [win],
    )) ?? [];

  const agents: any[] = [];
  const skippedAgents: any[] = [];
  for (const r of roster) {
    if (only.length && !only.includes(r.id)) {
      skippedAgents.push({ id: r.id, name: r.name, reason: "not-in-onlyAgentIds" });
      continue;
    }
    const s = stats.find((x: any) => x.agentId === r.id);
    if (!s || Number(s.total) < a.minTasks) {
      skippedAgents.push({ id: r.id, name: r.name, reason: "no-activity" });
      continue;
    }
    const files: Record<string, string> = {
      SOUL: r.soulMd ?? "",
      IDENTITY: r.identityMd ?? "",
      CLAUDE: r.claudeMd ?? "",
      TOOLS: r.toolsMd ?? "",
      HEARTBEAT: r.isLead ? (r.heartbeatMd ?? "") : "",
    };
    const profileSha256: Record<string, string> = {};
    const h2Anchors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(files)) {
      profileSha256[k] = await sha(v);
      h2Anchors[k] = h2(v);
    }
    agents.push({
      id: r.id,
      name: r.name,
      isLead: !!r.isLead,
      evidence: {
        tasks: {
          total: Number(s.total),
          completed: Number(s.completed ?? 0),
          failed: Number(s.failed ?? 0),
          cancelled: Number(s.cancelled ?? 0),
          fromSchedules: Number(s.fromSchedules ?? 0),
          costUsd: Number(cost.find((c: any) => c.agentId === r.id)?.usd ?? 0),
        },
        recent: recent
          .filter((x: any) => x.agentId === r.id)
          .map((x: any) => ({
            id: x.id,
            status: x.status,
            title: String(x.title ?? "").slice(0, 160),
            scheduleName: x.scheduleName ?? null,
            failureReason: x.failureReason ? String(x.failureReason).slice(0, 200) : null,
          })),
        skillInvokes: invokes
          ? invokes.filter((x: any) => x.agentId === r.id).map((x: any) => ({ name: x.name, n: Number(x.n) }))
          : null,
        installedSkillCount: Number(installed.find((x: any) => x.agentId === r.id)?.n ?? 0),
        memoriesWritten: mems
          .filter((x: any) => x.agentId === r.id)
          .map((x: any) => ({ id: x.id, name: x.name, scope: x.scope })),
        profileSizes: {
          soul: files.SOUL!.length,
          identity: files.IDENTITY!.length,
          claude: files.CLAUDE!.length,
          tools: files.TOOLS!.length,
          heartbeat: files.HEARTBEAT!.length,
        },
        profileSha256,
        h2Anchors,
      },
    });
  }

  // Blocker digest: today's memory by exact name (never memory-search), all chunks, de-overlapped.
  const today = a.digestDate ?? generatedAt.slice(0, 10);
  const digestName = `daily-blocker-digest-${today}`;
  let blockerDigest: any = { state: "missing", name: digestName, createdAt: null, chunks: 0, blockers: [], text: null, taskState: null };
  const dm = await q(
    "blockerDigestMemory",
    `SELECT id, content, chunkIndex, createdAt FROM agent_memory WHERE name = ? ORDER BY createdAt DESC, chunkIndex ASC LIMIT 40`,
    [digestName],
  );
  // The digest is the seeded daily-blocker-digest schedule; resolve it by name unless an id override is passed.
  const DIGEST = (a.digestScheduleId ?? "").trim() ||
    String((await q("digestSchedule", `SELECT id FROM scheduled_tasks WHERE name = ? ORDER BY createdAt ASC LIMIT 1`, ["daily-blocker-digest"]))?.[0]?.id ?? "");
  const dt = !DIGEST ? [] : await q(
    "blockerDigestTask",
    `SELECT id, status, finishedAt FROM agent_tasks WHERE scheduleId = ? AND julianday(createdAt) > julianday('now', '-1 days')
     ORDER BY createdAt DESC LIMIT 1`,
    [DIGEST],
  );
  const taskState = dt?.[0] ? { taskId: dt[0].id, status: dt[0].status, finishedAt: dt[0].finishedAt ?? null } : null;
  if (dm?.length) {
    // Keep only the newest document if the name was stored twice.
    const newest = String(dm[0].createdAt).slice(0, 16);
    const doc = dm.filter((r: any) => String(r.createdAt).slice(0, 16) === newest).sort((x: any, y: any) => Number(x.chunkIndex) - Number(y.chunkIndex));
    const text = joinChunks(doc.map((r: any) => String(r.content ?? "")));
    blockerDigest = {
      state: "present",
      name: digestName,
      createdAt: doc[0].createdAt,
      chunks: doc.length,
      blockers: digestBlockers(text).slice(0, 40),
      text: text.slice(0, 8000),
      taskState,
    };
  } else {
    blockerDigest.state = taskState && (taskState.status === "in_progress" || taskState.status === "pending") ? "late" : "missing";
    blockerDigest.taskState = taskState;
  }

  // Night number + workflow changes since the previous scheduled run (KV snapshot, else workflow_versions).
  let night: any = { number: null, previousRunId: null };
  let workflowChanges: any = { base: "none", baseRef: null, added: [], removed: [], changed: [] };
  let workflowSnapshot: Record<string, string> = {};
  try {
    const me = await q("selfRun", `SELECT workflowId, startedAt, triggerType FROM workflow_runs WHERE id = ?`, [a.runId ?? ""]);
    const wfId = me?.[0]?.workflowId ?? null;
    if (wfId) {
      const prev = await q(
        "prevRuns",
        `SELECT id, startedAt FROM workflow_runs WHERE workflowId = ? AND triggerType = 'schedule' AND id != ?
           AND julianday(startedAt) < julianday(?) ORDER BY startedAt DESC`,
        [wfId, a.runId ?? "", me?.[0]?.startedAt],
      );
      night = { number: (prev?.length ?? 0) + 1, previousRunId: prev?.[0]?.id ?? null, previousStartedAt: prev?.[0]?.startedAt ?? null };
      const cur = await q("workflowDef", `SELECT definition FROM workflows WHERE id = ?`, [wfId]);
      const nodesOf = (d: any): any[] => (Array.isArray(d?.definition?.nodes) ? d.definition.nodes : Array.isArray(d?.nodes) ? d.nodes : []);
      const hashNodes = async (nodes: any[]) => {
        const m: Record<string, string> = {};
        for (const n of nodes) m[String(n.id)] = (await sha(JSON.stringify(n))).slice(0, 16);
        return m;
      };
      workflowSnapshot = await hashNodes(nodesOf({ definition: JSON.parse(cur?.[0]?.definition ?? "{}") }));
      let base: Record<string, string> | null = null;
      const snap: any = await ctx.swarm.kv_getOrNull({ namespace: "dreaming-v2", key: "wf-snapshot" }).catch(() => null);
      if (snap?.value?.nodes) {
        base = snap.value.nodes;
        workflowChanges.base = "kv";
        workflowChanges.baseRef = snap.value.runId ?? null;
      } else if (night.previousStartedAt) {
        const v = await q(
          "workflowVersionAtPrevRun",
          `SELECT version, snapshot FROM workflow_versions WHERE workflowId = ? AND julianday(createdAt) > julianday(?) ORDER BY version ASC LIMIT 1`,
          [wfId, night.previousStartedAt],
        );
        workflowChanges.base = "workflow_versions";
        if (v?.length) {
          base = await hashNodes(nodesOf(JSON.parse(v[0].snapshot ?? "{}")));
          workflowChanges.baseRef = `version ${v[0].version}`;
        } else {
          base = workflowSnapshot;
          workflowChanges.baseRef = "no version since previous run";
        }
      }
      if (base) {
        workflowChanges.added = Object.keys(workflowSnapshot).filter((k) => !(k in base!));
        workflowChanges.removed = Object.keys(base).filter((k) => !(k in workflowSnapshot));
        workflowChanges.changed = Object.keys(workflowSnapshot).filter((k) => k in base! && base![k] !== workflowSnapshot[k]);
      }
    }
  } catch (e: any) {
    errors.push(`workflowChanges: ${String(e?.message ?? e).slice(0, 200)}`);
  }

  // Audits: latest completed script_runs.output per script. Never nest ctx.swarm.script_run.
  const audit = async (name: string, pick: (o: any) => any) => {
    const c = await q(
      `${name}-latest`,
      `SELECT output, ROUND((julianday('now') - julianday(startedAt)) * 1440) ageMinutes
       FROM script_runs WHERE scriptName = ? AND status = 'completed' ORDER BY startedAt DESC LIMIT 1`,
      [name],
    );
    if (!c?.length) return { source: "missing" };
    const age = Number(c[0].ageMinutes);
    try {
      const o = JSON.parse(c[0].output);
      const r = o?.result ?? o;
      return { source: age > 180 ? "stale" : "cached", ageMinutes: age, ...pick(r) };
    } catch {
      return { source: "unparsable", ageMinutes: age };
    }
  };
  const audits = {
    failureTaxonomy: await audit("failure-taxonomy", (r) => ({
      warning: r?.warning ?? null,
      windowTotals: r?.windowTotals ?? null,
      totals: r?.totals ?? null,
      perAgent: r?.perAgent ?? null,
      controlsOk: r?.controls?.ok ?? null,
    })),
    latency: await audit("script-latency-headroom", (r) => ({
      persistent: (r?.regressedAfterChange ?? []).filter((x: any) => x?.persistence === "persistent"),
      regressionComparableOk: r?.controls?.regressionComparableOk ?? null,
    })),
    storms: await audit("script-storm-scan", (r) => ({
      stormCount: r?.stormCount ?? null,
      storms: (r?.storms ?? []).slice(0, 10),
      controlsOk: r?.controls?.ok ?? null,
    })),
    stalledApprovals: await audit("stalled-approvals-scan", (r) => ({
      counts: r?.counts ?? null,
      stalled: (r?.stalled ?? []).slice(0, 10),
      controlsOk: r?.controls?.ok ?? null,
    })),
    silentGates: await audit("workflow-silent-gate-scan", (r) => ({
      silent: (r?.silent ?? []).slice(0, 10),
      controlsOk: r?.controls?.ok ?? null,
    })),
    contextBudget: await audit("context-budget-gate", (r) => ({
      pass: r?.pass ?? null,
      overBudget: r?.overBudget ?? [],
      drifting: r?.drifting ?? [],
    })),
  };

  // Skills: catalog counts, 7d usage, 14d never-invoked (enabled only).
  const sk = await q("skillCounts", `SELECT COUNT(*) total, SUM(isEnabled) enabled, SUM(systemDefault) systemDefault FROM skills`);
  const inv7 = await q(
    "skillInvoked7d",
    `SELECT json_extract(data,'$.skillName') name, COUNT(*) n FROM events
     WHERE event = 'skill.invoke' AND createdAt > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
     GROUP BY name ORDER BY n DESC LIMIT 60`,
  );
  const never14 = await q(
    "skillNeverInvoked14d",
    `SELECT id, name, scope, systemDefault FROM skills WHERE isEnabled = 1 AND name NOT IN (
       SELECT DISTINCT json_extract(data,'$.skillName') FROM events
       WHERE event = 'skill.invoke' AND createdAt > strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')
         AND json_extract(data,'$.skillName') IS NOT NULL)
     ORDER BY name LIMIT 40`,
  );
  const skills = {
    total: Number(sk?.[0]?.total ?? 0),
    enabled: Number(sk?.[0]?.enabled ?? 0),
    systemDefault: Number(sk?.[0]?.systemDefault ?? 0),
    invoked7d: (inv7 ?? []).map((x: any) => ({ name: x.name, n: Number(x.n) })),
    neverInvoked14d: (never14 ?? []).map((x: any) => ({
      id: x.id,
      name: x.name,
      scope: x.scope,
      systemDefault: !!x.systemDefault,
    })),
  };

  // Memory candidates: manual rows only.
  const dups = await q(
    "memExactDuplicates",
    `SELECT contentHash, group_concat(id, '|') ids, group_concat(name, '|') names FROM (
       SELECT contentHash, id, name FROM agent_memory
       WHERE source = 'manual' AND contentHash IS NOT NULL ORDER BY createdAt ASC)
     GROUP BY contentHash
     HAVING COUNT(*) > 1 AND contentHash IN (
       SELECT contentHash FROM agent_memory WHERE source = 'manual' AND contentHash IS NOT NULL
       GROUP BY contentHash HAVING MAX(COALESCE(totalChunks, 1)) = 1)
     LIMIT 20`,
  );
  const unhelpful = await q(
    "memUnhelpful",
    `SELECT id, name, scope, alpha, beta, accessCount FROM agent_memory
     WHERE source = 'manual' AND beta > alpha + 3 AND accessCount >= 5
     ORDER BY (beta - alpha) DESC LIMIT 20`,
  );
  const badKeys = await q(
    "memBadKeys",
    `SELECT id, name FROM agent_memory WHERE source = 'manual'
       AND julianday(createdAt) > julianday('now', ?)
       AND instr(name, char(10)) > 0 LIMIT 20`,
    // v6 (2026-10-12): dropped `length(name) > 90`. A name is a title (server max 200) and the only rename
    // path is store-new + delete-old, which loses the id, rating, access count and /longterm key; 617 manual
    // memories had long titles. A newline in a name is the real defect.
    [win],
  );
  const created = await q(
    "memCreatedInWindow",
    `SELECT source, COUNT(*) n FROM agent_memory WHERE julianday(createdAt) > julianday('now', ?) GROUP BY source`,
    [win],
  );
  const cnt = (s: string) => Number((created ?? []).find((x: any) => x.source === s)?.n ?? 0);
  const memory = {
    exactDuplicates: (dups ?? []).map((x: any) => ({
      contentHash: x.contentHash,
      ids: String(x.ids ?? "").split("|"),
      names: String(x.names ?? "").split("|"),
    })),
    unhelpful: unhelpful ?? [],
    badKeys: badKeys ?? [],
    createdInWindow: {
      manual: cnt("manual"),
      taskCompletion: cnt("task_completion"),
      sessionSummary: cnt("session_summary"),
      fileIndex: cnt("file_index"),
    },
  };

  // v3 (plan-v3 §6-7): the previous run's full cost (publish + scriptify included) and the learning feedback.
  const budget: any = { cap: BUDGET_USD, softCap: 22, prevRunId: night.previousRunId ?? null, prevRunUsd: null, overBudget: false };
  if (night.previousRunId) {
    const c = await q(
      "prevRunCost",
      `SELECT ROUND(SUM(c.totalCostUsd), 2) usd, COUNT(DISTINCT t.id) tasks FROM session_costs c JOIN agent_tasks t ON t.id = c.taskId WHERE t.workflowRunId = ?`,
      [night.previousRunId],
    );
    budget.prevRunUsd = c?.[0]?.usd === null || c?.[0]?.usd === undefined ? null : Number(c[0].usd);
    budget.prevRunTasks = Number(c?.[0]?.tasks ?? 0);
    budget.overBudget = budget.prevRunUsd !== null && budget.prevRunUsd > budget.softCap;
  }
  const learning: any = { recent: [], candidates: [], pins: [] };
  try {
    const list = async (prefix: string, limit: number) => {
      const r: any = await ctx.swarm.kv_list({ namespace: "dreaming-v2", prefix, limit });
      return (r?.data?.entries ?? r?.entries ?? []).map((e: any) => {
        let v = e.value;
        if (typeof v === "string") try { v = JSON.parse(v); } catch {}
        return { key: e.key, value: v };
      });
    };
    const rowsL = (await list("learn:", 60)).filter((e: any) => e.key !== "learn:latest" && e.value?.at).sort((x: any, y: any) => String(y.value.at).localeCompare(String(x.value.at)));
    learning.recent = rowsL.slice(0, 7).map((e: any) => ({ runId: e.value.runId, at: e.value.at, learning: e.value.metrics?.learning ?? null, trend: e.value.trend ?? null }));
    learning.candidates = (rowsL[0]?.value?.candidates ?? []).slice(0, 10);
    learning.pins = (await list("pin:", 200)).map((e: any) => ({ key: e.key, probe: e.value?.probe ?? null, lane: String(e.key).split(":")[1] ?? null })).slice(0, 100);
  } catch (e: any) {
    errors.push(`learning: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  const v3Writes = !dryRun && (a.v3Writes === "on" || a.v3Writes === true);
  const pickId = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  let leadAgentId = pickId(a.leadAgentId);
  if (!leadAgentId) {
    const lead = await q("lead", `SELECT id FROM agents WHERE isLead = 1 ORDER BY createdAt ASC LIMIT 1`);
    leadAgentId = String(lead?.[0]?.id ?? "");
  }
  // No lead = nobody may run the Lead-authority steps, so the run goes quiet instead of pooling them.
  if (!leadAgentId) errors.push("lead: no leadAgentId input and no agent with isLead = 1");

  return {
    ok: roster.length > 0 && leadAgentId !== "",
    dryRun,
    v3Writes,
    budget,
    learning,
    runId: a.runId ?? null,
    leadAgentId,
    coderAgentId: pickId(a.coderAgentId),
    writerAgentId: pickId(a.writerAgentId),
    windowStart,
    generatedAt,
    errors,
    caps: CAPS,
    agents,
    skippedAgents,
    budgetUsd: BUDGET_USD,
    night,
    workflowChanges,
    workflowSnapshot,
    swarm: { blockerDigest, audits, skills, memory },
  };
}

