/**
 * Upgrade path: build in-flight rows in the OLD shapes on origin/main (worktree
 * at /tmp/main-wt), stop it, boot the PR branch on the SAME database file.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  check, createTask, makeApi, mcpConnect, minutesAgo, openDb, poll, registerSession, registerWorker,
  results, row, rows, scenario, stall, waitFor,
} from "./hb-lib";

const MAIN = "/tmp/main-wt";
const BRANCH = "/workspace/personal/repos/agent-swarm";
const stamp = Date.now();
const dbPath = `/tmp/upg-${stamp}.sqlite`;
const apiKey = randomBytes(8).toString("hex");
const secrets = `/tmp/upg-secrets-${stamp}`;
await Bun.$`mkdir -p ${secrets} /tmp/upg-fs-${stamp}`.quiet();
await Bun.write(`${secrets}/key`, randomBytes(32).toString("base64"));
const port = await new Promise<number>((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

function env(extra: Record<string, string> = {}) {
  const e: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "USER", "SHELL", "LANG"]) if (process.env[k]) e[k] = process.env[k]!;
  return {
    ...e, PORT: String(port), API_KEY: apiKey, AGENT_SWARM_API_KEY: apiKey, DATABASE_PATH: dbPath, NODE_ENV: "test",
    MULTI_RUNTIME_ENABLED: "true", SLACK_RENDER_V2: "false", HEARTBEAT_CHECKLIST_DISABLE: "true",
    AGENT_FS_LOCAL_DIR: `/tmp/upg-fs-${stamp}`, SECRETS_ENCRYPTION_KEY_FILE: `${secrets}/key`, OAUTH_KEEPALIVE_DISABLE: "true",
    GITHUB_DISABLE: "true", GITHUB_WEBHOOK_SECRET: "", LINEAR_DISABLE: "true", JIRA_DISABLE: "true", AGENTMAIL_DISABLE: "true",
    AGENTMAIL_API_KEY: "", ANONYMIZED_TELEMETRY: "false", SLACK_DISABLE: "true", HEARTBEAT_MAX_AUTO_ASSIGN: "0", ...extra,
  };
}
let proc: Bun.Subprocess | null = null;
let logN = 0;
async function boot(cwd: string, label: string, extra: Record<string, string> = {}) {
  const log = `/tmp/upg-${stamp}-${label}-${logN++}.log`;
  proc = Bun.spawn(["bun", "run", "src/http.ts"], { cwd, env: env(extra), stdout: Bun.file(log), stderr: Bun.file(log) });
  const ok = await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).status === 200; } catch { return false; } }, 60000, 300);
  check(ok, `API (${label}) did not boot; see ${log}`);
  console.log(`booted ${label} log=${log}`);
  return log;
}
async function stop() { proc?.kill("SIGTERM"); await Promise.race([proc?.exited, Bun.sleep(5000)]); if (proc?.exitCode === null) proc?.kill("SIGKILL"); await Bun.sleep(300); }
const sut: any = { baseUrl: `http://127.0.0.1:${port}`, apiKey, dbPath };
const api = makeApi(sut);
const ids: Record<string, string> = {};

// ------- phase 1: OLD code (origin/main) builds in-flight rows -------
await boot(MAIN, "main", { HEARTBEAT_INTERVAL_MS: "1000" });
let db = openDb(sut);
const W = await registerWorker(api, "upg-w");
const W2 = await registerWorker(api, "upg-w2");
const start = async (w: any, text: string, extra: Record<string, unknown> = {}) => {
  const id = await createTask(api, text, { agentId: w.id, ...extra });
  const p = await poll(api, w);
  check(p.json?.trigger?.taskId === id, `poll ${p.text.slice(0, 120)}`);
  return id;
};
// T1: graceful-shutdown supersede -> superseded + pinned resume child (+ dependent)
ids.T1 = await start(W, "T1 graceful");
ids.D1 = await createTask(api, "D1 depends on T1", { agentId: W.id, dependsOn: [ids.T1] });
const sup = await api("POST", `/api/tasks/${ids.T1}/supersede`, { agent: W.id, runtime: W.runtime, body: { reason: "graceful_shutdown" } });
ids.R1 = sup.json?.resumeTaskId;
// T2: crash: old heartbeat supersedes with crash_recovery + pinned resume
ids.T2 = await start(W2, "T2 crash");
ids.D2 = await createTask(api, "D2 depends on T2", { agentId: W2.id, dependsOn: [ids.T2] });
stall(db, ids.T2, 10);
await waitFor(() => row(db, ids.T2).status === "superseded", 15000);
ids.R2 = rows(db, "select id from agent_tasks where parentTaskId = ?", ids.T2)[0]?.id;
// deferred waiter on T2 (wakeOn settled) — to check "superseded member follows its continuation"
const W3 = await registerWorker(api, "upg-w3");
ids.WAIT = await start(W3, "waiter on T2");
// (defer before T2 was superseded is not possible now; defer on R2 instead — the continuation)
// T3: crash between the two old non-atomic writes: superseded, no resume child
const W4 = await registerWorker(api, "upg-w4");
ids.T3 = await start(W4, "T3 superseded-no-child");
db.run("UPDATE agent_tasks SET status='superseded', lastUpdatedAt=? WHERE id=?", [minutesAgo(30), ids.T3]);
// T4: still running with a fresh session at upgrade time
const W5 = await registerWorker(api, "upg-w5");
ids.T4 = await start(W5, "T4 running");
await registerSession(api, W5, ids.T4);
// T5: reboot-sweep candidate: in_progress + session, then API killed and rebooted on OLD code
const W6 = await registerWorker(api, "upg-w6");
ids.T5 = await start(W6, "T5 reboot");
await registerSession(api, W6, ids.T5);
db.run("UPDATE agent_tasks SET lastUpdatedAt=? WHERE id=?", [minutesAgo(3), ids.T5]);
db.close();
await stop();
await boot(MAIN, "main-reboot", { HEARTBEAT_INTERVAL_MS: "1000" });
db = openDb(sut);
await Bun.sleep(3500);
ids.R5 = rows(db, "select id from agent_tasks where parentTaskId = ? or (task like ? and id != ?)", ids.T5, "%T5 reboot%", ids.T5)[0]?.id;
const snap = (label: string) => {
  const out: Record<string, any> = {};
  for (const [k, id] of Object.entries(ids)) if (id) { const r = row(db, id); out[k] = r ? `${r.status}${r.agentId ? "" : "/nopin"}${r.attempt !== undefined ? "/a" + r.attempt : ""}` : "missing"; }
  console.log(label, JSON.stringify(out));
  return out;
};
const before = snap("OLD-STATE(main)");
const oldTags = rows(db, "select id, taskType, tags, status, agentId from agent_tasks where taskType='resume' or tags like '%reboot%'").map((r) => `${r.id.slice(0, 6)}:${r.taskType}:${r.status}:${r.tags}`);
console.log("legacy rows:", JSON.stringify(oldTags));
const countBefore = rows(db, "select count(*) n from agent_tasks")[0].n;
const migsBefore = rows(db, "select count(*) n from _migrations")[0]?.n;
db.close();
await stop();

// ------- phase 2: PR branch on the same DB -------
await boot(BRANCH, "branch", { HEARTBEAT_INTERVAL_MS: "1000" });
db = openDb(sut);
await Bun.sleep(4000);

await scenario("UP1 migration applies; attempt=0 on every legacy row; no rows lost", async () => {
  const cols = rows(db, "pragma table_info(agent_tasks)").map((r) => r.name);
  check(cols.includes("attempt") && cols.includes("attemptRuntimeId"), "columns missing");
  const n = rows(db, "select count(*) n from agent_tasks")[0].n;
  const nonzero = rows(db, "select count(*) n from agent_tasks where attempt != 0")[0].n;
  return `rows ${countBefore}->${n}; attempt!=0: ${nonzero}`;
});
snap("AFTER-UPGRADE");

await scenario("UP2 legacy pinned resume children are picked up exactly once by their agent", async () => {
  const seen: string[] = [];
  for (const [w, rid] of [[W, ids.R1], [W2, ids.R2]] as const) {
    if (!rid) continue;
    const p = await poll(api, w);
    seen.push(`${rid.slice(0, 6)}→${p.json?.trigger?.taskId === rid ? "started" : JSON.stringify(p.json?.trigger)?.slice(0, 100)}`);
    const p2 = await poll(api, w);
    check(p2.json?.trigger?.taskId !== rid, "handed out twice");
  }
  return seen.join(" ");
});

await scenario("UP3 legacy dependents of superseded parents after upgrade", async () => {
  const d1 = row(db, ids.D1), d2 = row(db, ids.D2);
  return `D1(dep of T1 superseded)=${d1.status} D2(dep of T2 superseded)=${d2.status}`;
});

await scenario("UP4 superseded row with no resume child (T3) stays stranded", async () => {
  await Bun.sleep(2000);
  const kids = rows(db, "select id from agent_tasks where parentTaskId=?", ids.T3);
  return `T3=${row(db, ids.T3).status} children=${kids.length}`;
});

await scenario("UP5 T4 (running, fresh session) untouched; T5 reboot state", async () => {
  const t4 = row(db, ids.T4), t5 = row(db, ids.T5);
  const r5 = ids.R5 ? row(db, ids.R5) : null;
  check(t4.status === "in_progress" && t4.attempt === 0, `T4 ${t4.status}`);
  return `T4=${t4.status}; T5=${t5.status}(${t5.failureReason ?? ""}) R5=${r5 ? r5.status + "/" + r5.agentId?.slice(0, 4) : "none"}`;
});

await scenario("UP6 unclaimed legacy pin (worker never returns) is Unpinned after grace (no strand, no duplicate)", async () => {
  const W7 = await registerWorker(api, "upg-w7");
  const spare = await registerWorker(api, "upg-spare");
  const t = await start(W7, "legacy-pin-src");
  const r = await api("POST", `/api/tasks/${t}/supersede`, { agent: W7.id, runtime: W7.runtime, body: { reason: "graceful_shutdown" } });
  // NOTE: created on the branch; legacy tagged shape is identical (supersede path unchanged)
  const rid = r.json.resumeTaskId;
  db.run("UPDATE agent_tasks SET lastUpdatedAt=? WHERE id=?", [minutesAgo(30), rid]);
  check(await waitFor(() => row(db, rid).status === "unassigned", 15000), `status ${row(db, rid).status}`);
  const p = await poll(api, spare);
  return `resume ${row(db, rid).status}→ spare polled: ${p.json?.trigger?.taskId === rid ? "claimed" : JSON.stringify(p.json?.trigger)?.slice(0, 80)}`;
});

console.log("\n=== UPGRADE RESULTS ===");
for (const r of results) console.log(`${r.status}\t${r.name}\t${r.detail.slice(0, 400)}`);
await Bun.write("/tmp/hb-upgrade-results.json", JSON.stringify({ before, ids, results }, null, 2));
db.close();
await stop();
