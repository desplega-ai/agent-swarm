#!/usr/bin/env bun
/**
 * Standalone E2E demo recorder — full task lifecycle with visible UI motion.
 *
 * Shows: tasks list → open task (pending) → in_progress (agent pick-up) →
 *        progress ticks → completed with output → back to list.
 *
 * State transitions are seeded directly into the DB. The SPA polls the API
 * every 5 seconds (configured in providers.tsx), so we update the DB and then
 * linger 6-8s — the polling fires mid-linger and the badge transitions live
 * on screen. VP8 encodes the state-change frames with high fidelity.
 *
 * Usage:
 *   cd assets/release-recorder
 *   bun record-e2e.ts
 *   bun record-e2e.ts --out /tmp/swarm-e2e-raw.webm
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const defaultOut = join(import.meta.dir, "raw/e2e-demo.webm");
const RAW_OUT = outIdx >= 0 ? (args[outIdx + 1] ?? defaultOut) : defaultOut;
const UI = process.env.SWARM_UI_URL ?? "http://localhost:5274";
const API = process.env.SWARM_API_URL ?? "http://localhost:3013";
const API_KEY = process.env.API_KEY ?? "123123";
const DB_PATH = join(import.meta.dir, "../../agent-swarm-db.sqlite");

mkdirSync(join(import.meta.dir, "raw"), { recursive: true });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Linger with alternating 80px scrolls to generate VP8 frames.
 * Large enough scroll to move content and force real frame encoding,
 * small enough to keep the status badge / progress text in viewport.
 */
async function linger(ms: number) {
  const stepMs = 600;
  const steps = Math.max(1, Math.floor(ms / stepMs));
  for (let i = 0; i < steps; i++) {
    const dir = i % 2 === 0 ? "down" : "up";
    await $`agent-browser scroll ${dir} 80`.quiet().catch(() => {});
    await sleep(stepMs);
  }
}

/**
 * Force React Query to refetch the task immediately.
 * The recording browser may be "backgrounded" from React Query's perspective,
 * so polling may not fire automatically. This bypasses polling entirely.
 */
async function invalidateTask(taskId: string) {
  const js = `window.__queryClient?.invalidateQueries({queryKey:["task","${taskId}"]})`;
  await $`agent-browser eval ${js}`.quiet().catch(() => {});
  await sleep(800); // wait for refetch + re-render
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiPost(path: string, body: unknown) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`POST ${path}: HTTP ${r.status} ${text}`);
  }
  return r.json();
}

function dbRun(db: Database, sql: string, ...params: (string | number | null)[]) {
  db.run(sql, params);
}

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

console.log("🎬 E2E demo recorder starting...");

const health = (await fetch(`${API}/health`)
  .then((r) => r.json())
  .catch(() => null)) as { status?: string; version?: string } | null;
if (!health?.status) {
  console.error(`✗ API not reachable at ${API} — run bin/reset-demo-stack.sh first`);
  process.exit(1);
}
console.log(`  API: ${API} ✓ (v${health!.version})`);

const uiCode = await $`curl -sf -o /dev/null -w "%{http_code}" ${UI}`.text().catch(() => "0");
if (!uiCode.trim().startsWith("2")) {
  console.error(`✗ UI not reachable at ${UI} — run bin/reset-demo-stack.sh first`);
  process.exit(1);
}
console.log(`  UI: ${UI} ✓`);

const db = new Database(DB_PATH);
console.log(`  DB: ${DB_PATH} ✓`);
console.log(`  Out: ${RAW_OUT}\n`);

// ---------------------------------------------------------------------------
// Pre-create demo user (prevents "Who are you?" modal blocking the recording)
// ---------------------------------------------------------------------------

const demoSuffix = Math.random().toString(36).slice(2, 10);
const demoUserId = `demo-user-${demoSuffix}`;
const nowTs = new Date().toISOString();
db.run("INSERT INTO users (id, name, email, createdAt, lastUpdatedAt) VALUES (?,?,?,?,?)", [
  demoUserId,
  "Demo User",
  `demo-${demoSuffix}@swarm.local`,
  nowTs,
  nowTs,
]);
console.log(`  demo user: ${demoUserId} ✓`);

// ---------------------------------------------------------------------------
// Pre-create the demo task before recording starts (so we have the ID)
// ---------------------------------------------------------------------------

console.log("⚙  Pre-creating demo task via API...");
const taskDesc = "Analyze PR #513 — security review for the release-recorder pipeline";
const created = (await apiPost("/api/tasks", {
  task: taskDesc,
  priority: 80,
  tags: ["security", "review"],
  source: "api",
})) as { id: string; status: string };
const taskId = created.id;
console.log(`  task id: ${taskId} (${created.status})\n`);

// ---------------------------------------------------------------------------
// EXIT-trap
// ---------------------------------------------------------------------------

let recording = false;
process.on("exit", () => {
  if (recording) {
    try {
      Bun.spawnSync(["agent-browser", "record", "stop"]);
    } catch {
      /* best-effort */
    }
  }
});
for (const sig of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
  process.on(sig, () => process.exit(1));
}

// ---------------------------------------------------------------------------
// START RECORDING
// ---------------------------------------------------------------------------

console.log(`🔴 Starting recording → ${RAW_OUT}`);
await $`agent-browser record start ${RAW_OUT} ${UI}`;
recording = true;
await sleep(1200); // let home page render

// Inject connection config + user identity so the UI auto-connects
const connConfig = JSON.stringify({
  connections: [{ id: "demo-conn", name: "local", apiUrl: API, apiKey: API_KEY }],
  activeId: "demo-conn",
});
const userKey = `swarm:v1:${API}:current-user`;
const jsInject = [
  `localStorage.setItem('agent-swarm-connections', '${connConfig}')`,
  `localStorage.setItem('${userKey}', '${demoUserId}')`,
].join(";");
await $`agent-browser eval ${jsInject}`;
await sleep(300);

// ---------------------------------------------------------------------------
// Scene 1: Tasks list
// ---------------------------------------------------------------------------

const t0 = Date.now();
console.log("📸 Scene 1: Tasks list...");
await $`agent-browser open ${UI}/tasks`;
await sleep(1000);
await linger(3000);
console.log(`  duration so far: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// Scene 2: Task detail — pending state (navigate once, stay here for all scenes)
// ---------------------------------------------------------------------------

console.log("📸 Scene 2: Task detail — pending");
await $`agent-browser open ${UI}/tasks/${taskId}`;
await sleep(1500); // wait for initial data load
await linger(3000); // show PENDING for 3s
console.log(`  duration so far: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// Scene 3: pending → in_progress
// The SPA polls every 5s. Update DB then wait 6.5s: polling fires mid-linger
// and the badge transitions live on screen.
// ---------------------------------------------------------------------------

console.log("📸 Scene 3: in_progress — agent claimed the task");
dbRun(
  db,
  "UPDATE agent_tasks SET status='in_progress', lastUpdatedAt=? WHERE id=?",
  new Date().toISOString(),
  taskId,
);
await invalidateTask(taskId); // force React Query refetch immediately
await linger(3000); // linger showing IN PROGRESS badge
console.log(`  duration so far: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// Scene 4a: Progress update 1
// ---------------------------------------------------------------------------

console.log("📸 Scene 4a: progress — scanning...");
dbRun(
  db,
  "UPDATE agent_tasks SET progress=?, lastUpdatedAt=? WHERE id=?",
  "🔍 Scanning PR diff for authentication changes...",
  new Date().toISOString(),
  taskId,
);
await invalidateTask(taskId);
await linger(2400);
console.log(`  duration so far: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// Scene 4b: Progress update 2
// ---------------------------------------------------------------------------

console.log("📸 Scene 4b: progress — issues found...");
dbRun(
  db,
  "UPDATE agent_tasks SET progress=?, lastUpdatedAt=? WHERE id=?",
  "⚠️  Found 2 potential issues — checking token expiry and CSRF headers",
  new Date().toISOString(),
  taskId,
);
await invalidateTask(taskId);
await linger(2400);
console.log(`  duration so far: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// Scene 4c: Progress update 3
// ---------------------------------------------------------------------------

console.log("📸 Scene 4c: progress — completing...");
dbRun(
  db,
  "UPDATE agent_tasks SET progress=?, lastUpdatedAt=? WHERE id=?",
  "✅ Review complete — writing final report",
  new Date().toISOString(),
  taskId,
);
await invalidateTask(taskId);
await linger(2400);
console.log(`  duration so far: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// Scene 5: Task completes with full output
// ---------------------------------------------------------------------------

console.log("📸 Scene 5: Completed with output");
const output = [
  "Security review of PR #513 (release-recorder pipeline):",
  "",
  "RESULT: ✅ APPROVED — 2 low-severity findings:",
  "  1. Token expiry not validated on WebM upload endpoint",
  "     → Non-critical: local dev tool, no external auth gate needed",
  "  2. Missing CSRF header on /api/tasks POST",
  "     → Mitigated by mandatory Bearer token requirement",
  "",
  "No blocking issues. Safe to merge.",
].join("\n");

dbRun(
  db,
  `UPDATE agent_tasks
   SET status='completed', output=?, progress=NULL,
       finishedAt=?, lastUpdatedAt=?
   WHERE id=?`,
  output,
  new Date().toISOString(),
  new Date().toISOString(),
  taskId,
);
await invalidateTask(taskId);
await linger(4800); // longer — let viewer read the completed output
console.log(`  duration so far: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// Scene 6: Back to tasks list — completed task visible
// ---------------------------------------------------------------------------

console.log("📸 Scene 6: Tasks list — completed task visible");
await $`agent-browser open ${UI}/tasks`;
await sleep(1000);
await linger(3000);
console.log(`  total recording time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// STOP RECORDING
// ---------------------------------------------------------------------------

console.log("\n⏹  Stopping recording...");
await $`agent-browser record stop`;
recording = false;
db.close();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

await sleep(500);
const fileSize = Bun.file(RAW_OUT).size;
const sizeMb = (fileSize / 1024 / 1024).toFixed(1);
console.log(`\n✅ Recorded: ${RAW_OUT} (${sizeMb} MB)`);
console.log(`\nNext steps:`);
console.log(
  `  ffmpeg -y -i ${RAW_OUT} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -movflags +faststart -an /tmp/swarm-e2e-demo.mp4`,
);
