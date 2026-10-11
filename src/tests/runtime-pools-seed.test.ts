import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbClient, initDb } from "../be/db";
import {
  deleteRuntimePool,
  getRuntimeController,
  getRuntimeControllerSecrets,
  getRuntimePool,
  listRuntimeControllers,
  listRuntimePools,
  resolvePoolDelivery,
  updateRuntimeController,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import { seedRuntimePools } from "../be/runtime-pools/seed";

const path = "./test-runtime-pools-seed.sqlite";
async function cleanup() {
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(path + suffix)
      .delete()
      .catch(() => {});
}
beforeAll(async () => {
  await cleanup();
  initDb(path);
});
afterAll(async () => {
  closeDb();
  await cleanup();
});
beforeEach(async () => {
  await getDbClient().run("DELETE FROM runtime_pools");
  await getDbClient().run("DELETE FROM runtime_controllers");
  await getDbClient().run("DELETE FROM seed_state WHERE key = 'runtime-pools-default-static'");
});
test("disabled seed leaves entities absent", async () => {
  await seedRuntimePools({ RUNTIME_POOLS_ENABLED: "false" });
  expect(await listRuntimePools()).toEqual([]);
  expect(await listRuntimeControllers()).toEqual([]);
});
test("seed is idempotent and preserves operator edits and secrets", async () => {
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const env = {
    RUNTIME_POOLS_ENABLED: "true",
    RUNTIME_DOCKER_HOST: "unix:///tmp/test.sock",
    E2B_API_KEY: secret,
    RUNTIME_WORKER_API_URL: "https://swarm.test",
  };
  await seedRuntimePools(env);
  expect((await listRuntimeControllers()).map((row) => row.id).sort()).toEqual([
    "builtin-docker",
    "builtin-e2b",
    "builtin-static",
  ]);
  expect(await getRuntimeController("builtin-e2b")).toMatchObject({
    status: "online",
    secretConfigKeys: ["E2B_API_KEY"],
  });
  expect(await getRuntimeControllerSecrets("builtin-e2b")).toEqual({ E2B_API_KEY: secret });
  expect(await getRuntimePool("default-static")).toMatchObject({
    delivery: null,
    lifecycle: "idle",
    placements: ["builtin-static"],
  });
  await updateRuntimeController("builtin-docker", {
    name: "edited",
    config: { DOCKER_NETWORK: "operator-net" },
  });
  const operatorSecret = crypto.randomUUID() + crypto.randomUUID();
  await updateRuntimeController("builtin-e2b", { secretConfig: { E2B_API_KEY: operatorSecret } });
  await updateRuntimePool("default-static", { name: "edited-static", enabled: false });
  await seedRuntimePools(env);
  expect((await listRuntimeControllers()).length).toBe(3);
  expect(await getRuntimeController("builtin-docker")).toMatchObject({
    name: "edited",
    config: { DOCKER_NETWORK: "operator-net" },
  });
  expect(await getRuntimeControllerSecrets("builtin-e2b")).toEqual({ E2B_API_KEY: operatorSecret });
  expect(await getRuntimePool("default-static")).toMatchObject({
    name: "edited-static",
    enabled: false,
  });
});
test("boot refreshes status and fills absent env keys without overwriting stored keys", async () => {
  const env = { RUNTIME_POOLS_ENABLED: "true", PUBLIC_MCP_BASE_URL: "https://swarm.test" };
  await seedRuntimePools(env);
  const secret = crypto.randomUUID() + crypto.randomUUID();
  await seedRuntimePools({ ...env, E2B_API_KEY: secret });
  expect(await getRuntimeController("builtin-e2b")).toMatchObject({ status: "online" });
  expect(await getRuntimeControllerSecrets("builtin-e2b")).toEqual({ E2B_API_KEY: secret });
  await seedRuntimePools({ ...env, E2B_API_KEY: "different-env-key" });
  expect(await getRuntimeControllerSecrets("builtin-e2b")).toEqual({ E2B_API_KEY: secret });
  await seedRuntimePools(env);
  expect(await getRuntimeControllerSecrets("builtin-e2b")).toEqual({ E2B_API_KEY: secret });
  await updateRuntimeController("builtin-e2b", { secretConfig: { E2B_API_KEY: null } });
  await getDbClient().run(
    "UPDATE runtime_controllers SET status = 'offline' WHERE id = 'builtin-static'",
  );
  await seedRuntimePools(env);
  expect(await getRuntimeController("builtin-e2b")).toMatchObject({ status: "offline" });
  expect(await getRuntimeController("builtin-static")).toMatchObject({ status: "online" });
});
test("E2B seeding records an HTTPS configuration error even with a key", async () => {
  await seedRuntimePools({
    RUNTIME_POOLS_ENABLED: "true",
    E2B_API_KEY: crypto.randomUUID(),
    RUNTIME_WORKER_API_URL: "http://swarm.test",
  });
  expect(await getRuntimeController("builtin-e2b")).toMatchObject({
    status: "offline",
    lastError: expect.stringContaining("HTTPS"),
  });
});
test("docker status follows reachability on every boot", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("OK") });
  const env = { RUNTIME_POOLS_ENABLED: "true", RUNTIME_DOCKER_HOST: server.url.origin };
  try {
    await seedRuntimePools(env);
    expect(await getRuntimeController("builtin-docker")).toMatchObject({ status: "online" });
    server.stop(true);
    await seedRuntimePools(env);
    expect(await getRuntimeController("builtin-docker")).toMatchObject({ status: "offline" });
    await seedRuntimePools({ RUNTIME_POOLS_ENABLED: "true" });
    expect(await getRuntimeController("builtin-docker")).toMatchObject({ kind: "docker" });
  } finally {
    server.stop(true);
  }
});
test("a deleted default pool stays deleted after restart, even when no pools remain", async () => {
  const env = { RUNTIME_POOLS_ENABLED: "true" };
  await seedRuntimePools(env);
  await deleteRuntimePool("default-static");
  await seedRuntimePools(env);
  expect(await listRuntimePools()).toEqual([]);
});
test("e2b without a key is offline, and delivery resolves at call time", async () => {
  await seedRuntimePools({ RUNTIME_POOLS_ENABLED: "true" });
  expect(await getRuntimeController("builtin-e2b")).toMatchObject({
    status: "offline",
    secretConfigKeys: [],
  });
  expect(resolvePoolDelivery({ delivery: null }, {})).toBe("poll");
  expect(resolvePoolDelivery({ delivery: null }, { RUNTIME_DEFAULT_DELIVERY: "push" })).toBe(
    "push",
  );
  expect(resolvePoolDelivery({ delivery: "poll" }, { RUNTIME_DEFAULT_DELIVERY: "push" })).toBe(
    "poll",
  );
});

describe("runtime pool Docker seed", () => {
  test("DOCKER_HOST seeds an online controller through a Unix socket", async () => {
    const socket = join(tmpdir(), `seed-${crypto.randomUUID().slice(0, 16)}.sock`);
    const requests: string[] = [];
    const server = Bun.serve({
      unix: socket,
      fetch(req) {
        requests.push(new URL(req.url).pathname);
        return new Response("OK");
      },
    });
    try {
      await seedRuntimePools({ RUNTIME_POOLS_ENABLED: "true", DOCKER_HOST: `unix://${socket}` });
      expect(requests).toEqual(["/_ping"]);
      expect(await getRuntimeController("builtin-docker")).toMatchObject({
        status: "online",
        config: {},
      });
    } finally {
      await server.stop(true);
      await Bun.file(socket)
        .delete()
        .catch(() => {});
    }
  });

  test("RUNTIME_DOCKER_HOST overrides DOCKER_HOST and preserves offline seeding", async () => {
    const missing = `unix://${join(tmpdir(), `seed-${crypto.randomUUID()}.sock`)}`;
    await seedRuntimePools({
      RUNTIME_POOLS_ENABLED: "true",
      RUNTIME_DOCKER_HOST: missing,
      DOCKER_HOST: "tcp://unsupported:2375",
    });
    expect(await getRuntimeController("builtin-docker")).toMatchObject({
      status: "offline",
      config: { DOCKER_HOST: missing },
    });
  });

  test("DOCKER_HOST rejects regular files and unsupported hosts", async () => {
    const file = join(tmpdir(), `seed-${crypto.randomUUID()}.txt`);
    await Bun.write(file, "not a socket");
    try {
      for (const host of [`unix://${file}`, `${file}`, "unix://", "tcp://unsupported:2375"])
        await seedRuntimePools({ RUNTIME_POOLS_ENABLED: "true", DOCKER_HOST: host });
      expect(await getRuntimeController("builtin-docker")).toBeNull();
    } finally {
      await Bun.file(file).delete();
    }
  });
});
