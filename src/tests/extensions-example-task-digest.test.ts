import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, getAllAgents, getScheduledTaskByName, initDb } from "../be/db";
import { validateBundle } from "../be/extensions/validate";
import { getScript } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { getCatalogEntry } from "../extensions/catalog";
import {
  disableExtension,
  enableExtension,
  installExtensionWithAssets,
  stopExtensionRuntime,
  uninstallExtension,
} from "../extensions/lifecycle";

const TEST_DB_PATH = "./test-extensions-example-task-digest.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

describe("task-digest example extension", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    setScriptEmbeddingProviderForTests({
      name: "test/noop-task-digest",
      dimensions: 1,
      async embed() {
        return null;
      },
      async embedBatch(texts: string[]) {
        return texts.map(() => null);
      },
    });
  });

  afterAll(async () => {
    await stopExtensionRuntime();
    setScriptEmbeddingProviderForTests(null);
    closeDb();
    await removeDbFiles();
  });

  test("installs from the catalog, runs its schedule while enabled, and uninstalls cleanly", async () => {
    const entry = getCatalogEntry("task-digest");
    expect(entry?.manifestFile).toBe("manifest.yaml");
    const validation = await validateBundle({ manifest: entry!.manifest, files: entry!.files });
    expect(validation.ok).toBe(true);

    const { extension, assets } = await installExtensionWithAssets({
      manifest: entry!.manifest,
      files: entry!.files,
    });
    expect(assets?.created).toEqual([
      { kind: "script", name: "task-digest-collect" },
      { kind: "schedule", name: "task-digest-daily" },
    ]);
    const agent = (await getAllAgents({ includeExtensions: true })).find(
      (candidate) => candidate.name === "ext:task-digest",
    );
    expect(
      (await getScript({ name: "task-digest-collect", scope: "global" }))?.createdByAgentId,
    ).toBe(agent?.id);
    expect((await getScheduledTaskByName("task-digest-daily"))?.enabled).toBe(false);

    await enableExtension(extension.id);
    const running = await getScheduledTaskByName("task-digest-daily");
    expect(running).toMatchObject({ enabled: true, cronExpression: "0 9 * * *", timezone: "UTC" });
    expect(new Date(running!.nextRunAt!).getUTCHours()).toBe(9);

    await disableExtension(extension.id);
    expect((await getScheduledTaskByName("task-digest-daily"))?.enabled).toBe(false);

    expect(await uninstallExtension(extension.id)).toEqual({
      deleted: [
        { kind: "schedule", name: "task-digest-daily" },
        { kind: "script", name: "task-digest-collect" },
      ],
      detached: [],
    });
    expect(await getScheduledTaskByName("task-digest-daily")).toBeNull();
    expect(await getScript({ name: "task-digest-collect", scope: "global" })).toBeNull();
  }, 60_000);
});
