import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { closeDb, createAgent, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import { insertProvisioningRuntime, markRuntimeTerminated } from "../be/multi-runtime";
import { reconcileCacheReleases } from "../be/runtime-pools/cache-cleanup";
import {
  createRuntimeController,
  createRuntimePool,
  deleteRuntimeController,
  deleteRuntimePool,
  getRuntimePool,
  updateRuntimeController,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import { provisionRuntime, reconcileOnce } from "../be/runtime-pools/supervisor";
import type { ControllerCommands } from "../runtime-providers/controller";
import type { ProvisionRequest, RuntimeCacheReference } from "../runtime-providers/types";
import { registerVolatileSecret } from "../utils/secret-scrubber";

const path = `./test-runtime-cache-cleanup-${process.pid}.sqlite`;
const testGlobals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
let savedTemplate: Uint8Array | undefined;
const ownerId = "cache-cleanup-owner";
let controllerId: string;
let calls: RuntimeCacheReference[];
let release: (cache: RuntimeCacheReference) => Promise<void>;
let provisions: ProvisionRequest[];
let logSpy: ReturnType<typeof spyOn<typeof console, "error">>;
const commands: ControllerCommands = {
  traits: { canProvision: true, ephemeralDisk: true, supportsPause: false, persistentCache: true },
  workerApiUrl: "http://api.example.test",
  provision: async (request) => {
    provisions.push(request);
    return { kind: "docker", externalId: request.runtimeId };
  },
  terminate: async () => {},
  status: async () => ({}),
  list: async () => [],
  releaseCache: async (cache) => {
    calls.push(cache);
    await release(cache);
  },
};
const drain = () => reconcileCacheReleases(async () => commands, new AbortController().signal);
const jobs = () =>
  getDbClient().query<{ id: string; state: string; last_error: string | null }>(
    "SELECT id, state, last_error FROM runtime_cache_releases",
  );
const pool = () =>
  createRuntimePool({
    name: "cached",
    kind: "docker",
    placements: [controllerId],
    image: "worker:test",
    cache: { mountPath: "/cache" },
  });
async function runtime(poolId: string) {
  const agent = await createAgent({ name: crypto.randomUUID(), status: "idle", isLead: false });
  const id = crypto.randomUUID();
  await insertProvisioningRuntime({
    id,
    agentId: agent.id,
    poolId,
    controllerId,
    reportedSlots: 1,
  });
  return id;
}

beforeAll(() => {
  savedTemplate = testGlobals.__testMigrationTemplate;
  testGlobals.__testMigrationTemplate = undefined;
  closeDb();
  initDb(path);
  logSpy = spyOn(console, "error").mockImplementation(() => {});
});
beforeEach(async () => {
  for (const table of [
    "runtime_cache_releases",
    "runtime_instances",
    "session_tokens",
    "agents",
    "runtime_pools",
    "runtime_controllers",
    "swarm_config",
  ])
    await getDbClient().run(`DELETE FROM ${table}`);
  await upsertSwarmConfig({ scope: "global", key: "runtime_owner_id", value: ownerId });
  controllerId = (await createRuntimeController({ name: "cache-controller", kind: "docker" })).id;
  calls = [];
  provisions = [];
  release = async () => {};
});
afterAll(async () => {
  logSpy.mockRestore();
  closeDb();
  testGlobals.__testMigrationTemplate = savedTemplate;
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(path + suffix)
      .delete()
      .catch(() => {});
});

test("disable defers release for existing runtimes but not new cache-free runtimes", async () => {
  const p = await pool();
  const old = await runtime(p.id);
  await updateRuntimePool(p.id, { cache: null });
  const fresh = await runtime(p.id);
  await drain();
  expect(calls).toEqual([]);
  expect((await jobs())[0]?.state).toBe("pending");
  await markRuntimeTerminated(old, "stopped");
  await drain();
  expect(calls).toEqual([{ key: `swarm-cache-${p.id}`, poolId: p.id, ownerId }]);
  expect(await jobs()).toEqual([]);
  expect(
    await getDbClient().get(
      "SELECT id FROM runtime_instances WHERE id = ? AND status != 'offline'",
      [fresh],
    ),
  ).not.toBeNull();
});

test("pending release survives pool deletion and keeps its controller available", async () => {
  const p = await pool();
  await deleteRuntimePool(p.id);
  expect(await getRuntimePool(p.id)).toBeNull();
  await expect(deleteRuntimeController(controllerId)).rejects.toThrow("pending cache cleanup");
  await expect(
    updateRuntimeController(controllerId, { config: { DOCKER_HOST: "unix:///another.sock" } }),
  ).rejects.toThrow("wait for cleanup");
  await updateRuntimeController(controllerId, { name: "renamed" });
  await drain();
  expect(calls[0]?.poolId).toBe(p.id);
  await deleteRuntimeController(controllerId);
});

test("a failed release is scrubbed, persisted over restart, and retried", async () => {
  const p = await pool();
  const secret = "cache-cleanup-private-value";
  registerVolatileSecret(secret, "cleanup-test");
  release = async () => {
    throw new Error(`in use ${secret}`);
  };
  await updateRuntimePool(p.id, { cache: null });
  await drain();
  expect((await jobs())[0]).toMatchObject({
    state: "pending",
    last_error: expect.stringContaining("in use"),
  });
  expect((await jobs())[0]?.last_error).not.toContain(secret);
  const id = (await jobs())[0]!.id;
  closeDb();
  initDb(path);
  expect((await jobs())[0]?.id).toBe(id);
  release = async () => {};
  await drain();
  expect(calls).toHaveLength(2);
  expect(await jobs()).toEqual([]);
});

test("re-enabling a cache cancels pending cleanup and retains the volume", async () => {
  const p = await pool();
  await updateRuntimePool(p.id, { cache: null });
  await updateRuntimePool(p.id, { cache: { mountPath: "/cache" } });
  await drain();
  expect(calls).toEqual([]);
  expect(await jobs()).toEqual([]);
});

test("re-enabling during an in-flight release returns a retryable conflict", async () => {
  const p = await pool();
  await updateRuntimePool(p.id, { cache: null });
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  release = async () => {
    entered();
    await gate;
  };
  const draining = drain();
  await started;
  try {
    await expect(updateRuntimePool(p.id, { cache: { mountPath: "/cache" } })).rejects.toThrow(
      "cleanup is in progress",
    );
    expect((await jobs())[0]?.state).toBe("deleting");
    expect((await getRuntimePool(p.id))?.cache).toBeNull();
  } finally {
    finish();
    await draining;
  }
  await updateRuntimePool(p.id, { cache: { mountPath: "/cache" } });
});

test("re-enabling cancels a scanned release before the worker claims it", async () => {
  const p = await pool();
  await updateRuntimePool(p.id, { cache: null });
  const scanned = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const db = getDbClient();
  const run = db.run.bind(db);
  const claim = spyOn(db, "run").mockImplementation(async (sql, params) => {
    if (sql.startsWith("UPDATE runtime_cache_releases SET state = 'deleting'")) {
      scanned.resolve();
      await proceed.promise;
    }
    return await run(sql, params);
  });
  const draining = drain();
  try {
    await scanned.promise;
    await updateRuntimePool(p.id, { cache: { mountPath: "/cache" } });
  } finally {
    proceed.resolve();
    await draining;
    claim.mockRestore();
  }
  expect(calls).toEqual([]);
  expect(await jobs()).toEqual([]);
  expect((await getRuntimePool(p.id))?.cache).toEqual({ mountPath: "/cache" });
});

test("an unsupported or offline controller retains cleanup for a later retry", async () => {
  const p = await pool();
  await updateRuntimePool(p.id, { cache: null });
  await reconcileCacheReleases(async () => {
    throw new Error("controller offline");
  }, new AbortController().signal);
  expect((await jobs())[0]?.last_error).toContain("offline");
  const { releaseCache: _, ...legacy } = commands;
  await reconcileCacheReleases(async () => legacy, new AbortController().signal);
  expect((await jobs())[0]?.last_error).toContain("upgrade");
  await drain();
  expect(await jobs()).toEqual([]);
});

test("caches still configured on a disabled pool are retained for future use", async () => {
  const p = await pool();
  await updateRuntimePool(p.id, { enabled: false });
  await drain();
  expect(await jobs()).toEqual([]);
  expect(calls).toEqual([]);
});

test("the controller target cannot change while a cache exists", async () => {
  const p = await pool();
  await expect(updateRuntimeController(controllerId, { placement: "builtin" })).rejects.toThrow(
    "Disable pool caches",
  );
  await updateRuntimeController(controllerId, { config: {}, secretConfig: {} });
  await expect(
    updateRuntimeController(controllerId, { secretConfig: { KEY: "changed" } }),
  ).rejects.toThrow("Disable pool caches");
  await updateRuntimePool(p.id, { cache: null });
  await drain();
  await updateRuntimeController(controllerId, { config: { DOCKER_HOST: "unix:///new.sock" } });
});

test("a stale pool snapshot does not mount a disabled cache during provision", async () => {
  const p = await pool();
  await updateRuntimePool(p.id, { cache: null });
  const agent = await createAgent({ name: "fresh", status: "idle", isLead: false });
  expect(await provisionRuntime(p, agent, commands, ownerId)).toBe(true);
  expect(provisions).toHaveLength(1);
  expect(provisions[0]?.cache).toBeUndefined();
  await drain();
  expect(calls[0]?.poolId).toBe(p.id);
});

test("the supervisor tick releases a deleted pool cache", async () => {
  const p = await pool();
  await deleteRuntimePool(p.id);
  const previousPools = process.env.RUNTIME_POOLS_ENABLED;
  const previousMulti = process.env.MULTI_RUNTIME_ENABLED;
  process.env.RUNTIME_POOLS_ENABLED = "true";
  process.env.MULTI_RUNTIME_ENABLED = "true";
  try {
    await reconcileOnce({ getControllerCommands: async () => commands });
    expect(calls[0]?.poolId).toBe(p.id);
    expect(await jobs()).toEqual([]);
  } finally {
    if (previousPools === undefined) delete process.env.RUNTIME_POOLS_ENABLED;
    else process.env.RUNTIME_POOLS_ENABLED = previousPools;
    if (previousMulti === undefined) delete process.env.MULTI_RUNTIME_ENABLED;
    else process.env.MULTI_RUNTIME_ENABLED = previousMulti;
  }
});

test("a stale provision cannot recreate the cache on a previous placement", async () => {
  const p = await pool();
  const next = await createRuntimeController({ name: "next", kind: "docker" });
  await updateRuntimePool(p.id, { placements: [next.id] });
  const agent = await createAgent({ name: "moved", status: "idle", isLead: false });
  expect(await provisionRuntime(p, agent, commands, ownerId)).toBe(true);
  expect(provisions[0]?.cache).toBeUndefined();
  await drain();
  expect(calls[0]?.poolId).toBe(p.id);
});
