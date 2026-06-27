#!/usr/bin/env bun
/**
 * DES-523 crash-recovery — Part 2: focused Docker happy-path (real restart-and-reclaim).
 *
 * Proves the one hop the API-level Part 1 (scripts/e2e-des523-crash-recovery-api.ts)
 * can't reach: a REAL worker container is SIGKILL'd mid-task, crash-detected, its
 * resume is pinned to the stable AGENT_ID, and the SAME-id restarted container
 * reclaims and runs it via its real poll loop.
 *
 * Prereqs — bring the stack up first (from repo root):
 *   OV=scripts/e2e-des523-crash-recovery.override.yml
 *   docker compose -f docker-compose.local.yml -f $OV down -v
 *   docker compose -f docker-compose.local.yml -f $OV build api          # build api from this branch
 *   docker compose -f docker-compose.local.yml -f $OV up -d api pi-worker # worker image reused
 *   # wait for the worker to register (GET /api/agents), then:
 *   bun run scripts/e2e-des523-crash-recovery-docker.ts
 *   docker compose -f docker-compose.local.yml -f $OV down -v            # cleanup
 *
 * The override shortens heartbeat thresholds, sets restart:"no" on the worker, and
 * pins the model to deepseek-v4-flash. The api has no DB volume → fresh container =
 * fresh DB. The API key is read from .env at runtime and never printed.
 *
 * Note: with the deliberately-aggressive 1-min STALL_NO_SESSION_MIN, a slow model
 * (deepseek upstream idle timeouts) can cause the reclaimed resume to be superseded
 * before it registers a session — the next generation is RE-PINNED to A (the
 * invariant holds). That's a model/threshold artifact, not a DES-523 defect; the
 * reclaim hop (this script's purpose) is asserted before any of that.
 */

const BASE = "http://localhost:3013";
const A = "cfecf31f-d3bb-4a5b-ab29-43bc49082031"; // pi-worker AGENT_ID from docker-compose.local.yml
const WORKER = "swarm-pi-worker";
const PIN_TAG = "crash-recovery-pin";

// Read API key from .env (same precedence the server uses). Never printed.
let KEY = "123123";
try {
  const env = await Bun.file(".env").text();
  const m = env.match(/^AGENT_SWARM_API_KEY=(.*)$/m) ?? env.match(/^API_KEY=(.*)$/m);
  if (m) KEY = m[1].trim().replace(/^["']|["']$/g, "");
} catch {}

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(cond: boolean, msg: string, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  ✗ ${msg}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, body: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, body: text }; }
}
async function tasks(): Promise<any[]> {
  return (await api("GET", "/api/tasks?fields=full&limit=200")).body?.tasks ?? [];
}
async function sessionsFor(agentId: string): Promise<any[]> {
  return (await api("GET", `/api/active-sessions?agentId=${agentId}`)).body?.sessions ?? [];
}
async function docker(cmd: string): Promise<void> {
  const p = Bun.spawn(["docker", ...cmd.split(" ")], { stdout: "pipe", stderr: "pipe" });
  await p.exited;
}
function fmt(t: any) {
  return t ? { id: t.id?.slice(0, 8), type: t.taskType, status: t.status, agentId: t.agentId?.slice(0, 8), tags: t.tags } : null;
}

console.log(`Part 2 — real Docker restart-and-reclaim (agent A=${A.slice(0, 8)}, model deepseek-v4-flash)\n`);

// Pre-flight: API reachable + worker registered.
const agentsResp = await api("GET", "/api/agents");
if (agentsResp.status !== 200) {
  console.error("API not reachable on :3013 — bring the stack up first (see header).");
  process.exit(1);
}
if (!(agentsResp.body?.agents ?? []).some((a: any) => a.id === A)) {
  console.error(`Worker ${A.slice(0, 8)} not registered yet — wait for it, then re-run.`);
  process.exit(1);
}

// ── 1. send a sustained task to A ──
const prompt =
  "Write an extremely detailed ~1500 word technical essay explaining, step by step, how a distributed " +
  "multi-agent task system detects and recovers from a worker that crashes mid-task. Cover heartbeats, " +
  "active-session tracking, stall detection, and same-agent resume pinning. Be thorough; write the full essay.";
const created = await api("POST", "/api/tasks", { task: prompt, agentId: A, source: "api" });
check(created.status === 201, "task created & pinned to A", { status: created.status });
const taskId = created.body?.id;
console.log(`  task ${taskId?.slice(0, 8)} created (status=${created.body?.status})`);

// ── 2. wait until in_progress WITH a real active_session ──
console.log("\n── waiting for A to start running it (in_progress + active_session) ──");
let started = false;
for (let i = 0; i < 90; i++) {
  const t = (await tasks()).find((x) => x.id === taskId);
  const sess = await sessionsFor(A);
  const hasSession = sess.some((s) => s.taskId === taskId);
  if (t?.status === "in_progress" && hasSession) {
    console.log(`  A is running it after ~${i}s (in_progress + active_session present)`);
    started = true;
    break;
  }
  await sleep(1000);
}
check(started, "A picked up the task and created an active_session (real run in progress)");

// ── 3. docker kill A mid-task ──
console.log("\n── SIGKILL the worker mid-task ──");
await docker(`kill ${WORKER}`);
console.log(`  killed ${WORKER}`);
await sleep(2000);
const psAfterKill = Bun.spawnSync(["docker", "ps", "--filter", `name=${WORKER}`, "--format", "{{.Names}}"]).stdout.toString().trim();
check(!psAfterKill.includes(WORKER), "worker container is down (restart:no held)", psAfterKill || "(none running)");

// ── 4. wait for crash detection → pinned resume ──
console.log("\n── waiting for crash detection + pin (Case B, ~1min stale + 10s sweep) ──");
let pin: any = null;
let original: any = null;
for (let i = 0; i < 150; i++) {
  const all = await tasks();
  original = all.find((x) => x.id === taskId);
  pin = all.find((x) => x.taskType === "resume" && x.parentTaskId === taskId);
  if (original?.status === "superseded" && pin) {
    console.log(`  detected after ~${i}s`);
    break;
  }
  await sleep(1000);
}
check(original?.status === "superseded", "original task superseded by crash classifier", original?.status);
check(!!pin, "a resume pin was created");
check(pin?.agentId === A, "resume pinned to A (NOT unassigned)", pin?.agentId);
check(Array.isArray(pin?.tags) && pin.tags.includes(PIN_TAG), "resume tagged crash-recovery-pin", pin?.tags);
console.log(`  pin: ${JSON.stringify(fmt(pin))}`);

// ── 5. restart A (same AGENT_ID) → reclaim + run ──
console.log("\n── restarting the worker (same AGENT_ID) ──");
await docker(`start ${WORKER}`);
console.log(`  started ${WORKER}; waiting for it to reclaim and run the pin`);
let reclaimedInProgress = false;
let completed = false;
let lastSeen: any = null;
for (let i = 0; i < 200; i++) {
  const all = await tasks();
  const r = all.find((x) => x.id === pin?.id);
  lastSeen = r;
  if (r?.status === "in_progress" && r.agentId === A && !reclaimedInProgress) {
    console.log(`  A reclaimed the pin after ~${i}s (in_progress)`);
    reclaimedInProgress = true;
  }
  if (r && ["completed", "done"].includes(r.status)) {
    console.log(`  resume reached terminal status '${r.status}' after ~${i}s`);
    completed = true;
    break;
  }
  if (r && r.agentId && r.agentId !== A) break; // bail if reassigned away from A
  await sleep(1500);
}
check(reclaimedInProgress, "restarted A reclaimed its own pinned resume (in_progress, agentId=A)", fmt(lastSeen));
check(lastSeen?.agentId === A, "resume stayed owned by A throughout (never reassigned to another agent)", lastSeen?.agentId);
if (completed) check(true, "resume ran to completion on the restarted worker");
else console.log(`  (note) resume not yet completed at timeout — last status=${lastSeen?.status}; reclaim hop already proven`);

// ── 6. global invariants ──
console.log("\n── global invariants ──");
const all = await tasks();
const resumeRows = all.filter((x) => x.taskType === "resume");
check(!resumeRows.some((r) => r.status === "unassigned"), "no resume ever fell to the unassigned pool", resumeRows.map(fmt));
const owners = new Set(resumeRows.map((r) => r.agentId));
check(owners.size === 1 && owners.has(A), "every resume row owned solely by A", [...owners]);

console.log(`\n── Summary ──`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
if (fail > 0) { console.log("  Failed:"); for (const f of failures) console.log(`    - ${f}`); }
console.log(`\n${fail === 0 ? "RESULT: PASS ✅" : "RESULT: FAIL ❌"}`);
process.exit(fail === 0 ? 0 : 1);
