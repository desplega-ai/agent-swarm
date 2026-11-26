import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  getScriptApiConnectionDescriptors,
  getScriptMcpConnectionDescriptors,
  loadScriptConnectionCatalog,
  setScriptConnectionEnabled,
  upsertScriptConnection,
} from "../be/script-connections";
import { getStorage } from "../be/storage";

const TEST_DB_PATH = "./test-script-connection-catalog-cache.sqlite";

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

beforeAll(async () => {
  await removeDbFiles();
  closeDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

test("script runs share one cached connection catalog until a connection write", async () => {
  const connection = await upsertScriptConnection({
    slug: "catalogCache",
    kind: "graphql",
    baseUrl: "https://catalog.vendor.test/graphql",
    allowedHosts: ["catalog.vendor.test"],
  });
  // The run endpoints load the catalog once and pass it to both loaders.
  const loadForRun = async () => {
    const catalog = await loadScriptConnectionCatalog();
    const api = await getScriptApiConnectionDescriptors({}, catalog);
    await getScriptMcpConnectionDescriptors({}, catalog);
    return api.map((descriptor) => descriptor.slug);
  };
  const listConnections = spyOn(getStorage().repos.scripts, "listConnectionCatalog");
  try {
    const [first, second] = await Promise.all([loadForRun(), loadForRun()]);
    expect(await loadForRun()).toEqual(first);
    expect(first).toContain("catalogCache");
    expect(second).toEqual(first);
    // The upsert above dropped the cache, so this one query is the positive control.
    expect(listConnections).toHaveBeenCalledTimes(1);

    await setScriptConnectionEnabled(connection.id, false);
    expect(await loadForRun()).not.toContain("catalogCache");
    expect(listConnections).toHaveBeenCalledTimes(2);
  } finally {
    listConnections.mockRestore();
  }
});
