import { expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { completeTask, getAgentById, getDbClient, getTaskById, startTask } from "../be/db";
import {
  getRuntimeInstanceById,
  listRuntimeInstancesForPool,
  upsertRuntimeInstance,
} from "../be/multi-runtime";
import {
  bindAgentToPool,
  createRuntimeController,
  deleteRuntimePool,
  getRuntimePool,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import { reconcileOnce } from "../be/runtime-pools/supervisor";
import { handleActiveSessions } from "../http/active-sessions";
import type { ProvisionRequest, RuntimeHandle } from "../runtime-providers";
import { FailureTestController, runtimeFailureFixture } from "./runtime-pools-test-utils";

const { state, setup } = runtimeFailureFixture("./test-runtime-pools-ownership-guards.sqlite");

test("persisted runtimes use their recorded controller after a legacy placement change", async () => {
  const { pool, agent, task } = await setup({ idleMinutes: null, maxRuntimes: 1 });
  const otherId = (await createRuntimeController({ name: "other", kind: "docker" })).id;
  const other = new FailureTestController();
  const commands = async (id: string) => (id === state.controllerId ? state.fake : other);
  await reconcileOnce({ getControllerCommands: commands });
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  await startTask(task.id);
  await getDbClient().run("UPDATE runtime_instances SET task_id = ? WHERE id = ?", [
    task.id,
    runtime.id,
  ]);
  // Reproduce a placement persisted before the mutation guard existed.
  await getDbClient().run("UPDATE runtime_pools SET placements = ? WHERE id = ?", [
    JSON.stringify([otherId]),
    pool.id,
  ]);
  await reconcileOnce({ getControllerCommands: commands });
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  expect(state.fake.statusCalls.at(-1)?.[0]?.externalId).toBe(runtime.externalHandle!.externalId);
  expect(other.statusCalls).toHaveLength(0);
  expect(other.terminated).toHaveLength(0);
  await completeTask(task.id, "Done");
  await updateRuntimePool(pool.id, { enabled: false });
  await reconcileOnce({ getControllerCommands: commands });
  await reconcileOnce({ getControllerCommands: commands });
  expect(state.fake.terminated).toEqual([runtime.externalHandle!.externalId]);
  expect(other.terminated).toHaveLength(0);
  expect(state.fake.runtimes.size).toBe(0);
});

class LeaseController extends FailureTestController {
  renewed: string[] = [];
  override async provision(request: ProvisionRequest): Promise<RuntimeHandle> {
    const handle = await super.provision(request);
    handle.kind = "e2b";
    return handle;
  }
  async renew(handle: RuntimeHandle) {
    this.renewed.push(handle.externalId);
    return { endAt: new Date(Date.now() + 900_000).toISOString() };
  }
}

test("E2B lease renewal uses the runtime controller after a legacy placement change", async () => {
  const originalId = (await createRuntimeController({ name: "lease-original", kind: "e2b" })).id;
  const otherId = (await createRuntimeController({ name: "lease-other", kind: "e2b" })).id;
  const original = new LeaseController();
  const other = new LeaseController();
  const commands = async (id: string) => (id === originalId ? original : other);
  const { pool, agent, task } = await setup({
    kind: "e2b",
    placements: [originalId],
    maxRuntimes: 1,
  });
  await reconcileOnce({ getControllerCommands: commands });
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  await completeTask(task.id, "Done");
  await getDbClient().run("UPDATE runtime_pools SET placements = ? WHERE id = ?", [
    JSON.stringify([otherId]),
    pool.id,
  ]);
  await getDbClient().run("UPDATE runtime_instances SET lease_expires_at = ? WHERE id = ?", [
    new Date().toISOString(),
    runtime.id,
  ]);
  await reconcileOnce({ getControllerCommands: commands });
  expect(original.renewed).toEqual([runtime.externalHandle!.externalId]);
  expect(other.renewed).toHaveLength(0);
  expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
});

test.each([
  "provisioning",
  "active",
])("placement and kind changes reject %s runtimes atomically", async (status) => {
  const { pool } = await setup();
  await reconcileOnce();
  await getDbClient().run("UPDATE runtime_instances SET status = ? WHERE pool_id = ?", [
    status,
    pool.id,
  ]);
  const other = await createRuntimeController({ name: "other", kind: "docker" });
  const e2b = await createRuntimeController({ name: "e2b", kind: "e2b" });
  for (const patch of [
    { placements: [other.id] },
    { kind: "e2b" as const, placements: [e2b.id] },
  ]) {
    await expect(updateRuntimePool(pool.id, patch)).rejects.toMatchObject({ status: 409 });
    expect((await getRuntimePool(pool.id))?.placements).toEqual(pool.placements);
  }
  await updateRuntimePool(pool.id, { placements: pool.placements, enabled: false });
  await getDbClient().run("UPDATE runtime_instances SET status = 'offline' WHERE pool_id = ?", [
    pool.id,
  ]);
  expect((await updateRuntimePool(pool.id, { kind: "e2b", placements: [e2b.id] })).kind).toBe(
    "e2b",
  );
});

test.each([
  "provisioning",
  "active",
])("deletion and unbinding reject %s runtimes before changing bindings", async (status) => {
  const { pool, agent } = await setup();
  await reconcileOnce();
  await getDbClient().run("UPDATE runtime_instances SET status = ? WHERE pool_id = ?", [
    status,
    pool.id,
  ]);
  for (const force of [false, true]) {
    await expect(deleteRuntimePool(pool.id, force)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("wait"),
    });
    expect(await getRuntimePool(pool.id)).not.toBeNull();
    expect((await getAgentById(agent.id))?.runtimePoolId).toBe(pool.id);
  }
  await expect(bindAgentToPool(agent.id, null)).rejects.toMatchObject({ status: 409 });
  const other = await setup();
  await expect(bindAgentToPool(agent.id, other.pool.id)).rejects.toMatchObject({ status: 409 });
  expect((await bindAgentToPool(agent.id, pool.id)).runtimePoolId).toBe(pool.id);
  await getDbClient().run("UPDATE runtime_instances SET status = 'offline' WHERE pool_id = ?", [
    pool.id,
  ]);
  await bindAgentToPool(agent.id, null);
  await deleteRuntimePool(pool.id);
  expect(await getRuntimePool(pool.id)).toBeNull();
});

async function registerMention(agentId: string, runtimeId: string) {
  const taskId = crypto.randomUUID();
  const req = Readable.from([
    JSON.stringify({
      agentId,
      runtimeInstanceId: runtimeId,
      taskId,
      triggerType: "unread_mentions",
    }),
  ]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  let status = 0;
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end() {},
  } as unknown as ServerResponse;
  expect(
    await handleActiveSessions(
      req,
      res,
      ["api", "active-sessions"],
      new URLSearchParams(),
      agentId,
    ),
  ).toBe(true);
  expect(status).toBe(201);
  return taskId;
}

test("a real mention session survives idle ticks at 0, 61, and 66 seconds", async () => {
  const { pool, agent, task } = await setup({ idleMinutes: 1 });
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  await completeTask(task.id, "Done");
  const syntheticId = await registerMention(agent.id, runtime.id);
  const now = new Date();
  for (const seconds of [0, 61, 66]) {
    await reconcileOnce({ now: new Date(now.getTime() + seconds * 1000) });
    expect(
      await getDbClient().get("SELECT id FROM active_sessions WHERE taskId = ?", [syntheticId]),
    ).not.toBeNull();
    expect((await getRuntimeInstanceById(runtime.id))?.idleSince).toBeNull();
    expect((await getRuntimeInstanceById(runtime.id))?.status).toBe("active");
  }
  expect(state.fake.terminated).toHaveLength(0);
});

test("a stale taskless session cannot pin a runtime with fresh runtime pings", async () => {
  const { pool, agent, task } = await setup({ idleMinutes: 1 });
  await reconcileOnce();
  const runtime = (await listRuntimeInstancesForPool(pool.id))[0]!;
  await upsertRuntimeInstance({ id: runtime.id, agentId: agent.id, reportedSlots: 1 });
  await completeTask(task.id, "Done");
  const syntheticId = await registerMention(agent.id, runtime.id);
  const now = new Date();
  await reconcileOnce({ now });
  expect((await getRuntimeInstanceById(runtime.id))?.idleSince).toBeNull();
  await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
    new Date(now.getTime() - 31 * 60_000).toISOString(),
    syntheticId,
  ]);
  for (const seconds of [0, 61, 66]) {
    const at = new Date(now.getTime() + seconds * 1000);
    await getDbClient().run("UPDATE runtime_instances SET last_seen_at = ? WHERE id = ?", [
      at.toISOString(),
      runtime.id,
    ]);
    await reconcileOnce({ now: at });
  }
  expect(
    await getDbClient().get("SELECT id FROM active_sessions WHERE taskId = ?", [syntheticId]),
  ).toBeNull();
  expect(state.fake.terminated).toEqual([runtime.externalHandle!.externalId]);
});
