import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  jsonText,
  type NewRuntimePool,
  type RuntimePoolsRepository,
  type SqlQuery,
  type Storage,
  sql,
} from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";

function newPool(overrides: Partial<NewRuntimePool> = {}): NewRuntimePool {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    name: `pool-${id.slice(0, 8)}`,
    kind: "docker",
    placementsJson: '["c1"]',
    image: "img:1",
    lifecycle: "idle",
    idleMinutes: 5,
    slotsPerRuntime: 1,
    maxRuntimes: null,
    minRuntimes: 0,
    delivery: null,
    envJson: "{}",
    resourcesJson: null,
    cacheJson: null,
    workspaceJson: null,
    ttlSec: null,
    enabled: true,
    actor: null,
    ...overrides,
  };
}

export function runtimePoolsContract(engine: ContractEngine): void {
  describe(`runtimePools repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: RuntimePoolsRepository;

    const user = (id: string) =>
      storage.executor.run(sql`INSERT INTO users (id, name) VALUES (${id}, ${id})`);
    const agent = (id: string, name = id, poolId: string | null = null) =>
      storage.executor.run(sql`
        INSERT INTO agents (id, name, status, "createdAt", "lastUpdatedAt", runtime_pool_id)
        VALUES (${id}, ${name}, 'offline', ${T0}, ${T0}, ${poolId})`);
    const controller = (id: string, placement = "builtin") =>
      repo.insertController({
        id,
        name: id,
        kind: "docker",
        placement,
        configJson: "{}",
        secretConfig: null,
        actor: null,
      });
    const runtime = (
      id: string,
      agentId: string,
      fields: { poolId?: string | null; controllerId?: string | null; status?: string } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO runtime_instances (id, agent_id, status, pool_id, controller_id)
        VALUES (${id}, ${agentId}, ${fields.status ?? "active"}, ${fields.poolId ?? null},
          ${fields.controllerId ?? null})`);
    const task = (
      id: string,
      fields: {
        agentId?: string | null;
        offeredTo?: string | null;
        status?: string;
        priority?: number;
        createdAt?: string;
      },
    ) =>
      storage.executor.run(sql`
        INSERT INTO agent_tasks (id, task, status, "agentId", "offeredTo", priority, "createdAt", "lastUpdatedAt")
        VALUES (${id}, 't', ${fields.status ?? "pending"}, ${fields.agentId ?? null},
          ${fields.offeredTo ?? null}, ${fields.priority ?? 50}, ${fields.createdAt ?? T0}, ${T0})`);
    const session = (
      id: string,
      agentId: string,
      runtimeId: string,
      fields: { taskId?: string | null; triggerType?: string; lastHeartbeatAt?: string } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO active_sessions (id, "agentId", "taskId", "triggerType", "runtimeInstanceId", "lastHeartbeatAt")
        VALUES (${id}, ${agentId}, ${fields.taskId ?? null}, ${fields.triggerType ?? "task_assigned"},
          ${runtimeId}, ${fields.lastHeartbeatAt ?? T1})`);
    const runtimeRow = (id: string) =>
      storage.executor.get<Record<string, unknown>>(
        sql`SELECT * FROM runtime_instances WHERE id = ${id}`,
      );

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.runtimePools;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("controllers: value shape, byte order by name, name and id lookups", async () => {
      await user("u1");
      await repo.insertController({
        id: "c1",
        name: "b",
        kind: "docker",
        placement: "builtin",
        configJson: '{"A":"1"}',
        secretConfig: "enc",
        actor: "u1",
      });
      await controller("Z");
      await controller("a");
      const row = await repo.findController("c1");
      expect(row).toMatchObject({
        id: "c1",
        name: "b",
        kind: "docker",
        placement: "builtin",
        config: '{"A":"1"}',
        secretConfig: "enc",
        status: "unknown",
        lastSeenAt: null,
        lastError: null,
        lastErrorAt: null,
        createdBy: "u1",
        updatedBy: "u1",
      });
      expect(row?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect((await repo.listControllers()).map((c) => c.name)).toEqual(["Z", "a", "b"]);
      expect((await repo.listControllersWithSecrets()).map((c) => c.id)).toEqual(["c1"]);
      expect(await repo.findControllerIdByNameOrId("b", "nope")).toBe("c1");
      expect(await repo.findControllerIdByNameOrId("nope", "a")).toBe("a");
      expect(await repo.findControllerIdByNameOrId("nope", "nope")).toBeNull();
      expect(await repo.findControllerIdByName("Z")).toBe("Z");
      expect(await repo.controllerNameTaken("b", "c1")).toBe(false);
      expect(await repo.controllerNameTaken("b", "a")).toBe(true);
      await repo.updateController("c1", {
        name: "b2",
        kind: "docker",
        placement: "builtin",
        configJson: "{}",
        secretConfig: null,
        actor: null,
        now: T1,
      });
      expect(await repo.findController("c1")).toMatchObject({
        name: "b2",
        secretConfig: null,
        updatedBy: "u1",
        updatedAt: T1,
      });
      await repo.deleteController("c1");
      expect(await repo.findController("c1")).toBeNull();
    });

    test("controller config status writes only its own prefixed error", async () => {
      await controller("c1");
      const prefix = "E2B configuration: ";
      await repo.setControllerConfigStatus("c1", {
        status: "offline",
        prefix,
        error: `${prefix}missing key`,
        errorAt: T0,
        now: T0,
      });
      expect(await repo.findController("c1")).toMatchObject({
        status: "offline",
        lastError: `${prefix}missing key`,
        lastErrorAt: T0,
        updatedAt: T0,
      });
      // Same status and same error: no write at all.
      await repo.setControllerConfigStatus("c1", {
        status: "offline",
        prefix,
        error: `${prefix}missing key`,
        errorAt: T1,
        now: T1,
      });
      expect(await repo.findController("c1")).toMatchObject({ lastErrorAt: T0, updatedAt: T0 });
      // A foreign error is kept; the status still changes.
      await repo.recordControllerError("c1", "provision failed", T1);
      await repo.setControllerConfigStatus("c1", {
        status: "online",
        prefix,
        error: null,
        errorAt: null,
        now: T2,
      });
      expect(await repo.findController("c1")).toMatchObject({
        status: "online",
        lastError: "provision failed",
        lastErrorAt: T1,
        updatedAt: T2,
      });
      // Same status with a foreign error: skipped.
      await repo.setControllerConfigStatus("c1", {
        status: "online",
        prefix,
        error: null,
        errorAt: null,
        now: "2026-11-21T13:00:00.000Z",
      });
      expect((await repo.findController("c1"))?.updatedAt).toBe(T2);
    });

    test("remote controllers: insertion order and conditional offline", async () => {
      await controller("r-b", "remote");
      await controller("local");
      await controller("r-a", "remote");
      await repo.setControllerStatus("r-b", "online", T0);
      expect((await repo.listRemoteControllers()).map((c) => c.id)).toEqual(["r-b", "r-a"]);
      await repo.markRemoteControllerOffline("r-b", T1);
      await repo.markRemoteControllerOffline("r-a", T1);
      const [b, a] = await repo.listRemoteControllers();
      expect(b).toEqual({ id: "r-b", status: "offline", updated_at: T1, last_seen_at: T1 });
      expect(a).toMatchObject({ id: "r-a", status: "unknown", last_seen_at: null });
    });

    test("pools: value shape, flags, order by name, update keeps updated_by", async () => {
      await user("u1");
      await repo.insertPool(newPool({ id: "p1", name: "b", enabled: false, actor: "u1" }));
      await repo.insertPool(newPool({ id: "p2", name: "A" }));
      await repo.insertPool(newPool({ id: "p3", name: "a" }));
      const row = await repo.findPool("p1");
      expect(row).toMatchObject({
        id: "p1",
        name: "b",
        placements: '["c1"]',
        enabled: 0,
        idleMinutes: 5,
        slotsPerRuntime: 1,
        maxRuntimes: null,
        minRuntimes: 0,
        resolvedImage: null,
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        createdBy: "u1",
        updatedBy: "u1",
      });
      expect((await repo.findPool("p2"))?.enabled).toBe(1);
      expect((await repo.listPools()).map((p) => p.name)).toEqual(["A", "a", "b"]);
      expect(await repo.findPoolIdByNameOrId("a", "x")).toBe("p3");
      expect(await repo.poolNameTaken("a", "p3")).toBe(false);
      expect(await repo.poolNameTaken("a", "p1")).toBe(true);
      const { id: _id, actor: _actor, ...values } = newPool({ name: "b", enabled: true });
      await repo.updatePool("p1", {
        ...values,
        resolvedImage: "tmpl",
        cacheJson: '{"key":"k","mountPath":"/c"}',
        actor: null,
        now: T1,
      });
      expect(await repo.findPool("p1")).toMatchObject({
        enabled: 1,
        resolvedImage: "tmpl",
        updatedBy: "u1",
        updatedAt: T1,
      });
      expect(await repo.findPoolCache("p1")).toEqual({
        cache: '{"key":"k","mountPath":"/c"}',
        placements: '["c1"]',
      });
      await repo.deletePool("p1");
      expect(await repo.findPool("p1")).toBeNull();
      expect(await repo.findPoolCache("p1")).toBeNull();
    });

    test("setResolvedImage writes only while image and resources match", async () => {
      await repo.insertPool(newPool({ id: "p1", image: "docker://x" }));
      const args = { name: "t1", image: "docker://x", cpu: 4, memoryMb: 8192, now: T1 };
      expect(await repo.setResolvedImage("p1", { ...args, image: "docker://y" })).toBe(0);
      expect(await repo.setResolvedImage("p1", { ...args, cpu: 2 })).toBe(0);
      expect(await repo.setResolvedImage("p1", args)).toBe(1);
      expect((await repo.findPool("p1"))?.resolvedImage).toBe("t1");
      await repo.insertPool(
        newPool({ id: "p2", image: "docker://x", resourcesJson: '{"cpu":2,"memoryMb":1024}' }),
      );
      expect(await repo.setResolvedImage("p2", args)).toBe(0);
      expect(await repo.setResolvedImage("p2", { ...args, cpu: 2, memoryMb: 1024 })).toBe(1);
    });

    test("provision failures open the circuit at the threshold and keep it open", async () => {
      await repo.insertPool(newPool({ id: "p1" }));
      const fail = (now: string) =>
        repo.recordPoolProvisionFailure("p1", { error: "boom", now, threshold: 2, openUntil: T2 });
      expect(await fail(T0)).toEqual({ circuit_open_until: null });
      expect(await fail(T1)).toEqual({ circuit_open_until: T2 });
      expect(await repo.findPool("p1")).toMatchObject({
        consecutiveFailures: 2,
        lastError: "boom",
        lastErrorAt: T1,
      });
      expect(
        await repo.recordPoolProvisionFailure("p1", {
          error: "again",
          now: T1,
          threshold: 99,
          openUntil: "2026-11-22T00:00:00.000Z",
        }),
      ).toEqual({ circuit_open_until: "2026-11-22T00:00:00.000Z" });
      expect(
        await repo.recordPoolProvisionFailure(null, {
          error: "x",
          now: T0,
          threshold: 1,
          openUntil: T2,
        }),
      ).toBeNull();
    });

    test("pool cache error overwrites only empty or its own prefix", async () => {
      await repo.insertPool(newPool({ id: "p1" }));
      const prefix = "Persistent cache: ";
      await repo.setPoolCacheError("p1", { error: `${prefix}w`, errorAt: T0, prefix });
      expect((await repo.findPool("p1"))?.lastError).toBe(`${prefix}w`);
      await repo.setPoolCacheError("p1", { error: null, errorAt: null, prefix });
      expect((await repo.findPool("p1"))?.lastError).toBeNull();
      await repo.recordPoolProvisionFailure("p1", {
        error: "other",
        now: T0,
        threshold: 9,
        openUntil: T2,
      });
      await repo.setPoolCacheError("p1", { error: `${prefix}w`, errorAt: T1, prefix });
      expect((await repo.findPool("p1"))?.lastError).toBe("other");
    });

    test("cache releases: conflict no-op, order with ties, fenced claims", async () => {
      await controller("c1");
      await agent("a1");
      const release = (id: string, key: string, runtimeIds: string[] = []) =>
        repo.insertCacheRelease({
          id,
          poolId: "p1",
          controllerId: "c1",
          ownerId: "o1",
          cacheKey: key,
          runtimeIdsJson: JSON.stringify(runtimeIds),
          actor: null,
        });
      await release("r2", "k2", ["rt1"]);
      await release("r1", "k1");
      await release("dup", "k1");
      await storage.executor.run(sql`UPDATE runtime_cache_releases SET created_at = ${T0}`);
      expect(await repo.listCacheReleases()).toEqual([
        { id: "r2", poolId: "p1", controllerId: "c1", ownerId: "o1", key: "k2" },
        { id: "r1", poolId: "p1", controllerId: "c1", ownerId: "o1", key: "k1" },
      ]);
      expect(await repo.hasCacheReleaseForController("c1")).toBe(true);
      expect(await repo.hasCacheReleaseForController("c2")).toBe(false);

      // A non-offline runtime named by the release blocks the claim.
      await runtime("rt1", "a1");
      expect(await repo.claimCacheRelease("r2", T1, T0)).toBe(0);
      await storage.executor.run(
        sql`UPDATE runtime_instances SET status = 'offline' WHERE id = 'rt1'`,
      );
      expect(await repo.claimCacheRelease("r2", T1, T0)).toBe(1);
      // A fresh claim is not stolen; a stale one is.
      expect(await repo.claimCacheRelease("r2", T2, T0)).toBe(0);
      expect(await repo.claimCacheRelease("r2", T2, T2)).toBe(1);
      // The old claim no longer owns it.
      await repo.deleteClaimedCacheRelease("r2", T1);
      await repo.releaseCacheReleaseClaim("r2", T1, "late", T2);
      expect((await repo.listCacheReleases()).map((r) => r.id)).toEqual(["r2", "r1"]);
      await repo.releaseCacheReleaseClaim("r2", T2, "failed", T2);
      const row = await storage.executor.get<{ state: string; last_error: string }>(
        sql`SELECT state, last_error FROM runtime_cache_releases WHERE id = 'r2'`,
      );
      expect(row).toEqual({ state: "pending", last_error: "failed" });
      expect(await repo.claimCacheRelease("r2", "2026-11-21T13:00:00.000Z", T0)).toBe(1);
      await repo.deleteClaimedCacheRelease("r2", "2026-11-21T13:00:00.000Z");
      expect((await repo.listCacheReleases()).map((r) => r.id)).toEqual(["r1"]);
    });

    test("runtime lookups and lists in insertion order", async () => {
      await agent("a1");
      await agent("a2");
      await runtime("z", "a1", { poolId: "p1", controllerId: "c1" });
      await runtime("m", "a1", { poolId: "p1", controllerId: null });
      await runtime("b", "a1", { poolId: "p1", controllerId: "c2" });
      await runtime("o", "a2", { poolId: "p1", controllerId: "c1", status: "offline" });
      await runtime("q", "a2", { poolId: "p2", controllerId: "c1", status: "provisioning" });
      expect(await repo.listNonOfflinePoolRuntimeIds("p1", "c1")).toEqual(["z", "m"]);
      expect(await repo.listNonOfflineControllerRuntimeIds("c1")).toEqual(["z", "q"]);
      expect(await repo.listControllerRuntimes("c1")).toEqual([
        { id: "z", status: "active", external_handle: null },
        { id: "o", status: "offline", external_handle: null },
        { id: "q", status: "provisioning", external_handle: null },
      ]);
      expect(await repo.listUnadoptedProvisioningIds("c1")).toEqual(["q"]);
      expect(await repo.hasNonOfflinePoolRuntime("p1")).toBe(true);
      expect(await repo.hasNonOfflinePoolRuntime("p3")).toBe(false);
      expect(await repo.hasNonOfflineAgentPoolRuntime("a2")).toBe(true);
      expect(await repo.hasProvisioningRuntime("a2", "p2")).toBe(true);
      await repo.setRuntimeDraining("q", true);
      expect((await runtimeRow("q"))?.draining).toBe(1);
      expect(await repo.hasProvisioningRuntime("a2", "p2")).toBe(false);
      await repo.setRuntimeDraining("q", false);
      expect((await runtimeRow("q"))?.draining).toBe(0);
    });

    test("remote provision adoption matches only an unadopted live row", async () => {
      await agent("a1");
      await runtime("r1", "a1", { poolId: "p1", controllerId: "c1", status: "provisioning" });
      await storage.executor.run(
        sql`UPDATE runtime_instances SET workspace_slot = 2 WHERE id = 'r1'`,
      );
      const adopt = { runtimeId: "r1", controllerId: "c1", agentId: "a1", poolId: "p1", now: T1 };
      expect(
        await repo.adoptRemoteProvision({ ...adopt, poolId: "p2", handleJson: "{}" }),
      ).toBeNull();
      expect(await repo.adoptRemoteProvision({ ...adopt, handleJson: '{"h":1}' })).toEqual({
        agent_id: "a1",
        workspace_slot: 2,
      });
      expect(await repo.adoptRemoteProvision({ ...adopt, handleJson: '{"h":2}' })).toBeNull();
      expect(await runtimeRow("r1")).toMatchObject({ external_handle: '{"h":1}', updated_at: T1 });
      expect(await repo.listUnadoptedProvisioningIds("c1")).toEqual([]);
    });

    test("provision bookkeeping on runtime rows", async () => {
      await agent("a1");
      await runtime("r1", "a1", { status: "provisioning" });
      await storage.executor.run(
        sql`UPDATE agents SET runtime_provision_attempts = 2 WHERE id = 'a1'`,
      );
      await repo.recordProvisionRequest("r1", "a1", T0);
      expect(await runtimeRow("r1")).toMatchObject({
        provision_attempts: 3,
        provision_requested_at: T0,
      });
      expect(await repo.setProvisionError("r1", "first")).toBe(1);
      expect(await repo.setProvisionError("r1", "second")).toBe(0);
      await repo.setProvisionErrorIfUnset("r1", "third");
      expect((await runtimeRow("r1"))?.provision_error).toBe("first");
      const created = (await runtimeRow("r1"))?.created_at;
      await repo.recordProvisioned("r1", {
        handleJson: '{"h":1}',
        leaseExpiresAt: T2,
        createdAt: null,
        now: T1,
      });
      expect(await runtimeRow("r1")).toMatchObject({
        external_handle: '{"h":1}',
        lease_expires_at: T2,
        created_at: created,
        updated_at: T1,
      });
      await repo.recordProvisioned("r1", {
        handleJson: "{}",
        leaseExpiresAt: null,
        createdAt: T0,
        now: T1,
      });
      expect(await runtimeRow("r1")).toMatchObject({ created_at: T0, lease_expires_at: null });
      await repo.setRuntimeLease("r1", T2, T2);
      await repo.markRuntimeResumed("r1", T2);
      expect(await runtimeRow("r1")).toMatchObject({
        last_seen_at: T2,
        lease_expires_at: null,
        updated_at: T2,
      });
      await storage.executor.run(sql`UPDATE runtime_instances SET status = 'offline'`);
      await repo.setRuntimeLease("r1", T0, T0);
      await repo.markRuntimeResumed("r1", T0);
      expect(await runtimeRow("r1")).toMatchObject({ last_seen_at: T2, lease_expires_at: null });
    });

    test("busy, idle and draining marks", async () => {
      await agent("a1");
      await runtime("r1", "a1");
      await task("t1", { agentId: "a1" });
      await repo.setRuntimeIdleSince("r1", T0);
      await repo.markRuntimeBusy("r1", true, "missing-task");
      expect(await runtimeRow("r1")).toMatchObject({
        idle_since: null,
        draining: 1,
        task_id: null,
      });
      await repo.markRuntimeBusy("r1", false, "t1");
      expect(await runtimeRow("r1")).toMatchObject({ draining: 0, task_id: "t1" });
      await repo.markRuntimeBusy("r1", false, null);
      expect((await runtimeRow("r1"))?.task_id).toBe("t1");
    });

    test("rotating runtimes: expiring unrevoked tokens or aged runtimes, ordered by id", async () => {
      await agent("a1");
      await runtime("r-b", "a1", { poolId: "p1" });
      await runtime("r-a", "a1", { poolId: "p1" });
      await runtime("r-c", "a1", { poolId: "p1" });
      await runtime("r-other", "a1", { poolId: "p2" });
      await storage.executor.run(sql`UPDATE runtime_instances SET created_at = ${T1}`);
      await storage.executor.run(
        sql`UPDATE runtime_instances SET created_at = ${T0} WHERE id = 'r-c'`,
      );
      const token = (id: string, runtimeId: string, expiresAt: string, revokedAt: string | null) =>
        storage.executor.run(sql`
          INSERT INTO session_tokens (id, "tokenHash", "tokenPreview", "agentId", "runtimeId", "expiresAt", "revokedAt")
          VALUES (${id}, ${id}, ${id}, 'a1', ${runtimeId}, ${expiresAt}, ${revokedAt})`);
      await token("t1", "r-b", T1, null);
      await token("t2", "r-a", T1, null);
      await token("t3", "r-a", T0, null);
      await token("t4", "r-c", T0, T0);
      await token("t5", "r-other", T0, null);
      expect(await repo.listRotatingRuntimeIds("p1", T1, null)).toEqual(["r-a", "r-b"]);
      expect(await repo.listRotatingRuntimeIds("p1", T0, null)).toEqual(["r-a"]);
      expect(await repo.listRotatingRuntimeIds("p1", T0, T0)).toEqual(["r-a", "r-c"]);
    });

    test("agents: pool binding, name order with ties, provision retry", async () => {
      await user("u1");
      await repo.insertPool(newPool({ id: "p1" }));
      await agent("a3", "beta", "p1");
      await agent("a1", "alpha", "p1");
      await agent("a2", "beta", "p1");
      await agent("a4", "Zed", "p1");
      await agent("x", "other");
      const listed = await repo.listAgentsForPool<{ id: string }>("p1");
      expect(listed.map((a) => a.id)).toEqual(["a4", "a1", "a3", "a2"]);
      const bound = await repo.bindAgent<{
        id: string;
        runtime_pool_id: string;
        updated_by: string;
      }>("x", "p1", "u1", T1);
      expect(bound).toMatchObject({
        id: "x",
        runtime_pool_id: "p1",
        updated_by: "u1",
        lastUpdatedAt: T1,
      });
      expect(await repo.bindAgent("missing", "p1", null, T1)).toBeNull();
      await repo.bindAgent("x", null, null, T2);
      expect(
        await storage.executor.get(
          sql`SELECT runtime_pool_id, updated_by FROM agents WHERE id = 'x'`,
        ),
      ).toEqual({ runtime_pool_id: null, updated_by: "u1" });
      await repo.setAgentCreatedBy("x", "u1");
      expect(
        await storage.executor.get(sql`SELECT created_by, updated_by FROM agents WHERE id = 'x'`),
      ).toEqual({ created_by: "u1", updated_by: "u1" });

      expect(await repo.incrementProvisionAttempts("a1")).toBe(1);
      expect(await repo.incrementProvisionAttempts("a1")).toBe(2);
      expect(await repo.incrementProvisionAttempts("missing")).toBeNull();
      await repo.setProvisionRetryAt("a1", T2);
      expect(await repo.getProvisionRetry("a1")).toEqual({
        runtime_provision_retry_at: T2,
        runtime_provision_attempts: 2,
      });
      await repo.incrementProvisionAttempts("a2");
      await repo.resetPoolProvisionRetry("p1");
      expect(await repo.getProvisionRetry("a1")).toEqual({
        runtime_provision_retry_at: null,
        runtime_provision_attempts: 0,
      });
      expect((await repo.getProvisionRetry("a2"))?.runtime_provision_attempts).toBe(0);
      await repo.incrementProvisionAttempts("x");
      await repo.resetProvisionRetry("x");
      expect((await repo.getProvisionRetry("x"))?.runtime_provision_attempts).toBe(0);
      expect(await repo.getProvisionRetry("missing")).toBeNull();

      await repo.unbindPoolAgents("p1", "u1", T2);
      expect(await repo.listAgentsForPool("p1")).toEqual([]);
    });

    test("pending work: priority desc, createdAt, insertion order", async () => {
      await agent("a1");
      await agent("a2");
      await task("t-low", { agentId: "a1", priority: 10 });
      await task("t-b", { agentId: "a1", priority: 50 });
      await task("t-a", { agentId: "a1", priority: 50 });
      await task("t-old", { agentId: "a1", priority: 50, createdAt: "2026-11-20T00:00:00.000Z" });
      await task("t-offer", { offeredTo: "a1", status: "offered", priority: 50 });
      await task("t-done", { agentId: "a1", status: "completed" });
      await task("t-other", { agentId: "a2" });
      expect((await repo.listPendingWork<{ id: string }>("a1")).map((t) => t.id)).toEqual([
        "t-old",
        "t-b",
        "t-a",
        "t-offer",
        "t-low",
      ]);
      expect(await repo.listPendingTaskIds("a1")).toEqual(["t-old", "t-low", "t-b", "t-a"]);
    });

    test("pending work: a NULL priority sorts after every priority", async () => {
      await agent("a1");
      await task("t-null", { agentId: "a1" });
      await storage.executor.run(sql`UPDATE agent_tasks SET priority = NULL WHERE id = 't-null'`);
      await task("t-low", { agentId: "a1", priority: 0 });
      expect((await repo.listPendingWork<{ id: string }>("a1")).map((t) => t.id)).toEqual([
        "t-low",
        "t-null",
      ]);
    });

    test("unread mention channels count once per channel", async () => {
      await agent("a1");
      const channel = (id: string) =>
        storage.executor.run(
          sql`INSERT INTO channels (id, name, "createdAt") VALUES (${id}, ${id}, ${T0})`,
        );
      const message = (id: string, channelId: string, mentions: string, createdAt = T1) =>
        storage.executor.run(sql`
          INSERT INTO channel_messages (id, "channelId", content, mentions, "createdAt")
          VALUES (${id}, ${channelId}, 'hi', ${jsonText(mentions)}, ${createdAt})`);
      await channel("ch1");
      await channel("ch2");
      await channel("ch3");
      await message("m1", "ch1", '["a1"]');
      await message("m2", "ch1", '["a1"]');
      await message("m3", "ch2", '["A1"]');
      await message("m4", "ch3", '["a1"]', T0);
      await storage.executor.run(sql`
        INSERT INTO channel_read_state ("agentId", "channelId", "lastReadAt")
        VALUES ('a1', 'ch3', ${T0})`);
      // ch1 (two messages) and ch2 (ASCII case folded); ch3 is read.
      expect(await repo.countUnreadMentionChannels("a1")).toBe(2);
      // A channel being processed (claimed) does not count.
      await storage.executor.run(sql`
        INSERT INTO channel_read_state ("agentId", "channelId", "lastReadAt", processing_since)
        VALUES ('a1', 'ch1', ${"2026-11-01T00:00:00.000Z"}, ${T0})`);
      expect(await repo.countUnreadMentionChannels("a1")).toBe(1);
    });

    test("runtime sessions: lists, stale and busy rules", async () => {
      await agent("a1");
      await runtime("r1", "a1");
      await task("t-run", { agentId: "a1", status: "in_progress" });
      await task("t-done", { agentId: "a1", status: "completed" });
      await task("t-free", { agentId: "a1", status: "in_progress" });
      await session("s2", "a1", "r1", { taskId: "t-run" });
      await session("s1", "a1", "r1", { taskId: "t-done" });
      expect(await repo.listRuntimeSessionTaskIds("r1")).toEqual(["t-run", "t-done"]);
      expect(await repo.countRuntimeSessions("r1")).toBe(2);
      expect(await repo.hasRuntimeSession("r1")).toBe(true);
      expect(await repo.hasRuntimeSession("r2")).toBe(false);

      await storage.executor.run(
        sql`UPDATE agent_tasks SET runtime_instance_id = 'r1' WHERE id IN ('t-run', 't-free')`,
      );
      expect(await repo.listDispatchedTaskIdsWithoutSession("r1")).toEqual(["t-free"]);

      const terminal = ["completed", "failed", "cancelled"];
      expect(await repo.findBusyRuntimeSession("r1", terminal, T0)).toEqual({ taskId: "t-run" });
      expect(await repo.hasStaleRuntimeSession("r1", terminal, T0)).toBe(true);
      await repo.deleteStaleRuntimeSessions("r1", terminal, T0);
      expect(await repo.listRuntimeSessionTaskIds("r1")).toEqual(["t-run"]);

      await repo.deleteRuntimeSession("t-run", "r1");
      // Taskless trigger: busy while fresh, stale once its heartbeat is old.
      await session("s3", "a1", "r1", { taskId: "chan-1", triggerType: "unread_mentions" });
      expect(await repo.findBusyRuntimeSession("r1", terminal, T1)).toEqual({ taskId: "chan-1" });
      expect(await repo.hasStaleRuntimeSession("r1", terminal, T1)).toBe(false);
      expect(await repo.findBusyRuntimeSession("r1", terminal, T2)).toBeNull();
      expect(await repo.hasStaleRuntimeSession("r1", terminal, T2)).toBe(true);
      // A taskless session of another trigger type is stale at once.
      await repo.deleteStaleRuntimeSessions("r1", terminal, T2);
      await session("s4", "a1", "r1", { taskId: "x", triggerType: "task_assigned" });
      expect(await repo.hasStaleRuntimeSession("r1", terminal, T0)).toBe(true);
      expect(await repo.findBusyRuntimeSession("r1", terminal, T0)).toBeNull();
    });

    test("controller tokens and the seed marker", async () => {
      await controller("c1", "remote");
      const token = (id: string, revokedAt: string | null = null) =>
        storage.executor.run(sql`
          INSERT INTO session_tokens (id, "tokenHash", "tokenPreview", "agentId", "controllerId", "expiresAt", "revokedAt")
          VALUES (${id}, ${id}, ${id}, 'c1', 'c1', ${T2}, ${revokedAt})`);
      await token("tk-b");
      await token("tk-a");
      await token("tk-old", T0);
      expect(await repo.getSessionTokenExpiry("tk-a")).toBe(T2);
      expect(await repo.getSessionTokenExpiry("missing")).toBeNull();
      expect(await repo.listActiveControllerTokenIds("c1")).toEqual(["tk-a", "tk-b"]);
      await repo.revokeControllerTokens("c1", T1);
      expect(await repo.listActiveControllerTokenIds("c1")).toEqual([]);
      expect(
        await storage.executor.get(sql`SELECT "revokedAt" FROM session_tokens WHERE id = 'tk-old'`),
      ).toEqual({ revokedAt: T0 });

      expect(await repo.hasSeedMarker("maintenance", "k")).toBe(false);
      await repo.insertSeedMarker("maintenance", "k", "1");
      expect(await repo.hasSeedMarker("maintenance", "k")).toBe(true);
      expect(await repo.hasSeedMarker("other", "k")).toBe(false);
    });

    test("runtime lifecycle: register refreshes only the owner's row; provisioning insert and slots", async () => {
      await agent("a1");
      await agent("a2");
      const first = await repo.upsertActiveRuntime({
        id: "r1",
        agentId: "a1",
        reportedSlots: 2,
        metadata: '{"v":1}',
      });
      expect(first).toMatchObject({
        id: "r1",
        agent_id: "a1",
        status: "active",
        reported_slots: 2,
        metadata: '{"v":1}',
        pool_id: null,
        draining: 0,
        credential_ready: null,
      });
      expect(first?.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // Same agent: refreshed, a null metadata keeps the stored one.
      const again = await repo.upsertActiveRuntime({
        id: "r1",
        agentId: "a1",
        reportedSlots: 3,
        metadata: null,
      });
      expect(again).toMatchObject({ reported_slots: 3, metadata: '{"v":1}' });
      // Another agent: no row written.
      expect(
        await repo.upsertActiveRuntime({
          id: "r1",
          agentId: "a2",
          reportedSlots: 1,
          metadata: null,
        }),
      ).toBeNull();
      expect(await repo.findRuntimeInstance("r1")).toMatchObject({ agent_id: "a1" });
      expect(await repo.findRuntimeInstance("missing")).toBeNull();

      await controller("c1");
      await repo.insertPool(newPool({ id: "p1" }));
      const prov = await repo.insertProvisioningRuntime({
        id: "r2",
        agentId: "a1",
        poolId: "p1",
        controllerId: "c1",
        reportedSlots: 1,
        workspaceSlot: 1,
        now: T0,
      });
      expect(prov).toMatchObject({
        status: "provisioning",
        pool_id: "p1",
        controller_id: "c1",
        provision_requested_at: T0,
        workspace_slot: 1,
      });
      expect(await repo.isProvisioningRuntimeOf("r2", "a1")).toBe(true);
      expect(await repo.isProvisioningRuntimeOf("r2", "a2")).toBe(false);
      expect(await repo.isProvisioningRuntimeOf("r1", "a1")).toBe(false);
      await storage.executor.run(
        sql`UPDATE runtime_instances SET workspace_slot = 0 WHERE id = 'r1'`,
      );
      expect(await repo.listWorkspaceSlotsInUse("a1")).toEqual([0, 1]);
      await repo.overwriteProvisionError("r2", "e1");
      await repo.overwriteProvisionError("r2", "e2");
      expect(await repo.findRuntimeInstance("r2")).toMatchObject({ provision_error: "e2" });
      expect(await repo.markRuntimeOffline("r2", "a2")).toBeNull();
      expect(await repo.markRuntimeOffline("r2", "a1")).toMatchObject({ status: "offline" });
      expect(await repo.listWorkspaceSlotsInUse("a1")).toEqual([0]);

      await storage.executor.run(sql`
        UPDATE runtime_pools SET consecutive_failures = 3, circuit_open_until = ${T1} WHERE id = 'p1'`);
      await repo.resetPoolCircuit("p1");
      expect(await repo.findPool("p1")).toMatchObject({
        consecutiveFailures: 0,
        circuitOpenUntil: null,
      });
    });

    test("runtime liveness: touch, credential readiness, counts and listings", async () => {
      await agent("a1");
      await agent("a2");
      await runtime("r1", "a1");
      await runtime("r0", "a1");
      await runtime("r2", "a2");
      await runtime("off", "a1", { status: "offline" });
      await storage.executor.run(
        sql`UPDATE runtime_instances SET last_seen_at = ${T1}, created_at = ${T0}`,
      );
      await storage.executor.run(
        sql`UPDATE runtime_instances SET last_seen_at = ${T0} WHERE id = 'r2'`,
      );

      expect(await repo.countLiveRuntimes("a1", T1)).toBe(2);
      expect(await repo.countLiveRuntimes("a2", T1)).toBe(0);
      expect(await repo.listAgentIdsWithLiveRuntime(T0)).toEqual(["a1", "a2"]);
      expect(await repo.listAgentIdsWithLiveRuntime(T1)).toEqual(["a1"]);
      const listed = await repo.listRuntimesForAgent("a1", T1);
      expect(listed.map((r) => [r.id, r.is_live])).toEqual([
        ["off", 0],
        ["r0", 1],
        ["r1", 1],
      ]);

      expect(await repo.isLiveConfirmedRuntime("r1", "a1", T1)).toBe(true);
      expect(await repo.isLiveConfirmedRuntime("r1", "a2", T1)).toBe(false);
      expect(await repo.isLiveConfirmedRuntime("r2", "a2", T1)).toBe(false);
      // A workspace runtime without a verified handle is not confirmed.
      await storage.executor.run(
        sql`UPDATE runtime_instances SET workspace_slot = 0 WHERE id = 'r0'`,
      );
      expect(await repo.isLiveConfirmedRuntime("r0", "a1", T1)).toBe(false);
      expect(await repo.touchLiveRuntime("r0", "a1", T1)).toBe(false);
      expect(await repo.touchLiveRuntime("r1", "a1", T1)).toBe(true);
      expect((await repo.findRuntimeInstance("r1"))?.last_seen_at).not.toBe(T1);
      expect(await repo.touchLiveRuntime("r2", "a2", T1)).toBe(false);
      await storage.executor.run(
        sql`UPDATE runtime_instances SET last_seen_at = ${T1} WHERE id = 'r1'`,
      );

      expect(await repo.hasReadyLiveRuntime("a1", T1)).toBe(true);
      expect(await repo.setRuntimeCredentialReady("r1", "a1", false, T1)).toBe(true);
      expect(await repo.setRuntimeCredentialReady("r0", "a1", false, T1)).toBe(true);
      expect(await repo.findRuntimeInstance("r1")).toMatchObject({ credential_ready: 0 });
      expect(await repo.hasReadyLiveRuntime("a1", T1)).toBe(false);
      expect(await repo.setRuntimeCredentialReady("r1", "a1", true, T1)).toBe(true);
      expect(await repo.findRuntimeInstance("r1")).toMatchObject({ credential_ready: 1 });
      expect(await repo.hasReadyLiveRuntime("a1", T1)).toBe(true);
      expect(await repo.setRuntimeCredentialReady("r2", "a2", true, T1)).toBe(false);
    });

    test("runtime sweep: stale non-pool rows in insertion order, prune keeps provisioning and live pool rows", async () => {
      await agent("a1");
      await controller("c1");
      await repo.insertPool(newPool({ id: "p1" }));
      await runtime("s2", "a1");
      await runtime("s1", "a1");
      await runtime("pool-active", "a1", { poolId: "p1", controllerId: "c1" });
      await runtime("pool-off", "a1", { poolId: "p1", controllerId: "c1", status: "offline" });
      await runtime("prov", "a1", { poolId: "p1", controllerId: "c1", status: "provisioning" });
      await runtime("fresh", "a1");
      await storage.executor.run(
        sql`UPDATE runtime_instances SET last_seen_at = ${T0}, created_at = ${T1}`,
      );
      await storage.executor.run(
        sql`UPDATE runtime_instances SET last_seen_at = ${T2} WHERE id = 'fresh'`,
      );
      await storage.executor.run(
        sql`UPDATE runtime_instances SET created_at = ${T0} WHERE id = 'pool-off'`,
      );
      expect(await repo.listStaleUnpooledRuntimes(T1)).toEqual([
        { id: "s2", agent_id: "a1" },
        { id: "s1", agent_id: "a1" },
      ]);
      expect((await repo.listRuntimesForPool("p1")).map((r) => r.id)).toEqual([
        "pool-off",
        "pool-active",
        "prov",
      ]);
      expect((await repo.listRuntimesForPools(["p1", "p-none"])).map((r) => r.id)).toEqual([
        "pool-off",
        "pool-active",
        "prov",
      ]);
      expect(await repo.listRuntimesForPools([])).toEqual([]);
      expect(await repo.pruneStaleRuntimes(T1)).toBe(3);
      const left = await storage.executor.query<{ id: string }>(
        sql`SELECT id FROM runtime_instances ORDER BY id`,
      );
      expect(left.map((r) => r.id)).toEqual(["fresh", "pool-active", "prov"]);
    });

    test("remote controller connection status writes", async () => {
      await controller("rc", "remote");
      const row = () =>
        storage.executor.get<Record<string, unknown>>(
          sql`SELECT status, last_error, last_error_at, last_seen_at, updated_at FROM runtime_controllers WHERE id = 'rc'`,
        );
      const before = await row();
      await repo.setControllerStatusOnly("rc", "unknown");
      expect(await row()).toMatchObject({ status: "unknown", updated_at: before?.updated_at });
      await repo.recordControllerConnectionError("rc", "e1", T0);
      expect(await row()).toMatchObject({ status: "offline", last_error: "e1", last_error_at: T0 });
      await repo.markControllerOnline("rc", T1, T2);
      expect(await row()).toMatchObject({
        status: "online",
        last_seen_at: T1,
        updated_at: T2,
        last_error: null,
        last_error_at: null,
      });
      // An online controller keeps its status on an error.
      await repo.recordControllerConnectionError("rc", "e2", T1);
      expect(await row()).toMatchObject({ status: "online", last_error: "e2" });
      await repo.touchControllerSeen("rc", T2);
      expect(await row()).toMatchObject({ last_seen_at: T2, updated_at: T2 });
      await repo.markControllerDisconnected("rc", T0);
      expect(await row()).toMatchObject({ status: "offline", last_seen_at: T0, updated_at: T0 });
    });

    test("setRuntimeTask sets task_id only on the agent's own runtime", async () => {
      await agent("a1");
      await agent("a2");
      await runtime("rt", "a1");
      await repo.setRuntimeTask("rt", "a2", "t-x");
      expect(await runtimeRow("rt")).toMatchObject({ task_id: null });
      await repo.setRuntimeTask("rt", "a1", "t-1");
      expect(await runtimeRow("rt")).toMatchObject({ task_id: "t-1" });
    });

    test("pool routing: eligible free slots per agent, provisioning agents, live auth modes", async () => {
      const perTask = newPool({ lifecycle: "per-task" });
      const disabled = newPool({ enabled: false });
      await repo.insertPool(perTask);
      await repo.insertPool(disabled);
      await agent("a1");
      await agent("a2", "a2", perTask.id);
      await agent("a3", "a3", disabled.id);
      const set = (id: string, fields: SqlQuery) =>
        storage.executor.run(sql`UPDATE runtime_instances SET ${fields} WHERE id = ${id}`);
      // a1: two runtimes, 3 slots with one session, and 1 slot busy with its live task.
      await runtime("r1", "a1");
      await set("r1", sql`reported_slots = 3, last_seen_at = ${T1}`);
      await session("s1", "a1", "r1");
      await task("t-live", { agentId: "a1", status: "in_progress" });
      await runtime("r2", "a1");
      await set("r2", sql`reported_slots = 1, last_seen_at = ${T1}, task_id = 't-live'`);
      // Excluded: draining, credential not ready, stale.
      await runtime("r3", "a1");
      await set("r3", sql`reported_slots = 5, last_seen_at = ${T1}, draining = ${true}`);
      await runtime("r4", "a1");
      await set("r4", sql`reported_slots = 5, last_seen_at = ${T1}, credential_ready = ${false}`);
      await runtime("r5", "a1");
      await set("r5", sql`reported_slots = 5, last_seen_at = ${T0}`);
      // a2 (per-task pool): a runtime on a live task counts (2 - 1 free); one whose
      // task finished is excluded.
      await task("t-run", { agentId: "a2", status: "in_progress" });
      await runtime("r6", "a2", { poolId: perTask.id });
      await set("r6", sql`reported_slots = 2, last_seen_at = ${T1}, task_id = 't-run'`);
      await task("t-done", { agentId: "a2", status: "completed" });
      await runtime("r8", "a2", { poolId: perTask.id });
      await set("r8", sql`reported_slots = 5, last_seen_at = ${T1}, task_id = 't-done'`);
      // a3: disabled pool, excluded.
      await runtime("r7", "a3", { poolId: disabled.id });
      await set("r7", sql`reported_slots = 2, last_seen_at = ${T1}`);
      const slots = await repo.listEligibleRuntimeSlots(T1);
      expect(
        Object.fromEntries(slots.map((row) => [row.agent_id, Number(row.free_slots)])),
      ).toEqual({ a1: 2, a2: 1 });
      expect(await repo.listEligibleRuntimeSlots(T1, "a2")).toEqual([
        { agent_id: "a2", free_slots: 1 },
      ]);

      await runtime("p1", "a1", { status: "provisioning" });
      await runtime("p2", "a1", { status: "provisioning" });
      await runtime("p3", "a2", { status: "provisioning" });
      await set("p3", sql`draining = ${true}`);
      expect(await repo.listProvisioningAgentIds()).toEqual(["a1"]);

      await storage.executor.run(sql`
        INSERT INTO session_tokens (id, "tokenHash", "tokenPreview", "agentId", "runtimeId", "expiresAt", "revokedAt")
        VALUES ('k1', 'h1', 'p', 'a1', 'r1', ${T2}, NULL),
               ('k2', 'h2', 'p', 'a1', 'r2', ${T0}, NULL),
               ('k3', 'h3', 'p', 'a2', 'r6', ${T2}, ${T0})`);
      const modes = await repo.listLiveRuntimeAuthModes(T1, T1);
      expect(
        modes
          .map((row) => [row.agent_id, row.runtime_token])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(b[1]) - Number(a[1])),
      ).toEqual([
        ["a1", 1],
        ["a1", 0],
        ["a1", 0],
        ["a1", 0],
        ["a2", 0],
        ["a2", 0],
        ["a3", 0],
      ]);
    });
  });
}
