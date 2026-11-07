import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { encryptSecret } from "../be/crypto";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentById,
  getDbClient,
  getSwarmConfigs,
  getTaskById,
  initDb,
} from "../be/db";
import {
  bindAgentToPool,
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
  deleteRuntimeController,
  deleteRuntimePool,
  getPoolForAgent,
  getRuntimeController,
  getRuntimeControllerSecrets,
  getRuntimePool,
  listAgentsForPool,
  listRuntimeControllers,
  loadRuntimeControllerSecrets,
  updateRuntimeController,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import { loadSecretRegistry } from "../be/secret-registry";
import { clearVolatileSecretsForTesting, scrubSecrets } from "../utils/secret-scrubber";

const dbPath = "./test-runtime-pools-db.sqlite";
async function cleanup() {
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(dbPath + suffix)
      .delete()
      .catch(() => {});
}
beforeAll(async () => {
  await cleanup();
  initDb(dbPath);
});
afterAll(async () => {
  closeDb();
  await cleanup();
});
beforeEach(async () => {
  await getDbClient().run("DELETE FROM agents");
  await getDbClient().run("DELETE FROM runtime_pools");
  await getDbClient().run("DELETE FROM runtime_controllers");
});

describe("runtime pools persistence", () => {
  test("pool caches default off, persist across edits, and can be disabled explicitly", async () => {
    const controller = await createRuntimeController({ name: "cache-controller", kind: "docker" });
    const base = {
      name: "cached-pool",
      kind: "docker" as const,
      placements: [controller.id],
      image: "worker:test",
    };
    const pool = await createRuntimePool(base);
    expect(pool.cache).toBeNull();
    expect((await updateRuntimePool(pool.id, { cache: { mountPath: "/cache" } })).cache).toEqual({
      mountPath: "/cache",
    });
    expect((await updateRuntimePool(pool.id, { name: "renamed-pool" })).cache).toEqual({
      mountPath: "/cache",
    });
    expect((await getRuntimePool(pool.id))?.cache).toEqual({ mountPath: "/cache" });
    expect((await updateRuntimePool(pool.id, { cache: null })).cache).toBeNull();
  });

  test("pool cache validation rejects unsafe mount paths and unsupported providers", async () => {
    const docker = await createRuntimeController({
      name: "docker-cache-validation",
      kind: "docker",
    });
    for (const mountPath of [
      "/",
      "//",
      "relative",
      "/cache/..",
      "/./cache",
      "/cache\0bad",
      "/home",
      "/home/worker",
      "/home/worker/",
      "//home//worker//",
      "/workspace",
      "/workspace/personal",
      "/workspace/shared",
      "/workspace/personal/cache",
      "//workspace//personal//cache/",
      "/workspace/shared/.cache",
      "/workspace/shared/repo/.git",
      "/root",
      "/home/worker/.codex",
      "/home/worker/.local/share/opencode",
      "/home/worker/.claude.json",
      "/home/worker/.ssh/keys",
      "/home/worker/.config/cache",
      "/root/.claude",
      "/root/.local/share/opencode/cache",
    ]) {
      await expect(
        createRuntimePool({
          name: "invalid-path",
          kind: "docker",
          placements: [docker.id],
          image: "worker:test",
          cache: { mountPath },
        }),
      ).rejects.toThrow("mountPath");
    }
    for (const kind of ["static", "e2b", "boxd"] as const) {
      const controller = await createRuntimeController({ name: `${kind}-cache-validation`, kind });
      await expect(
        createRuntimePool({
          name: "unsupported-cache",
          kind,
          placements: [controller.id],
          image: "worker:test",
          cache: { mountPath: "/cache" },
        }),
      ).rejects.toThrow("does not support persistent pool caches");
    }
    expect(await getDbClient().query("SELECT id FROM runtime_pools")).toEqual([]);
  });

  test("cache mount validation accepts isolated cache subdirectories", async () => {
    const controller = await createRuntimeController({ name: "safe-cache-paths", kind: "docker" });
    for (const [index, mountPath] of [
      "/cache",
      "/home/worker/.cache",
      "/home/worker/.cache/bun",
      "/workspace/cache",
      "/root/.cache",
      "/workspace/personal-cache",
    ].entries()) {
      const pool = await createRuntimePool({
        name: `safe-cache-${index}`,
        kind: "docker",
        placements: [controller.id],
        image: "worker:test",
        cache: { mountPath },
      });
      expect(pool.cache?.mountPath).toBe(mountPath);
    }
  });

  test("maps persisted task wake and agent provisioning state without changing routing", async () => {
    const agent = await createAgent({ name: "worker", status: "offline", isLead: false });
    expect(agent).toMatchObject({ runtimeProvisionAttempts: 0, runtimeProvisionRetryAt: null });
    const task = await createTaskExtended("wake task", {
      agentId: agent.id,
      routingReason: "human_pinned",
      routingNote: "keep-note",
    });
    expect(task.poolWakeAt).toBeUndefined();
    const at = new Date().toISOString();
    await getDbClient().run("UPDATE agent_tasks SET pool_wake_at = ? WHERE id = ?", [at, task.id]);
    await getDbClient().run(
      "UPDATE agents SET runtime_provision_attempts = 2, runtime_provision_retry_at = ? WHERE id = ?",
      [at, agent.id],
    );
    expect(await getTaskById(task.id)).toMatchObject({
      poolWakeAt: at,
      routingReason: "human_pinned",
      routingNote: "keep-note",
    });
    expect(await getAgentById(agent.id)).toMatchObject({
      runtimeProvisionAttempts: 2,
      runtimeProvisionRetryAt: at,
    });
  });
  test("controller reads isolate secrets encrypted under a different key", async () => {
    const healthy = await createRuntimeController({
      name: "healthy",
      kind: "e2b",
      secretConfig: { E2B_API_KEY: crypto.randomUUID() },
    });
    const broken = await createRuntimeController({ name: "broken", kind: "e2b" });
    const ciphertext = encryptSecret(
      JSON.stringify({ E2B_API_KEY: "unreadable-secret" }),
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
    );
    await getDbClient().run("UPDATE runtime_controllers SET secret_config = ? WHERE id = ?", [
      ciphertext,
      broken.id,
    ]);
    expect(await getRuntimeController(broken.id)).toMatchObject({
      secretConfigKeys: [],
      secretConfigError: true,
    });
    expect(await listRuntimeControllers()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: healthy.id, secretConfigKeys: ["E2B_API_KEY"] }),
        expect.objectContaining({ id: broken.id, secretConfigKeys: [], secretConfigError: true }),
      ]),
    );
    expect(await updateRuntimeController(broken.id, { name: "still-readable" })).toMatchObject({
      secretConfigError: true,
    });
    expect(await loadRuntimeControllerSecrets()).toEqual({ count: 1, failed: 1 });
    await expect(getRuntimeControllerSecrets(broken.id)).rejects.toThrow();
  });
  test("secret registration waits for commit and discards rolled back creates and updates", async () => {
    const secret = crypto.randomUUID() + crypto.randomUUID();
    const controllerId = crypto.randomUUID();
    await expect(
      getDbClient().transaction(async () => {
        await createRuntimeController(
          { name: "rollback", kind: "e2b", secretConfig: { E2B_API_KEY: secret } },
          null,
          controllerId,
        );
        expect(scrubSecrets(secret)).toBe(secret);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await getRuntimeController(controllerId)).toBeNull();
    expect(scrubSecrets(secret)).toBe(secret);
    const controller = await createRuntimeController({ name: "committed", kind: "e2b" });
    await expect(
      getDbClient().transaction(async () => {
        await updateRuntimeController(controller.id, { secretConfig: { E2B_API_KEY: secret } });
        expect(scrubSecrets(secret)).toBe(secret);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await getRuntimeControllerSecrets(controller.id)).toEqual({});
    expect(scrubSecrets(secret)).toBe(secret);
    await updateRuntimeController(controller.id, { secretConfig: { E2B_API_KEY: secret } });
    expect(scrubSecrets(secret)).not.toContain(secret);
  });
  test("static lifecycle, binding, protected deletion and forced unbinding", async () => {
    const controller = await createRuntimeController({ name: "static", kind: "static" });
    const pool = await createRuntimePool({
      name: "static",
      kind: "static",
      placements: [controller.id],
      lifecycle: "per-task",
      idleMinutes: 4,
    });
    expect(pool).toMatchObject({ lifecycle: "idle", idleMinutes: null, delivery: null });
    const agent = await createAgent({
      name: "worker",
      status: "offline",
      isLead: false,
      capabilities: [],
    });
    await bindAgentToPool(agent.id, pool.id);
    expect((await getAgentById(agent.id))?.runtimePoolId).toBe(pool.id);
    expect((await getPoolForAgent(agent.id))?.id).toBe(pool.id);
    expect((await listAgentsForPool(pool.id)).map((row) => row.id)).toEqual([agent.id]);
    await expect(deleteRuntimePool(pool.id)).rejects.toMatchObject({ status: 409 });
    await expect(deleteRuntimeController(controller.id)).rejects.toMatchObject({ status: 409 });
    await deleteRuntimePool(pool.id, true);
    expect((await getAgentById(agent.id))?.runtimePoolId).toBeNull();
    await deleteRuntimeController(controller.id);
  });
  test("validates controller kind, bounds and unsupported providers on create and update", async () => {
    const controller = await createRuntimeController({ name: "docker", kind: "docker" });
    const input = {
      name: "docker",
      kind: "docker" as const,
      placements: [controller.id],
      image: "agent-swarm-worker:test",
    };
    await expect(createRuntimePool({ ...input, image: null })).rejects.toThrow(
      "docker pools require an image",
    );
    await expect(createRuntimePool({ ...input, placements: [] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      createRuntimePool({ ...input, placements: [controller.id, controller.id] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(createRuntimePool({ ...input, slotsPerRuntime: 0 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      createRuntimePool({ ...input, maxRuntimes: 1, minRuntimes: 2 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(createRuntimePool({ ...input, kind: "e2b" })).rejects.toThrow(
      "Pool kind must equal controller kind",
    );
    await expect(createRuntimePool({ ...input, kind: "k8s" })).rejects.toThrow(
      "k8s provider not implemented",
    );
    await expect(createRuntimeController({ name: "k8s", kind: "k8s" })).rejects.toThrow(
      "k8s provider not implemented",
    );
    const pool = await createRuntimePool({ ...input, maxRuntimes: 3, minRuntimes: 2 });
    await expect(updateRuntimePool(pool.id, { maxRuntimes: 1 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(updateRuntimeController(controller.id, { kind: "e2b" })).rejects.toMatchObject({
      status: 400,
    });
    const updated = await updateRuntimePool(pool.id, {
      delivery: "push",
      env: { MODE: "test" },
      resources: { cpu: 2, memoryMb: 512 },
    });
    expect(updated).toMatchObject({
      delivery: "push",
      resources: { cpu: 2, memoryMb: 512 },
      env: { MODE: "test" },
    });
    expect(await getRuntimePool(pool.id)).toEqual(updated);
  });
  test("encrypts secrets, merges and removes keys, and restores scrubbing after a restart", async () => {
    const secret = crypto.randomUUID() + crypto.randomUUID();
    const controller = await createRuntimeController({
      name: "e2b",
      kind: "e2b",
      secretConfig: { E2B_API_KEY: secret },
    });
    expect(controller.secretConfigKeys).toEqual(["E2B_API_KEY"]);
    expect(JSON.stringify(controller)).not.toContain(secret);
    const stored = await getDbClient().get<{ secret_config: string }>(
      "SELECT secret_config FROM runtime_controllers WHERE id = ?",
      [controller.id],
    );
    expect(stored?.secret_config).not.toContain(secret);
    expect(await getRuntimeControllerSecrets(controller.id)).toEqual({ E2B_API_KEY: secret });
    const second = crypto.randomUUID() + crypto.randomUUID();
    expect(
      (await updateRuntimeController(controller.id, { secretConfig: { OTHER: second } }))
        .secretConfigKeys,
    ).toEqual(["E2B_API_KEY", "OTHER"]);
    expect(
      (await updateRuntimeController(controller.id, { secretConfig: { E2B_API_KEY: null } }))
        .secretConfigKeys,
    ).toEqual(["OTHER"]);
    clearVolatileSecretsForTesting();
    expect((await loadSecretRegistry()).runtimeController).toBe(1);
    expect(scrubSecrets(`credential: ${second}`)).not.toContain(second);
  });
  test("creates offline agents, preserves the template and refuses a second lead", async () => {
    const controller = await createRuntimeController({ name: "static", kind: "static" });
    const pool = await createRuntimePool({
      name: "static",
      kind: "static",
      placements: [controller.id],
    });
    const agent = await createPoolAgent(pool.id, {
      name: "lead",
      isLead: true,
      harnessProvider: "codex",
      maxTasks: 3,
      templateId: "official/coder",
    });
    expect(agent).toMatchObject({
      runtimePoolId: pool.id,
      status: "offline",
      harnessProvider: "codex",
      maxTasks: 3,
    });
    expect(
      (await getSwarmConfigs({ scope: "agent", scopeId: agent.id, key: "TEMPLATE_ID" }))[0]?.value,
    ).toBe("official/coder");
    expect(
      await getDbClient().get("SELECT id FROM runtime_instances WHERE agent_id = ?", [agent.id]),
    ).toBeNull();
    await expect(createPoolAgent(pool.id, { name: "lead2", isLead: true })).rejects.toMatchObject({
      status: 409,
    });
  });
});
