// Seed scripts + prompt override for the scripts-only ("code-mode") experiment.
// Import { applySeeds } from matrix-run.ts, or run directly:
//   bun /tmp/matrix-seeds.ts apply     — upsert seeds + prompt override on live stack (:3113)
//   bun /tmp/matrix-seeds.ts validate  — apply, then execute each seed and print results

const LEAD = "7a1e0000-0000-4000-8000-000000000001";

export const SEED_SCRIPTS: Array<{ name: string; description: string; source: string }> = [
  {
    name: "delegate",
    description: "Delegate a task to a swarm agent BY NAME (resolves name->id). Args: {agentName, task, parentTaskId?, priority?, tags?}. Returns {ok, taskId}.",
    source: `export default async function (args: any, ctx: any) {
  const res: any = await ctx.swarm.swarm_get({ includeFull: true });
  const agents: any[] = res?.data?.agents ?? res?.agents ?? [];
  const agent = agents.find((a: any) => (a.name ?? "").toLowerCase() === String(args.agentName).toLowerCase());
  if (!agent) return { ok: false, error: "agent '" + args.agentName + "' not found", known: agents.map((a: any) => a.name) };
  const sent: any = await ctx.swarm.task_send({
    agentId: agent.id,
    task: args.task,
    ...(args.parentTaskId ? { parentTaskId: args.parentTaskId } : {}),
    ...(args.priority != null ? { priority: args.priority } : {}),
    ...(args.tags ? { tags: args.tags } : {}),
  });
  const id = sent?.data?.task?.id ?? sent?.data?.id ?? sent?.id ?? null;
  return { ok: true, taskId: id, agentId: agent.id, agentName: agent.name };
}`,
  },
  {
    name: "wait-for-task",
    description: "Wait (max ~25s) for a task to reach a terminal state. Args: {taskId, budgetSec?}. Returns {done, status, output}. If done=false, call again.",
    source: `export default async function (args: any, ctx: any) {
  const budgetMs = Math.min(Number(args.budgetSec ?? 20), 25) * 1000;
  const started = Date.now();
  let last: any = null;
  while (Date.now() - started < budgetMs) {
    const t: any = await ctx.swarm.task_get({ taskId: args.taskId });
    const d = t?.data ?? t ?? {};
    last = { status: d.status ?? null, output: d.output ?? null };
    if (["completed", "failed", "cancelled"].includes(String(last.status))) return { done: true, ...last };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { done: false, ...(last ?? {}), note: "budget exhausted; call wait-for-task again" };
}`,
  },
  {
    name: "get-child-outputs",
    description: "List all child tasks of a parent with status+output. Args: {parentTaskId}. Returns {children:[{id,status,agentId,output}], allDone}.",
    source: `export default async function (args: any, ctx: any) {
  const res: any = await ctx.swarm.task_list({ limit: 100 });
  const all: any[] = res?.data?.tasks ?? res?.tasks ?? (Array.isArray(res) ? res : []);
  const children = all.filter((t: any) => t.parentTaskId === args.parentTaskId);
  return {
    children: children.map((t: any) => ({ id: t.id, status: t.status, agentId: t.agentId ?? null, output: t.output ?? null })),
    allDone: children.length > 0 && children.every((t: any) => ["completed", "failed", "cancelled"].includes(t.status)),
  };
}`,
  },
  {
    name: "complete-task",
    description: "Mark a task completed (or failed) with final output. Args: {taskId, output, status?}. THE way to finish your task.",
    source: `export default async function (args: any, ctx: any) {
  await ctx.swarm.task_storeProgress({ taskId: args.taskId, status: args.status ?? "completed", output: args.output });
  return { ok: true, taskId: args.taskId, status: args.status ?? "completed" };
}`,
  },
  {
    name: "report-progress",
    description: "Post an in-progress note on a task. Args: {taskId, note}.",
    source: `export default async function (args: any, ctx: any) {
  await ctx.swarm.task_storeProgress({ taskId: args.taskId, status: "in_progress", output: args.note });
  return { ok: true };
}`,
  },
  {
    name: "swarm-overview",
    description: "Snapshot of the swarm: agents (name/role/status) + task counts by status. Args: none.",
    source: `export default async function (_args: any, ctx: any) {
  const s: any = await ctx.swarm.swarm_get({ includeFull: true });
  const agents: any[] = s?.data?.agents ?? s?.agents ?? [];
  const tl: any = await ctx.swarm.task_list({ limit: 100 });
  const tasks: any[] = tl?.data?.tasks ?? tl?.tasks ?? (Array.isArray(tl) ? tl : []);
  const tasksByStatus: Record<string, number> = {};
  for (const t of tasks) tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
  return { agents: agents.map((a: any) => ({ name: a.name ?? null, role: a.isLead ? "lead" : (a.role ?? "worker"), status: a.status ?? null })), tasksByStatus };
}`,
  },
];

export const PROMPT_OVERRIDE_BODY = `
## Code-Mode: script tools ONLY

This swarm runs in **scripts-only mode**. The ONLY swarm MCP tools available are: \`script-search\`, \`script-run\`, \`script-upsert\`, \`script-delete\`, \`script-query-types\`, \`launch-script-run\`, \`get-script-run\`, \`list-script-runs\`. They are already loaded — do NOT search for other swarm tools (\`store-progress\`, \`send-task\`, etc. do not exist here).

**Script entry signature (memorize this — args FIRST, ctx SECOND):**
\`\`\`ts
export default async function (args: any, ctx: any) { /* ... */ }
\`\`\`
The full swarm SDK is \`ctx.swarm.*\` (task_get, task_send, task_storeProgress, task_list, swarm_get, message_post, memory_search, kv_get/kv_set, ...). Responses are usually wrapped: prefer \`res?.data ?? res\`.

**Named seed scripts — USE THESE FIRST (via \`script-run\` with \`name\`, pass \`args\`):**
- \`delegate\` {agentName, task, parentTaskId?} → creates a subtask for an agent by name; returns {taskId}
- \`wait-for-task\` {taskId} → waits up to ~25s for terminal state; returns {done, status, output}; if done=false call it again
- \`get-child-outputs\` {parentTaskId} → all children with status+output
- \`complete-task\` {taskId, output} → THE way to finish your assigned task
- \`report-progress\` {taskId, note} → progress update
- \`swarm-overview\` {} → agents + task counts

Rules:
- Prefer a seed script over writing inline source. Write inline source ONLY for logic no seed covers.
- \`taskId\` is NOT ambient — pass your task id explicitly in \`args\`.
- Scripts are killed after ~30s, stdout capped at 1 MB. Never sleep/loop longer than ~25s inside one script; chain \`wait-for-task\` calls instead.
- Aggregate inside scripts; return only compact derived results.
`;

export async function applySeeds(base: string, apiKey: string): Promise<string[]> {
  const HJ = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Agent-ID": LEAD };
  const results: string[] = [];
  // prompt override (global)
  const pr = await fetch(`${base}/api/prompt-templates`, {
    method: "PUT", headers: HJ,
    body: JSON.stringify({ eventType: "system.agent.scripts_only_mode", scope: "global", body: PROMPT_OVERRIDE_BODY, changedBy: "matrix-experiment", changeReason: "seed-pack v2 prompt" }),
  });
  results.push(`prompt-override: ${pr.status}`);
  // seed scripts (global scope; lead identity)
  for (const s of SEED_SCRIPTS) {
    const r = await fetch(`${base}/api/scripts/upsert`, {
      method: "POST", headers: HJ,
      body: JSON.stringify({ name: s.name, source: s.source, description: s.description, intent: `seed: ${s.description.slice(0, 80)}`, scope: "global" }),
    });
    const bodyTxt = r.ok ? "" : ` ${(await r.text()).slice(0, 200)}`;
    results.push(`${s.name}: ${r.status}${bodyTxt}`);
  }
  return results;
}

// CLI entry
if (import.meta.main) {
  const cmd = process.argv[2];
  const KEY = (await Bun.file("/Users/taras/Documents/code/agent-swarm/.env").text()).match(/^API_KEY=(.*)$/m)![1].trim();
  const BASE = "http://localhost:3113";
  if (cmd === "apply" || cmd === "validate") {
    console.log((await applySeeds(BASE, KEY)).join("\n"));
  }
  if (cmd === "validate") {
    const HJ = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "X-Agent-ID": LEAD };
    const run = async (name: string, args: unknown) => {
      const r = await fetch(`${BASE}/api/scripts/run`, { method: "POST", headers: HJ, body: JSON.stringify({ name, args, intent: `validate seed ${name}` }) });
      const txt = await r.text();
      console.log(`\n>> ${name} (${r.status}): ${txt.slice(0, 400)}`);
      try { return JSON.parse(txt); } catch { return null; }
    };
    await run("swarm-overview", {});
    const del: any = await run("delegate", { agentName: "analyst", task: "VALIDATION: reply with the word ok as your entire output, then complete this task." });
    const childId = del?.result?.taskId ?? del?.taskId ?? del?.data?.taskId;
    if (childId) {
      await run("wait-for-task", { taskId: childId, budgetSec: 20 });
      await run("get-child-outputs", { parentTaskId: null });
    } else {
      console.log("(delegate did not return taskId — inspect output above)");
    }
  }
}
