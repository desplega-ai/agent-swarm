// @ts-nocheck — research artifact (scripts-only MCP experiment), not product code
// Phase 0: boot scripts-only claude stack, apply + validate seed scripts, leave stack up for inspection.
import { applySeeds } from "./matrix-seeds.ts";

const REPO = process.env.SWARM_REPO ?? process.cwd(); // run from the repo root or set SWARM_REPO
const BASE = "http://localhost:3113";
const KEY = (await Bun.file(`${REPO}/.env`).text()).match(/^API_KEY=(.*)$/m)![1].trim();
const LEAD = "7a1e0000-0000-4000-8000-000000000001";
const HJ = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "X-Agent-ID": LEAD };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[validate] ${m}`);

async function compose(args: string[]) {
  const env = { ...process.env, SCRIPTS_ONLY_MCP: "true", MATRIX_PROVIDER: "claude", MATRIX_MODEL: "" };
  const p = Bun.spawn(["docker", "compose", "-f", "docker-compose.scripts-only.yml", ...args], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(`compose failed: ${(await new Response(p.stderr).text()).slice(-300)}`);
}

log("down -v && up -d");
await compose(["down", "-v", "--remove-orphans"]);
await compose(["up", "-d", "--no-build"]);

for (let i = 0; i < 90; i++) {
  await sleep(10_000);
  const r = await fetch(`${BASE}/api/agents`, { headers: HJ }).then((r) => r.json()).catch(() => null);
  if ((r?.agents ?? []).length >= 3) { log(`agents ready after ~${(i + 1) * 10}s`); break; }
  if (i === 89) { log("BOOT TIMEOUT"); process.exit(1); }
}
await sleep(10_000);

log("applying seeds...");
console.log((await applySeeds(BASE, KEY)).join("\n"));

const run = async (name: string, args: unknown) => {
  const r = await fetch(`${BASE}/api/scripts/run`, { method: "POST", headers: HJ, body: JSON.stringify({ name, args, intent: `validate seed ${name}` }) });
  const txt = await r.text();
  console.log(`\n>> ${name} (${r.status}): ${txt.slice(0, 500)}`);
  try { return JSON.parse(txt); } catch { return null; }
};

await run("swarm-overview", {});
const del: any = await run("delegate", { agentName: "analyst", task: "VALIDATION: complete this task with the single word ok as output. Do nothing else." });
const childId = del?.result?.taskId ?? del?.taskId ?? del?.data?.taskId ?? del?.output?.taskId;
console.log("\nchildId:", childId);
if (childId) {
  // wait for the analyst to actually finish (its session takes a couple min)
  for (let i = 0; i < 20; i++) {
    const w: any = await run("wait-for-task", { taskId: childId, budgetSec: 20 });
    const done = w?.result?.done ?? w?.done;
    if (done) break;
    await sleep(5_000);
  }
  await run("get-child-outputs", { parentTaskId: null });
  await run("report-progress", { taskId: childId, note: "validation note (post-completion, should still 200)" });
}
log("VALIDATION COMPLETE — stack left up");
