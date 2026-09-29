/** bun scripts/qa/hb-e2e.ts [--multi=false] — real-API QA of PR #1682 */
import {
  check, createTask, findings, getTask, makeApi, mcpConnect, minutesAgo, openDb, poll, registerSession,
  registerWorker, results, row, rows, scenario, stall, startSut, stopSut, waitFor, restartSut,
} from "./hb-lib";

const multi = !process.argv.includes("--multi=false");
const sut = await startSut(true, {}, {
  MULTI_RUNTIME_ENABLED: String(multi),
  HEARTBEAT_INTERVAL_MS: "1000",
  HEARTBEAT_MAX_AUTO_ASSIGN: "0",
});
console.log(`SUT ${sut.baseUrl} db=${sut.dbPath} multi=${multi}`);
const api = makeApi(sut);
let db = openDb(sut);
const nrows = () => (db.query("SELECT COUNT(*) n FROM agent_tasks").get() as any).n as number;

// start a task for a worker via the real poll path, return task id
async function started(w: any, text = "work", extra: Record<string, unknown> = {}) {
  const id = await createTask(api, text, { agentId: w.id, ...extra });
  const p = await poll(api, w);
  check(p.json?.trigger?.taskId === id, `poll did not hand out task: ${p.text.slice(0, 200)}`);
  return id;
}
const reclaimed = (id: string) => waitFor(() => row(db, id)?.attempt >= 1 && row(db, id)?.status !== "in_progress", 15000);

await scenario("S1 worker dies mid-task → reclaimed in place, no new row", async () => {
  const w = await registerWorker(api, "s1");
  const id = await started(w);
  await registerSession(api, w, id);
  const before = nrows();
  stall(db, id, 10);
  check(await reclaimed(id), `not reclaimed: ${JSON.stringify(row(db, id))}`);
  const r = row(db, id);
  check(r.status === "pending" && r.attempt === 1 && r.agentId === w.id, `row ${r.status}/${r.attempt}`);
  check(nrows() === before, "new row created");
  // same worker re-polls: gets the same row back, started with attempt 1
  const p = await poll(api, w);
  check(p.json?.trigger?.taskId === id, `repoll: ${p.text.slice(0, 200)}`);
  check(row(db, id).status === "in_progress" && row(db, id).attemptRuntimeId === w.runtime, "restamp");
  return `attempt=${r.attempt} rows=${nrows()}`;
});

await scenario("S2a stale worker store-progress(completed) after reclaim, pending row (agent+source hdrs)", async () => {
  const w = await registerWorker(api, "s2a");
  const id = await started(w);
  stall(db, id, 10);
  check(await reclaimed(id), "not reclaimed");
  const m = await mcpConnect(sut, w.id, { runtime: w.runtime, sourceTask: id });
  const r = await m.call("store-progress", { taskId: id, status: "completed", output: "STALE" });
  await m.close();
  const t = row(db, id);
  check(t.status !== "completed", `stale completed the reclaimed row: ${r.text.slice(0, 200)}`);
  return `rejected: ${r.text.slice(0, 120)}`;
});

await scenario("S2b stale store-progress WITHOUT source-task header / runtime header after reclaim", async () => {
  const w = await registerWorker(api, "s2b");
  const id = await started(w);
  stall(db, id, 10);
  check(await reclaimed(id), "not reclaimed");
  const m = await mcpConnect(sut, w.id, {});
  const r = await m.call("store-progress", { taskId: id, status: "completed", output: "STALE-NOHDR" });
  await m.close();
  check(row(db, id).status !== "completed", `completed: ${r.text.slice(0, 200)}`);
  return r.text.slice(0, 120);
});

await scenario("S2c old runtime completes replacement attempt (same agent, 2 runtimes)", async () => {
  if (!multi) return "skipped (single-runtime)";
  const w = await registerWorker(api, "s2c");
  const rt2 = `rt2-${Math.random().toString(36).slice(2, 7)}`;
  await api("POST", "/api/agents", { agent: w.id, runtime: rt2, body: { name: "s2c", role: "worker", status: "idle", runtimeInstanceId: rt2, maxTasks: 1 } });
  const id = await started(w);
  stall(db, id, 10);
  check(await reclaimed(id), "not reclaimed");
  const p = await poll(api, w, rt2); // runtime B starts attempt 1
  check(p.json?.trigger?.taskId === id, `B did not get it: ${p.text.slice(0, 150)}`);
  for (const [label, rt] of [["A with runtime", w.runtime], ["A headerless", undefined]] as const) {
    const m = await mcpConnect(sut, w.id, { runtime: rt, sourceTask: id });
    const r = await m.call("store-progress", { taskId: id, status: "completed", output: "STALE-A" });
    await m.close();
    check(row(db, id).status === "in_progress", `${label} completed B's attempt: ${r.text.slice(0, 150)}`);
  }
  // legit B completes
  const m = await mcpConnect(sut, w.id, { runtime: rt2, sourceTask: id });
  const r = await m.call("store-progress", { taskId: id, status: "completed", output: "B-DONE" });
  await m.close();
  check(row(db, id).status === "completed", `B could not complete: ${r.text.slice(0, 200)}`);
});

await scenario("S3 two workers race to claim a reclaimed+unpinned row", async () => {
  const w = await registerWorker(api, "s3-owner");
  const c1 = await registerWorker(api, "s3-c1");
  const c2 = await registerWorker(api, "s3-c2");
  const id = await started(w);
  stall(db, id, 10);
  check(await reclaimed(id), "not reclaimed");
  // owner never returns; backdate pending row past Unpin grace
  db.run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [minutesAgo(30), id]);
  check(await waitFor(() => row(db, id).status === "unassigned", 15000), `not unpinned: ${row(db, id).status}`);
  const results2 = await Promise.all([poll(api, c1), poll(api, c2), poll(api, c1), poll(api, c2)]);
  const winners = results2.filter((r) => r.json?.trigger?.taskId === id);
  const rr = row(db, id);
  check(rr.status === "in_progress", `status ${rr.status}`);
  return `winners=${winners.length} agent=${rr.agentId === c1.id ? "c1" : rr.agentId === c2.id ? "c2" : rr.agentId} affinity=${String(rr.routingAffinity).slice(0, 80)} attempt=${rr.attempt}`;
});

await scenario("S4 retry budget exhausted → failed, dependents cascade", async () => {
  const w = await registerWorker(api, "s4");
  const id = await started(w);
  const dep = await createTask(api, "dependent", { agentId: w.id, dependsOn: [id] });
  db.run("UPDATE agent_tasks SET attempt = 3 WHERE id = ?", [id]);
  stall(db, id, 10);
  check(await waitFor(() => row(db, id).status === "failed", 15000), `status ${row(db, id).status}`);
  check(await waitFor(() => row(db, dep).status === "failed", 8000), `dependent ${row(db, dep).status}`);
  return `reason=${row(db, id).failureReason}; dependent=${row(db, dep).status}`;
});

await scenario("S5a Lead-held reclaimed pin never unpinned (stranded if lead dead?)", async () => {
  const lead = await registerWorker(api, "s5-lead", { lead: true, role: "lead" });
  const id = await started(lead, "lead work");
  stall(db, id, 10);
  check(await reclaimed(id), "not reclaimed");
  db.run("UPDATE agents SET status='offline' WHERE id = ?", [lead.id]);
  db.run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [minutesAgo(120), id]);
  await Bun.sleep(4000);
  const r = row(db, id);
  return `offline lead, pin 120m old: status=${r.status} agent=${r.agentId === lead.id ? "lead" : r.agentId}`;
});

await scenario("S7 dependsOn dependent stays pending during reclaim, runs after completion", async () => {
  const w = await registerWorker(api, "s7");
  const id = await started(w);
  const dep = await createTask(api, "child-dep", { agentId: w.id, dependsOn: [id] });
  const depBefore = row(db, dep).status;
  stall(db, id, 10);
  check(await reclaimed(id), "not reclaimed");
  await Bun.sleep(2500);
  const depMid = row(db, dep).status;
  check(depMid !== "failed" && depMid !== "cancelled", `dependent ${depMid}`);
  const p = await poll(api, w);
  check(p.json?.trigger?.taskId === id, `repoll ${p.text.slice(0, 100)}`);
  const m = await mcpConnect(sut, w.id, { runtime: w.runtime, sourceTask: id });
  await m.call("store-progress", { taskId: id, status: "completed", output: "ok" });
  await m.close();
  const p2 = await poll(api, w);
  check(p2.json?.trigger?.taskId === dep, `dependent not handed out: ${p2.text.slice(0, 150)}`);
  return `dep: ${depBefore} → ${depMid} → started`;
});

await scenario("S10a pause/cancel during reclaim", async () => {
  const w = await registerWorker(api, "s10");
  const id = await started(w);
  stall(db, id, 10);
  check(await reclaimed(id), "not reclaimed");
  const pr = await api("POST", `/api/tasks/${id}/pause`, { agent: w.id, runtime: w.runtime });
  const cr = await api("POST", `/api/tasks/${id}/cancel`, { body: { reason: "qa" } });
  const r = row(db, id);
  return `pause(pending reclaimed)=${pr.status}; cancel=${cr.status}; final=${r.status}`;
});

await scenario("S12 API restart mid-task: fresh-session task not reclaimed; reclaimed row survives", async () => {
  const w1 = await registerWorker(api, "s12a");
  const live = await started(w1, "live");
  await registerSession(api, w1, live);
  const w2 = await registerWorker(api, "s12b");
  const dead = await started(w2, "dead");
  stall(db, dead, 10);
  check(await reclaimed(dead), "dead not reclaimed");
  db.close();
  await restartSut(sut);
  db = openDb(sut);
  await Bun.sleep(4000);
  const a = row(db, live), b = row(db, dead);
  check(a.status === "in_progress" && a.attempt === 0, `live task disturbed: ${a.status}/${a.attempt}`);
  check(b.status === "pending" && b.attempt === 1, `reclaimed row: ${b.status}/${b.attempt}`);
  return "ok";
});

console.log("\n=== RESULTS ===");
for (const r of results) console.log(`${r.status}\t${r.name}\t${r.detail.slice(0, 300)}`);
await Bun.write("/tmp/hb-e2e-results.json", JSON.stringify({ multi, results, findings }, null, 2));
db.close();
await stopSut(sut, false);
