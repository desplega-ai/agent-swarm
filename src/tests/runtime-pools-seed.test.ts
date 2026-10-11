import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { closeDb, getDbClient, initDb } from "../be/db";
import {
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
  await updateRuntimeController("builtin-e2b", { secretConfig: { E2B_API_KEY: null } });
  await updateRuntimePool("default-static", { name: "edited-static", enabled: false });
  await seedRuntimePools(env);
  expect((await listRuntimeControllers()).length).toBe(3);
  expect(await getRuntimeController("builtin-docker")).toMatchObject({
    name: "edited",
    config: { DOCKER_NETWORK: "operator-net" },
  });
  expect(await getRuntimeControllerSecrets("builtin-e2b")).toEqual({});
  expect(await getRuntimePool("default-static")).toMatchObject({
    name: "edited-static",
    enabled: false,
  });
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
