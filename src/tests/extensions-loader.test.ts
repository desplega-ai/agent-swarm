import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, getDbClient, initDb } from "../be/db";
import { getExtensionById, installExtension, listExtensionRuns } from "../be/extensions/db";
import {
  cleanExtensionTmpRoot,
  EXTENSIONS_TMP_ROOT,
  type LoadableExtension,
  loadExtension,
} from "../extensions/loader";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-loader.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function installLoadable(name: string, priority?: number): Promise<LoadableExtension> {
  const bundle = await loadBundleFixture(name);
  const installed = await installExtension({ ...bundle, priority });
  return { record: installed.extension, ...bundle };
}

describe("extension loader", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    await cleanExtensionTmpRoot();
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    await cleanExtensionTmpRoot();
    await getDbClient().run("DELETE FROM extensions");
  });

  test("imports hooks and exposes registered handlers", async () => {
    const loaded = await loadExtension(await installLoadable("minimal", 17));
    expect(EXTENSIONS_TMP_ROOT.endsWith(`/swarm-extensions/${process.pid}`)).toBe(true);
    expect(loaded.handlers).toHaveLength(1);
    expect(loaded.handlers[0]).toMatchObject({ event: "pre.task.create", priority: 17 });
    expect(await Bun.file(loaded.sourcePath).exists()).toBe(true);
    await loaded.dispose();
    expect(await Bun.file(loaded.sourcePath).exists()).toBe(false);
  });

  test("defensively rejects file traversal before writing bundle files", async () => {
    const input = await installLoadable("minimal");
    input.files["../escape.ts"] = "export default () => {};";
    await expect(loadExtension(input)).rejects.toThrow("Unsafe bundle file path");
    expect((await getExtensionById(input.record.id))?.status).toBe("error");
  });

  test("records a load error when hooks have no default export", async () => {
    const bundle = await loadBundleFixture("minimal");
    bundle.manifest = { ...bundle.manifest, name: "missing-default" };
    bundle.files["hooks.ts"] = "export const value = 1;";
    const installed = await installExtension(bundle);

    await expect(loadExtension({ record: installed.extension, ...bundle })).rejects.toThrow(
      "default function",
    );
    expect((await getExtensionById(installed.extension.id))?.status).toBe("error");
    expect(await listExtensionRuns(installed.extension.id)).toMatchObject([
      { action: "load-error", event: "load" },
    ]);
  });

  test("removes the previous content-hash directory after a successful import", async () => {
    const bundle = await loadBundleFixture("minimal");
    const first = await installExtension(bundle);
    const firstLoaded = await loadExtension({ record: first.extension, ...bundle });
    expect(await Bun.file(firstLoaded.sourcePath).exists()).toBe(true);

    const files = { ...bundle.files, "hooks.ts": `${bundle.files["hooks.ts"]}\n// v2\n` };
    const second = await installExtension({ ...bundle, files, activate: true });
    const secondLoaded = await loadExtension({
      record: second.extension,
      manifest: bundle.manifest,
      files,
    });

    expect(await Bun.file(firstLoaded.sourcePath).exists()).toBe(false);
    expect(await Bun.file(secondLoaded.sourcePath).exists()).toBe(true);
    await secondLoaded.dispose();
  });
});
