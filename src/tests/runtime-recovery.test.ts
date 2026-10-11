import { expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import WebSocket from "ws";
import {
  completeTask,
  createTaskExtended,
  getActiveSessionForTask,
  getAgentById,
  getChildTasks,
  getDbClient,
  getTaskById,
  startTask,
  updateTaskProgress,
} from "../be/db";
import {
  getRuntimeInstanceById,
  listRuntimeInstancesForPool,
  upsertRuntimeInstance,
} from "../be/multi-runtime";
import * as recovery from "../be/runtime-pools/recovery";
import {
  checkDisconnectedRuntime,
  recoverRuntime,
  startRuntimeRecovery,
} from "../be/runtime-pools/recovery";
import { reapPoolRuntimes, reconcileOnce } from "../be/runtime-pools/supervisor";
import { mintSessionToken, resolveBySessionToken } from "../be/users";
import * as dispatcher from "../extensions/dispatcher";
import * as heartbeat from "../heartbeat/heartbeat";
import { codeLevelTriage, setBeforeHeartbeatSupersedeForTests } from "../heartbeat/heartbeat";
import { resolveHttpRequestAuth } from "../http/auth";
import { handlePoll } from "../http/poll";
import { realtimeBus } from "../realtime/bus";
import { attachRealtimeTransport } from "../realtime/transport";
import { runtimeFailureFixture } from "./runtime-pools-test-utils";
import { listenOnFreePort } from "./test-net";

const { state, setup } = runtimeFailureFixture("./test-runtime-recovery.sqlite");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function stall(taskId: string) {
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [old, taskId]);
  await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
    old,
    taskId,
  ]);
}

async function running(options: Partial<Parameters<typeof setup>[0]> = {}, tags?: string[]) {
  const { pool, agent, task } = await setup(options);
  if (tags)
    await getDbClient().run("UPDATE agent_tasks SET tags = ? WHERE id = ?", [
      JSON.stringify(tags),
      task.id,
    ]);
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  await startTask(task.id);
  await getDbClient().run(
    "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
    [crypto.randomUUID(), agent.id, task.id, runtime.id],
  );
  return { pool, agent, task, runtime, token: state.fake.requests[0]!.env.API_KEY! };
}

async function assertRecovered(taskId: string, runtimeId: string, agentId: string, token: string) {
  expect((await getRuntimeInstanceById(runtimeId))?.status).toBe("offline");
  expect((await getTaskById(taskId))?.status).toBe("superseded");
  expect(await getActiveSessionForTask(taskId)).toBeNull();
  expect(await resolveBySessionToken(token)).toBeNull();
  expect((await getAgentById(agentId))?.status).toBe("offline");
  const resume = await getDbClient().get<{ id: string; agentId: string; status: string }>(
    "SELECT id, agentId, status FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'resume'",
    [taskId],
  );
  expect(resume?.agentId).toBe(agentId);
  expect(resume?.status).toBe("pending");
  return resume!;
}

test.each([
  1, 2,
])("provider death before session POST recovers every dispatched task with %s slots", async (slots) => {
  const { pool, agent, task } = await setup({ slotsPerRuntime: slots, maxRuntimes: 1 }, slots);
  const tasks = [task];
  for (let n = 1; n < slots; n++)
    tasks.push(await createTaskExtended("Additional slot", { agentId: agent.id }));
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  const token = state.fake.requests[0]!.env.API_KEY!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: slots });
  const server = createServer((req, res) => {
    void handlePoll(req, res, ["api", "poll"], new URLSearchParams(), agent.id).catch(() => {
      res.writeHead(500).end();
    });
  });
  const port = await listenOnFreePort(server);
  try {
    for (let n = 0; n < slots; n++) {
      const response = await fetch(`http://localhost:${port}/api/poll`, {
        headers: { "X-Runtime-Instance-ID": runtime.id },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { trigger: { taskId: string } };
      expect(tasks.map((t) => t.id)).toContain(body.trigger.taskId);
      expect((await getRuntimeInstanceById(runtime.id))?.taskId).toBe(body.trigger.taskId);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dispatched of tasks) {
    expect((await getTaskById(dispatched.id))?.status).toBe("in_progress");
    expect(await getActiveSessionForTask(dispatched.id)).toBeNull();
  }
  state.fake.runtimes.clear();
  await reconcileOnce();
  for (const dispatched of tasks) await assertRecovered(dispatched.id, runtime.id, agent.id, token);
  await Promise.all([
    recoverRuntime(runtime.id, "Repeated death"),
    recoverRuntime(runtime.id, "Repeated death"),
  ]);
  for (const dispatched of tasks)
    expect(
      (await getChildTasks(dispatched.id)).filter((t) => t.taskType === "resume"),
    ).toHaveLength(1);
});

test("runtime task fallback recovers without a session and preserves concurrent completion", async () => {
  const { task, runtime } = await running();
  await getDbClient().run("DELETE FROM active_sessions WHERE taskId = ?", [task.id]);
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    task.id,
    runtime.id,
  ]);
  let attempted = false;
  setBeforeHeartbeatSupersedeForTests(async () => {
    attempted = true;
    await completeTask(task.id, "Finished before remediation");
  });
  try {
    await recoverRuntime(runtime.id, "Provider disappeared");
    expect(attempted).toBe(true);
    expect((await getTaskById(task.id))?.status).toBe("completed");
    expect(await getChildTasks(task.id)).toHaveLength(0);
  } finally {
    setBeforeHeartbeatSupersedeForTests(null);
  }
});

test("runtime task fallback creates one resume without a dispatch column or session", async () => {
  const { agent, task, runtime, token } = await running();
  await getDbClient().run("DELETE FROM active_sessions WHERE taskId = ?", [task.id]);
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    task.id,
    runtime.id,
  ]);
  await recoverRuntime(runtime.id, "Provider disappeared");
  await assertRecovered(task.id, runtime.id, agent.id, token);
  await recoverRuntime(runtime.id, "Repeated check");
  expect((await getChildTasks(task.id)).filter((t) => t.taskType === "resume")).toHaveLength(1);
});

test("dispatch recovery preserves a task registered on a surviving runtime", async () => {
  const { agent, task, runtime } = await running();
  const survivingId = crypto.randomUUID();
  await upsertRuntimeInstance({ id: survivingId, agentId: agent.id, reportedSlots: 1 });
  await getDbClient().run("UPDATE agent_tasks SET runtime_instance_id = ? WHERE id = ?", [
    runtime.id,
    task.id,
  ]);
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    task.id,
    runtime.id,
  ]);
  await getDbClient().run("UPDATE active_sessions SET runtimeInstanceId = ? WHERE taskId = ?", [
    survivingId,
    task.id,
  ]);
  await recoverRuntime(runtime.id, "Provider disappeared");
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  expect((await getActiveSessionForTask(task.id))?.runtimeInstanceId).toBe(survivingId);
  expect(await getChildTasks(task.id)).toHaveLength(0);
});

test("sessionless dispatch recovery is disabled with runtime pools off", async () => {
  const { task, runtime } = await running();
  await getDbClient().run("DELETE FROM active_sessions WHERE taskId = ?", [task.id]);
  await getDbClient().run("UPDATE agent_tasks SET runtime_instance_id = ? WHERE id = ?", [
    runtime.id,
    task.id,
  ]);
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    task.id,
    runtime.id,
  ]);
  process.env.RUNTIME_POOLS_ENABLED = "false";
  await recoverRuntime(runtime.id, "Provider disappeared");
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  expect(await getChildTasks(task.id)).toHaveLength(0);
});

for (const status of ["exited", "failed"] as const) {
  test(`provider ${status} fences the runtime and creates one pinned resume before replacement`, async () => {
    const { pool, agent, task, runtime, token } = await running();
    state.fake.runtimes.get(runtime.externalHandle!.externalId)!.status = status;
    await reconcileOnce();
    await assertRecovered(task.id, runtime.id, agent.id, token);
    expect(state.fake.requests).toHaveLength(2);
    expect(state.fake.requests[1]!.agentId).toBe(agent.id);
    const newRuntime = (await listRuntimeInstancesForPool(pool.id)).find(
      (r) => r.status === "provisioning",
    )!;
    expect(newRuntime.id).not.toBe(runtime.id);
    await Promise.all([
      recoverRuntime(runtime.id, "Repeated check"),
      recoverRuntime(runtime.id, "Repeated check"),
    ]);
    const count = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'resume'",
      [task.id],
    );
    expect(count?.n).toBe(1);
  });
}

test.each([
  "exited",
  "stale",
])("%s runtime with only a completed session recovers without task remediation", async (status) => {
  const { task, runtime, token } = await running();
  await completeTask(task.id, "done");
  expect(await getActiveSessionForTask(task.id)).not.toBeNull();
  if (status === "exited") {
    state.fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "exited";
  } else {
    await getDbClient().run("UPDATE runtime_instances SET last_seen_at = ? WHERE id = ?", [
      new Date(Date.now() - 6 * 60_000).toISOString(),
      runtime.id,
    ]);
  }
  const recover = spyOn(recovery, "recoverRuntime");
  const remediate = spyOn(heartbeat, "remediateTaskForDeadRuntime");
  try {
    await reconcileOnce();
    expect(recover).toHaveBeenCalledWith(runtime.id, expect.any(String));
    expect(remediate).not.toHaveBeenCalled();
    expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
    expect(await resolveBySessionToken(token)).toBeNull();
    expect(await getActiveSessionForTask(task.id)).toBeNull();
    expect((await getTaskById(task.id))?.status).toBe("completed");
    expect(await getChildTasks(task.id)).toHaveLength(0);
    expect(state.fake.terminated).toEqual([runtime.externalHandle!.externalId]);
    expect(state.fake.requests).toHaveLength(1);
  } finally {
    recover.mockRestore();
    remediate.mockRestore();
  }
});

test("absence from an owner-filtered list recovers a runtime even when status says running", async () => {
  const { agent, task, runtime, token } = await running();
  state.fake.listed = false;
  await reconcileOnce();
  await assertRecovered(task.id, runtime.id, agent.id, token);
});

test("provider status and list errors do not recover a fresh runtime", async () => {
  const { task, runtime, token } = await running();
  const status = spyOn(state.fake, "status").mockRejectedValue(new Error("Provider unavailable"));
  const list = spyOn(state.fake, "list").mockRejectedValue(new Error("Provider unavailable"));
  try {
    await reconcileOnce();
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
    expect(await resolveBySessionToken(token)).not.toBeNull();
    expect(state.fake.terminated).toHaveLength(0);
  } finally {
    status.mockRestore();
    list.mockRestore();
  }
});

test("one provider batch checks active siblings and preserves the surviving runtime", async () => {
  const { pool, agent, task, runtime } = await running();
  await createTaskExtended("More work", { agentId: agent.id });
  await reconcileOnce();
  const sibling = (await listRuntimeInstancesForPool(pool.id)).find((r) => r.id !== runtime.id)!;
  await upsertRuntimeInstance({ id: sibling.id, agentId: agent.id, reportedSlots: 1 });
  state.fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "failed";
  state.fake.statusCalls = [];
  await reconcileOnce();
  expect(state.fake.statusCalls).toHaveLength(1);
  expect(state.fake.statusCalls[0]).toHaveLength(2);
  expect((await getRuntimeInstanceById(sibling.id))?.status).toBe("active");
  expect((await getAgentById(agent.id))?.status).not.toBe("offline");
  expect((await getTaskById(task.id))?.status).toBe("superseded");
});

test("revocation rejects runtime and child task tokens with HTTP 401", async () => {
  const { agent, task, runtime, token } = await running();
  const parent = await resolveBySessionToken(token);
  const child = await mintSessionToken(agent.id, task.id, 60_000, {
    tokenId: parent!.tokenId,
    runtimeId: runtime.id,
  });
  const server = createServer((req, res) => {
    void resolveHttpRequestAuth(req, undefined).then((auth) => {
      res.writeHead(auth ? 200 : 401);
      res.end();
    });
  });
  const port = await listenOnFreePort(server);
  try {
    expect(
      (
        await fetch(`http://localhost:${port}/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    await recoverRuntime(runtime.id, "Container disappeared");
    for (const credential of [token, child.plaintext]) {
      expect(
        (
          await fetch(`http://localhost:${port}/me`, {
            headers: { Authorization: `Bearer ${credential}` },
          })
        ).status,
      ).toBe(401);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runtime death uses the existing generation cap", async () => {
  const { agent, task, runtime, token } = await running({}, ["resume-generation:3"]);
  await recoverRuntime(runtime.id, "OOM");
  expect((await getTaskById(task.id))?.status).toBe("failed");
  expect((await getTaskById(task.id))?.failureReason).toBe("resume_budget_exhausted");
  expect(await getActiveSessionForTask(task.id)).toBeNull();
  expect((await getAgentById(agent.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(token)).toBeNull();
});

test("socket disconnect checks after grace and preserves a running provider runtime", async () => {
  const { agent, task, runtime, token } = await running({ delivery: "push" });
  startRuntimeRecovery();
  process.env.RUNTIME_SOCKET_GRACE_SEC = "0";
  state.fake.statusCalls = [];
  realtimeBus.publish("worker.socket.disconnected", { agentId: agent.id, runtimeId: runtime.id });
  expect(state.fake.statusCalls).toHaveLength(0);
  for (let n = 0; n < 100 && state.fake.statusCalls.length === 0; n++) await Bun.sleep(5);
  expect(state.fake.statusCalls).toHaveLength(1);
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect(await resolveBySessionToken(token)).not.toBeNull();
});

test("socket disconnect recovers a gone provider runtime", async () => {
  const { agent, task, runtime, token } = await running({ delivery: "push" });
  startRuntimeRecovery();
  process.env.RUNTIME_SOCKET_GRACE_SEC = "0";
  state.fake.runtimes.clear();
  realtimeBus.publish("worker.socket.disconnected", { agentId: agent.id, runtimeId: runtime.id });
  for (let n = 0; n < 100 && (await getActiveSessionForTask(task.id)); n++) await Bun.sleep(5);
  await assertRecovered(task.id, runtime.id, agent.id, token);
});

test("a real worker socket disconnect reaches runtime recovery with its token identity", async () => {
  const { agent, task, runtime, token } = await running({ delivery: "push" });
  process.env.RUNTIME_SOCKET_GRACE_SEC = "0";
  startRuntimeRecovery();
  const server = createServer();
  const detach = attachRealtimeTransport(server);
  const port = await listenOnFreePort(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  try {
    const subscribed = new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (typeof frame.seq === "number") ws.send(JSON.stringify({ ack: frame.seq }));
        if (frame.id === 1) {
          if (frame.type === "error") reject(new Error(frame.error));
          else resolve();
        }
      });
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            id: 1,
            op: "subscribe",
            namespace: `worker:${agent.id}`,
            name: "nudge",
          }),
        );
      });
    });
    await subscribed;
    state.fake.runtimes.clear();
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close();
    await closed;
    for (let n = 0; n < 100 && (await getActiveSessionForTask(task.id)); n++) await Bun.sleep(5);
    await assertRecovered(task.id, runtime.id, agent.id, token);
  } finally {
    ws.terminate();
    detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reconnection or another connected socket cancels a grace check", async () => {
  const { agent, runtime } = await running({ delivery: "push" });
  startRuntimeRecovery();
  const timer = setTimeout(() => {}, 60_000);
  const schedule = spyOn(globalThis, "setTimeout").mockReturnValue(timer);
  const cancel = spyOn(globalThis, "clearTimeout");
  const event = { agentId: agent.id, runtimeId: runtime.id };
  try {
    realtimeBus.publish("worker.socket.disconnected", event);
    expect(schedule).toHaveBeenCalledTimes(1);
    realtimeBus.publish("worker.socket.connected", event);
    expect(cancel).toHaveBeenCalledWith(timer);
    realtimeBus.publish("worker.socket.connected", event);
    realtimeBus.publish("worker.socket.disconnected", event);
    expect(schedule).toHaveBeenCalledTimes(1);
    realtimeBus.publish("worker.socket.disconnected", event);
    expect(schedule).toHaveBeenCalledTimes(2);
  } finally {
    schedule.mockRestore();
    cancel.mockRestore();
    clearTimeout(timer);
  }
});

test("socket counts remain symmetric while runtime pools are disabled", async () => {
  const { agent, runtime } = await running({ delivery: "push" });
  startRuntimeRecovery();
  const timer = setTimeout(() => {}, 60_000);
  const schedule = spyOn(globalThis, "setTimeout").mockReturnValue(timer);
  const event = { agentId: agent.id, runtimeId: runtime.id };
  try {
    process.env.RUNTIME_POOLS_ENABLED = "false";
    realtimeBus.publish("worker.socket.connected", event);
    realtimeBus.publish("worker.socket.disconnected", event);
    expect(schedule).not.toHaveBeenCalled();
    process.env.RUNTIME_POOLS_ENABLED = "true";
    realtimeBus.publish("worker.socket.connected", event);
    realtimeBus.publish("worker.socket.disconnected", event);
    expect(schedule).toHaveBeenCalledTimes(1);
  } finally {
    schedule.mockRestore();
    clearTimeout(timer);
  }
});

test("socket checks ignore poll pools and disabled feature flags", async () => {
  const { runtime, task } = await running({ delivery: "poll" });
  state.fake.runtimes.clear();
  await checkDisconnectedRuntime(runtime.id);
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  process.env.RUNTIME_POOLS_ENABLED = "false";
  await checkDisconnectedRuntime(runtime.id);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
});

test("idle token rotation drains before termination and replacement", async () => {
  const { pool, agent } = await setup({ maxRuntimes: 1 });
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  const token = state.fake.requests[0]!.env.API_KEY!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  await getDbClient().run("UPDATE session_tokens SET expiresAt = ? WHERE runtimeId = ?", [
    new Date(Date.now() + 30 * 60_000).toISOString(),
    runtime.id,
  ]);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  expect(await resolveBySessionToken(token)).not.toBeNull();
  expect(state.fake.terminated).toHaveLength(0);
  expect(state.fake.requests).toHaveLength(1);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(token)).toBeNull();
  expect(state.fake.requests).toHaveLength(2);
});

test("rotation preserves a task claimed between the idle read and draining", async () => {
  const { pool, agent, task } = await setup({ maxRuntimes: 1 });
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  await getDbClient().run("UPDATE session_tokens SET expiresAt = ? WHERE runtimeId = ?", [
    new Date(Date.now() + 30 * 60_000).toISOString(),
    runtime.id,
  ]);
  const client = getDbClient();
  const original = client.get.bind(client);
  let claimed = false;
  const read = spyOn(client, "get").mockImplementation(async (sql, params) => {
    const row = await original(sql, params);
    if (!claimed && sql.startsWith("SELECT s.taskId FROM active_sessions")) {
      claimed = true;
      await startTask(task.id);
      await client.run(
        "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
        [crypto.randomUUID(), agent.id, task.id, runtime.id],
      );
    }
    return row;
  });
  try {
    await reapPoolRuntimes(
      pool,
      [(await getRuntimeInstanceById(runtime.id))!],
      state.fake,
      new Date(),
    );
  } finally {
    read.mockRestore();
  }
  expect(claimed).toBe(true);
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  await reconcileOnce();
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect(state.fake.terminated).toHaveLength(0);
});

test("busy token rotation drains persistently, provisions a replacement, then terminates when idle", async () => {
  const { agent, task, runtime, token } = await running({ maxRuntimes: 2 });
  await createTaskExtended("Next work", { agentId: agent.id });
  await getDbClient().run("UPDATE session_tokens SET expiresAt = ? WHERE runtimeId = ?", [
    new Date(Date.now() + 30 * 60_000).toISOString(),
    runtime.id,
  ]);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  expect(await resolveBySessionToken(token)).not.toBeNull();
  expect(state.fake.requests).toHaveLength(2);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  expect(state.fake.requests).toHaveLength(2);
  await completeTask(task.id, "Done");
  await getDbClient().run("DELETE FROM active_sessions WHERE taskId = ?", [task.id]);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(token)).toBeNull();
});

test("busy token rotation keeps the physical pool cap", async () => {
  const { agent, runtime } = await running({ maxRuntimes: 1 });
  await createTaskExtended("Next work", { agentId: agent.id });
  await getDbClient().run("UPDATE session_tokens SET expiresAt = ? WHERE runtimeId = ?", [
    new Date(Date.now() + 30 * 60_000).toISOString(),
    runtime.id,
  ]);
  await reconcileOnce();
  expect((await getRuntimeInstanceById(runtime.id))?.draining).toBe(true);
  expect(state.fake.requests).toHaveLength(1);
});

test("stalled pooled sessions terminate their runtime and recover sibling tasks", async () => {
  const { agent, task, runtime } = await running();
  const sibling = await createTaskExtended("Sibling task", { agentId: agent.id });
  await startTask(sibling.id);
  await getDbClient().run(
    "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
    [crypto.randomUUID(), agent.id, sibling.id, runtime.id],
  );
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [old, task.id]);
  await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
    old,
    task.id,
  ]);
  await codeLevelTriage();
  expect(state.fake.terminated).toContain(runtime.externalHandle!.externalId);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect((await getTaskById(task.id))?.status).toBe("superseded");
  expect((await getTaskById(sibling.id))?.status).toBe("superseded");
  expect(await getActiveSessionForTask(sibling.id)).toBeNull();
});

test("progress after a pooled stall read cancels remediation and fencing", async () => {
  const { task, runtime, token } = await running();
  await stall(task.id);
  setBeforeHeartbeatSupersedeForTests(async (candidate) => {
    await updateTaskProgress(candidate.id, "Still working");
  });
  try {
    await codeLevelTriage();
    await reconcileOnce();
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
    expect(await resolveBySessionToken(token)).not.toBeNull();
    expect(await getActiveSessionForTask(task.id)).not.toBeNull();
    expect(await getChildTasks(task.id)).toHaveLength(0);
    expect(state.fake.terminated).toHaveLength(0);
  } finally {
    setBeforeHeartbeatSupersedeForTests(null);
  }
});

test("an extension-selected fail survives concurrent supervisor recovery after the heartbeat fences", async () => {
  const { task, runtime, token } = await running();
  await stall(task.id);
  const hook = spyOn(dispatcher, "dispatchPre").mockResolvedValue({
    action: "modify",
    data: { proposedAction: "fail" },
  });
  const entered = deferred();
  const release = deferred();
  const requested = deferred();
  const originalTerminate = state.fake.terminate.bind(state.fake);
  let blocked = false;
  const terminate = spyOn(state.fake, "terminate").mockImplementation(async (handle) => {
    if (!blocked) {
      blocked = true;
      entered.resolve();
      await release.promise;
    }
    await originalTerminate(handle);
  });
  const originalSerialize = recovery.serializeRuntimeAction;
  const serialize = spyOn(recovery, "serializeRuntimeAction").mockImplementation(
    async (id, action) => {
      if (id === runtime.id) requested.resolve();
      await originalSerialize(id, action);
    },
  );
  const triage = codeLevelTriage();
  let tick: Promise<void> | undefined;
  try {
    await entered.promise;
    expect((await getTaskById(task.id))?.status).toBe("failed");
    expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
    expect(await resolveBySessionToken(token)).toBeNull();
    tick = reconcileOnce();
    await requested.promise;
    release.resolve();
    await Promise.all([triage, tick]);
    expect((await getTaskById(task.id))?.status).toBe("failed");
    expect(await getChildTasks(task.id)).toHaveLength(0);
    expect(await getActiveSessionForTask(task.id)).toBeNull();
  } finally {
    release.resolve();
    await Promise.allSettled([triage, tick]);
    hook.mockRestore();
    terminate.mockRestore();
    serialize.mockRestore();
  }
});

test("provider recovery that starts first completes before an extension-selected fail", async () => {
  const { task, runtime } = await running();
  await stall(task.id);
  const entered = deferred();
  const release = deferred();
  const selected = deferred();
  setBeforeHeartbeatSupersedeForTests(async () => {
    entered.resolve();
    await release.promise;
  });
  const hook = spyOn(dispatcher, "dispatchPre").mockImplementation(async () => {
    selected.resolve();
    return { action: "modify", data: { proposedAction: "fail" } };
  });
  state.fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "failed";
  const tick = reconcileOnce();
  let triage: ReturnType<typeof codeLevelTriage> | undefined;
  try {
    await entered.promise;
    triage = codeLevelTriage();
    await selected.promise;
    release.resolve();
    await Promise.all([tick, triage]);
    expect((await getTaskById(task.id))?.status).toBe("superseded");
    const children = await getChildTasks(task.id);
    expect(children.filter((child) => child.taskType === "resume")).toHaveLength(1);
    expect(await getActiveSessionForTask(task.id)).toBeNull();
  } finally {
    release.resolve();
    await Promise.allSettled([tick, triage]);
    setBeforeHeartbeatSupersedeForTests(null);
    hook.mockRestore();
  }
});

test("one throwing session remediation does not block its sibling", async () => {
  const { agent, task, runtime } = await running();
  const sibling = await createTaskExtended("Sibling task", { agentId: agent.id });
  await startTask(sibling.id);
  await getDbClient().run(
    "INSERT INTO active_sessions (id, agentId, taskId, triggerType, runtimeInstanceId) VALUES (?, ?, ?, 'task_assigned', ?)",
    [crypto.randomUUID(), agent.id, sibling.id, runtime.id],
  );
  const original = heartbeat.remediateTaskForDeadRuntime;
  const secret = `aseph_${"A".repeat(32)}`;
  const errors = spyOn(console, "error");
  const remediate = spyOn(heartbeat, "remediateTaskForDeadRuntime").mockImplementation(
    async (candidate, reason) => {
      if (candidate.id === task.id) throw new Error(`Remediation failed: ${secret}`);
      await original(candidate, reason);
    },
  );
  try {
    await recoverRuntime(runtime.id, "Container disappeared");
    expect((await getTaskById(sibling.id))?.status).toBe("superseded");
    expect(await getActiveSessionForTask(sibling.id)).toBeNull();
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain(secret);
  } finally {
    remediate.mockRestore();
    errors.mockRestore();
  }
  await recoverRuntime(runtime.id, "Retry failed session recovery");
  expect((await getTaskById(task.id))?.status).toBe("superseded");
});

test("paused provider runtimes retain their task", async () => {
  const { task, runtime } = await running();
  state.fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
  await reconcileOnce();
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  expect(state.fake.terminated).toHaveLength(0);
});
