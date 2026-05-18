#!/usr/bin/env bun
/**
 * Per-provider E2E QA helper for the cost & context tracking plan.
 *
 * Usage:
 *   bun tmp/qa/run-provider-e2e.ts <provider> <agentId>
 *
 * Creates 2 trivial tasks assigned to <agentId>, polls until completion,
 * then prints session_costs + task_context_snapshots + agent_tasks rows
 * so we can verify costSource / contextFormula / peakContextTokens.
 */

const [provider, agentId] = process.argv.slice(2);
if (!provider || !agentId) {
  console.error("usage: run-provider-e2e.ts <provider> <agentId>");
  process.exit(2);
}

const API = "http://localhost:3013";
const KEY = process.env.API_KEY || "123123";
const H = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  "X-Agent-ID": agentId,
};

const TASKS = [
  "Reply with exactly the word PONG. Then call store-progress with status='completed' and content='done'.",
  "Compute 7*8 and reply with just the number. Then call store-progress with status='completed' and content='done'.",
];

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function createTask(prompt: string): Promise<string> {
  const r = await fetch(`${API}/api/tasks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ task: prompt, agentId }),
  });
  if (!r.ok) throw new Error(`createTask ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { id: string; status: string };
  return j.id;
}

async function getTask(id: string): Promise<{ status: string; peakContextTokens?: number; contextWindowSize?: number; peakContextPercent?: number; model?: string }> {
  const r = await fetch(`${API}/api/tasks/${id}`, { headers: H });
  if (!r.ok) throw new Error(`getTask ${r.status}`);
  return r.json() as Promise<{ status: string; peakContextTokens?: number; contextWindowSize?: number; peakContextPercent?: number; model?: string }>;
}

async function waitForCompletion(id: string, timeoutMs = 10 * 60 * 1000): Promise<{ status: string; peakContextTokens?: number; contextWindowSize?: number; peakContextPercent?: number; model?: string }> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const t = await getTask(id);
    if (t.status !== last) {
      console.log(`  [${id.slice(0, 8)}] status: ${t.status}`);
      last = t.status;
    }
    if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") {
      // Adapters emit session_costs on CLI exit, which may lag the store-progress
      // completion call by several seconds. Wait a bit so cost rows actually land.
      await sleep(15000);
      return t;
    }
    await sleep(3000);
  }
  throw new Error(`timeout waiting for ${id}`);
}

async function getSessionCosts(taskId: string): Promise<Array<Record<string, unknown>>> {
  const r = await fetch(`${API}/api/session-costs?taskId=${taskId}`, { headers: H });
  if (!r.ok) {
    console.warn(`  session-costs ${r.status}: ${await r.text()}`);
    return [];
  }
  const j = (await r.json()) as { costs?: Array<Record<string, unknown>> };
  return j.costs ?? [];
}

async function getContextSnapshots(taskId: string): Promise<Array<Record<string, unknown>>> {
  const r = await fetch(`${API}/api/tasks/${taskId}/context`, { headers: H });
  if (!r.ok) return [];
  const j = (await r.json()) as { snapshots?: Array<Record<string, unknown>> };
  return j.snapshots ?? [];
}

(async () => {
  console.log(`\n=== E2E: ${provider} (agentId=${agentId}) ===`);
  const taskIds: string[] = [];
  for (const prompt of TASKS) {
    const id = await createTask(prompt);
    console.log(`  created task ${id.slice(0, 8)}: ${prompt.slice(0, 60)}…`);
    taskIds.push(id);
  }

  console.log("\nWaiting for completion…");
  const results = [];
  for (const id of taskIds) {
    const t = await waitForCompletion(id);
    results.push({ id, ...t });
  }

  console.log("\n=== Results ===");
  for (const r of results) {
    console.log(`\nTask ${r.id.slice(0, 8)} — status: ${r.status}`);
    console.log(`  model: ${r.model ?? "—"}`);
    console.log(`  peakContextTokens: ${r.peakContextTokens ?? "—"}`);
    console.log(`  peakContextPercent: ${r.peakContextPercent ?? "—"}`);
    console.log(`  contextWindowSize: ${r.contextWindowSize ?? "—"}`);

    const costs = await getSessionCosts(r.id);
    console.log(`  session_costs rows: ${costs.length}`);
    for (const c of costs) {
      console.log(
        `    | cost=$${(c.totalCostUsd as number)?.toFixed?.(6)} ` +
          `model=${c.model} ` +
          `in=${c.inputTokens} out=${c.outputTokens} ` +
          `cacheR=${c.cacheReadTokens} cacheW=${c.cacheWriteTokens ?? "null"} ` +
          `reason=${c.reasoningOutputTokens ?? 0} thinking=${c.thinkingTokens ?? 0} ` +
          `costSource=${c.costSource} ` +
          `provider=${(c as { provider?: string }).provider ?? "—"}`,
      );
    }

    const snaps = await getContextSnapshots(r.id);
    console.log(`  context_snapshots rows: ${snaps.length}`);
    for (const s of snaps.slice(0, 3)) {
      console.log(
        `    | used=${s.contextUsedTokens} total=${s.contextTotalTokens} pct=${s.contextPercent} formula=${s.contextFormula}`,
      );
    }
    if (snaps.length > 3) console.log(`    | (+ ${snaps.length - 3} more)`);
  }

  console.log("\n=== END ===");
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
