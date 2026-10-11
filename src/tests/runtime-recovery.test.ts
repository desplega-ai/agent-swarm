import { expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import {
  completeTask,
  createTaskExtended,
  getActiveSessionForTask,
  getAgentById,
  getDbClient,
  getTaskById,
  startTask,
} from "../be/db";
import {
  getRuntimeInstanceById,
  listRuntimeInstancesForPool,
  upsertRuntimeInstance,
} from "../be/multi-runtime";
import {
  checkDisconnectedRuntime,
  recoverRuntime,
  startRuntimeRecovery,
} from "../be/runtime-pools/recovery";
import { reconcileOnce } from "../be/runtime-pools/supervisor";
import { mintSessionToken, resolveBySessionToken } from "../be/users";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import { resolveHttpRequestAuth } from "../http/auth";
import { realtimeBus } from "../realtime/bus";
import { runtimeFailureFixture } from "./runtime-pools-test-utils";
import { listenOnFreePort } from "./test-net";

const { state, setup } = runtimeFailureFixture("./test-runtime-recovery.sqlite");

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

test("reconnection or another connected socket cancels a grace check", async () => {
  const { agent, runtime } = await running({ delivery: "push" });
  startRuntimeRecovery();
  process.env.RUNTIME_SOCKET_GRACE_SEC = "0";
  state.fake.statusCalls = [];
  const event = { agentId: agent.id, runtimeId: runtime.id };
  realtimeBus.publish("worker.socket.disconnected", event);
  realtimeBus.publish("worker.socket.connected", event);
  await Bun.sleep(15);
  expect(state.fake.statusCalls).toHaveLength(0);
  realtimeBus.publish("worker.socket.connected", event);
  realtimeBus.publish("worker.socket.disconnected", event);
  await Bun.sleep(15);
  expect(state.fake.statusCalls).toHaveLength(0);
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

test("idle token rotation terminates the old runtime and provisions demand", async () => {
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
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("offline");
  expect(await resolveBySessionToken(token)).toBeNull();
  expect(state.fake.requests).toHaveLength(2);
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

test("paused provider runtimes retain their task", async () => {
  const { task, runtime } = await running();
  state.fake.runtimes.get(runtime.externalHandle!.externalId)!.status = "paused";
  await reconcileOnce();
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  expect(state.fake.terminated).toHaveLength(0);
});
