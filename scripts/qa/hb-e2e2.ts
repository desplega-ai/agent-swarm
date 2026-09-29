/** Batch 2: zombie writes on unfenced surfaces, defer-task/wakeOn, supersede, recover-orphaned, Unpin edges */
import {
  check, createTask, getTask, makeApi, mcpConnect, minutesAgo, openDb, poll, registerSession,
  registerWorker, results, findings, row, rows, scenario, stall, startSut, stopSut, waitFor,
} from "./hb-lib";

const sut = await startSut(true, {}, { MULTI_RUNTIME_ENABLED: "true", HEARTBEAT_INTERVAL_MS: "1000", HEARTBEAT_MAX_AUTO_ASSIGN: "0" });
console.log(`SUT ${sut.baseUrl} db=${sut.dbPath}`);
const api = makeApi(sut);
const db = openDb(sut);

async function started(w: any, text = "work", extra: Record<string, unknown> = {}) {
  const id = await createTask(api, text, { agentId: w.id, ...extra });
  const p = await poll(api, w);
  check(p.json?.trigger?.taskId === id, `poll did not hand out: ${p.text.slice(0, 200)}`);
  return id;
}
const reclaimed = (id: string) => waitFor(() => row(db, id)?.attempt >= 1 && row(db, id)?.status !== "in_progress", 15000);
async function addRuntime(w: any, name: string) {
  const rt = `${name}-${Math.random().toString(36).slice(2, 6)}`;
  await api("POST", "/api/agents", { agent: w.id, runtime: rt, body: { name: w.name, role: "worker", status: "idle", runtimeInstanceId: rt, maxTasks: 1 } });
  return rt;
}

// zombie A (runtime 1) vs replacement B (runtime 2, same agent)
await scenario("U1 zombie A writes on UNFENCED surfaces of B's in_progress row", async () => {
  const w = await registerWorker(api, "u1");
  const rt2 = await addRuntime(w, "u1b");
  const id = await started(w);
  stall(db, id, 10);
  check(await reclaimed(id), "not reclaimed");
  const p = await poll(api, w, rt2);
  check(p.json?.trigger?.taskId === id, "B did not start");
  // B writes its state
  await api("POST", `/api/tasks/${id}/progress`, { agent: w.id, runtime: rt2, body: { progress: "B-progress" } });
  await api("PUT", `/api/tasks/${id}/session`, { agent: w.id, runtime: rt2, body: { claudeSessionId: "B-SESSION", provider: "claude" } });
  const out: string[] = [];
  // A (old runtime) now writes
  const a1 = await api("POST", `/api/tasks/${id}/progress`, { agent: w.id, runtime: w.runtime, body: { progress: "A-zombie-progress" } });
  out.push(`progress:${a1.status}→${row(db, id).progress}`);
  const a2 = await api("PUT", `/api/tasks/${id}/session`, { agent: w.id, runtime: w.runtime, body: { claudeSessionId: "A-SESSION", provider: "claude" } });
  out.push(`session:${a2.status}→${row(db, id).claudeSessionId}`);
  const a3 = await api("PUT", `/api/tasks/${id}/vcs`, { agent: w.id, runtime: w.runtime, body: { vcsRepo: "zombie/repo", vcsNumber: 1 } });
  out.push(`vcs:${a3.status}→${row(db, id).vcsRepo}`);
  const m = await mcpConnect(sut, w.id, { runtime: w.runtime, sourceTask: id });
  const sp = await m.call("store-progress", { taskId: id, progress: "A-mcp-progress" });
  out.push(`mcp-progress:${sp.data?.success}→${row(db, id).progress}`);
  const dt = await m.call("defer-task", { taskId: id, summary: "zombie", note: "n", delayMs: 60000 });
  out.push(`defer:${dt.data?.success ?? dt.isError}→${row(db, id).status}`);
  const rel = await m.call("task-action", { action: "release", taskId: id });
  out.push(`release:${rel.data?.success}→${row(db, id).status}`);
  await m.close();
  const fin = await api("POST", `/api/tasks/${id}/finish`, { agent: w.id, runtime: w.runtime, body: { status: "completed", output: "ZOMBIE" } });
  out.push(`finish:${fin.status}→${row(db, id).status}`);
  const sup = await api("POST", `/api/tasks/${id}/supersede`, { agent: w.id, runtime: w.runtime, body: { reason: "graceful_shutdown" } });
  out.push(`supersede:${sup.status}→${row(db, id).status}`);
  const pz = await api("POST", `/api/tasks/${id}/pause`, { agent: w.id, runtime: w.runtime });
  out.push(`pause:${pz.status}→${row(db, id).status}`);
  const s = await api("POST", "/api/active-sessions", { agent: w.id, runtime: w.runtime, body: { agentId: w.id, taskId: id, triggerType: "task_assigned", runtimeInstanceId: w.runtime } });
  out.push(`session-create:${s.status}`);
  console.log("   U1:", out.join(" | "));
  return out.join(" | ");
});

await scenario("U2 stale defer-task after reclaim (pending row) — must not complete or schedule", async () => {
  const w = await registerWorker(api, "u2");
  const id = await started(w);
  stall(db, id, 10);
  check(await reclaimed(id), "not reclaimed");
  const before = rows(db, "select count(*) n from scheduled_tasks")[0].n;
  const m = await mcpConnect(sut, w.id, { runtime: w.runtime, sourceTask: id });
  const dt = await m.call("defer-task", { taskId: id, summary: "STALE", note: "n", delayMs: 60000 });
  await m.close();
  const after = rows(db, "select count(*) n from scheduled_tasks")[0].n;
  check(/reclaimed|another runtime/.test(dt.text) && row(db, id).status === "pending" && before === after, `status=${row(db, id).status} schedules ${before}->${after} :: ${dt.text.slice(0, 200)}`);
  return dt.text.slice(0, 120);
});

await scenario("U3 defer-task wakeOn member reclaimed then completes: waiter wakes exactly once", async () => {
  const wm = await registerWorker(api, "u3m");
  const ww = await registerWorker(api, "u3w");
  const member = await started(wm, "member");
  const waiter = await started(ww, "waiter");
  const m = await mcpConnect(sut, ww.id, { runtime: ww.runtime, sourceTask: waiter });
  const dt = await m.call("defer-task", { taskId: waiter, summary: "wait for member", note: "n", wakeOn: { event: "settled", taskIds: [member], mode: "all" }, delayMs: 3600000 });
  await m.close();
  check(!dt.isError, `defer failed: ${dt.text.slice(0, 300)}`);
  stall(db, member, 10);
  check(await reclaimed(member), "member not reclaimed");
  await Bun.sleep(2500);
  const woke1 = rows(db, "select count(*) n from agent_tasks where parentTaskId = ? or id != ? and task like '%wait for member%'", waiter, waiter)[0].n;
  const p = await poll(api, wm);
  check(p.json?.trigger?.taskId === member, "member not restarted");
  const mm = await mcpConnect(sut, wm.id, { runtime: wm.runtime, sourceTask: member });
  await mm.call("store-progress", { taskId: member, status: "completed", output: "member done" });
  await mm.close();
  await Bun.sleep(4000);
  const all = rows(db, "select id, status, taskType, parentTaskId, agentId, substr(task,1,60) t from agent_tasks where id not in (?,?)", member, waiter);
  return `waiter=${row(db, waiter).status}; extra rows: ${JSON.stringify(all.map((r) => [r.status, r.taskType, r.t]))}; pre-wake extras=${woke1}`;
});

await scenario("U4 supersede (graceful_shutdown) atomic: superseded + resume child + dependents", async () => {
  const w = await registerWorker(api, "u4");
  const id = await started(w);
  const dep = await createTask(api, "dep-of-superseded", { agentId: w.id, dependsOn: [id] });
  const r = await api("POST", `/api/tasks/${id}/supersede`, { agent: w.id, runtime: w.runtime, body: { reason: "graceful_shutdown" } });
  check(r.status === 200, `supersede ${r.status} ${r.text.slice(0, 200)}`);
  const child = r.json.resumeTaskId;
  await Bun.sleep(3000);
  const d = row(db, dep);
  return `status=${row(db, id).status} resumeChild=${child ? row(db, child).status + "/" + row(db, child).taskType : "none"} dependent=${d.status}`;
});

await scenario("U5 superseded-without-resume (crash between old non-atomic writes) is never repaired", async () => {
  const w = await registerWorker(api, "u5");
  const id = await started(w);
  db.run("UPDATE agent_tasks SET status='superseded', lastUpdatedAt=? WHERE id=?", [minutesAgo(30), id]);
  await Bun.sleep(4000);
  const kids = rows(db, "select id from agent_tasks where parentTaskId = ?", id);
  check(kids.length === 0, "repaired");
  return `still superseded=${row(db, id).status === "superseded"}, children=${kids.length} (no repair sweep)`;
});

await scenario("U6 recover-orphaned (worker boot) on a sibling runtime's live task", async () => {
  const w = await registerWorker(api, "u6");
  const rt2 = await addRuntime(w, "u6b");
  const id = await started(w); // R1 running, no session row yet
  db.run("UPDATE agent_tasks SET lastUpdatedAt=? WHERE id=?", [minutesAgo(3), id]);
  const r = await api("POST", "/api/active-sessions/recover-orphaned-tasks", { agent: w.id, runtime: rt2, body: { agentId: w.id } });
  const t = row(db, id);
  return `recover=${r.status} ${r.text.slice(0, 80)} → status=${t.status} attempt=${t.attempt} stamp=${t.attemptRuntimeId === w.runtime ? "R1(stale)" : t.attemptRuntimeId}`;
});

await scenario("U7 reclaimed pending row pinned to a BUSY agent is unpinned after grace (agent alive, at capacity)", async () => {
  const w = await registerWorker(api, "u7");
  const other = await registerWorker(api, "u7o");
  const id = await started(w, "first");
  stall(db, id, 10);
  check(await reclaimed(id), "not reclaimed");
  // agent immediately picks up a second directly-assigned task and stays busy > grace
  const busy = await createTask(api, "busy-work", { agentId: w.id });
  db.run("UPDATE agent_tasks SET status='in_progress', attemptRuntimeId=? WHERE id=?", [w.runtime, busy]);
  await registerSession(api, w, busy);
  db.run("UPDATE agent_tasks SET lastUpdatedAt=? WHERE id=?", [minutesAgo(11), id]);
  await Bun.sleep(3500);
  const t = row(db, id);
  return `reclaimed row after 11m behind busy agent: status=${t.status} agent=${t.agentId === w.id ? "w(pinned)" : t.agentId}`;
});

console.log("\n=== RESULTS ===");
for (const r of results) console.log(`${r.status}\t${r.name}\t${r.detail.slice(0, 400)}`);
await Bun.write("/tmp/hb-e2e2-results.json", JSON.stringify({ results, findings }, null, 2));
db.close();
await stopSut(sut, false);
