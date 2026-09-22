import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, getDbClient, initDb } from "../be/db";
import {
  deleteExtension,
  ExtensionOwnershipError,
  getExtensionById,
  getExtensionFiles,
  getExtensionVersion,
  insertExtensionRun,
  installExtension,
  listExtensionRuns,
  listExtensionVersions,
  pruneExtensionRuns,
  setExtensionState,
  updateExtensionMeta,
} from "../be/extensions/db";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-db.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

describe("extension DB helpers", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    await getDbClient().run("DELETE FROM extensions");
  });

  test("install creates version 1 and one active file", async () => {
    const bundle = await loadBundleFixture("minimal");
    const result = await installExtension({
      ...bundle,
      agentId: "lead-1",
      createdBy: "user-1",
    });

    expect(result.isNew).toBe(true);
    expect(result.contentDeduped).toBe(false);
    expect(result.extension.version).toBe(1);
    expect(result.extension.activeVersion).toBe(1);
    expect(result.extension.enabled).toBe(false);
    expect(await getExtensionFiles(result.extension.id)).toEqual(bundle.files);
    expect((await listExtensionVersions(result.extension.id)).map((row) => row.version)).toEqual([
      1,
    ]);
    expect(
      (
        await getDbClient().get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM extension_files WHERE extensionId = ?",
          [result.extension.id],
        )
      )?.count,
    ).toBe(1);
  });

  test("concurrent worker installs cannot take ownership of the same name", async () => {
    const bundle = await loadBundleFixture("minimal");
    const results = await Promise.allSettled(
      ["worker-a", "worker-b"].map((agentId) =>
        installExtension({ ...bundle, agentId, ownerOnly: agentId }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      ExtensionOwnershipError,
    );
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("missing winning install");
    expect(await listExtensionVersions(winner.value.extension.id)).toHaveLength(1);
  });

  test("worker metadata writes and deletion recheck disabled ownership at the database write", async () => {
    const installed = await installExtension({
      ...(await loadBundleFixture("minimal")),
      agentId: "owner",
    });
    const id = installed.extension.id;
    await expect(
      updateExtensionMeta(id, { priority: 7, ownerOnly: "other" }),
    ).rejects.toBeInstanceOf(ExtensionOwnershipError);
    await expect(deleteExtension(id, "other")).rejects.toBeInstanceOf(ExtensionOwnershipError);
    await setExtensionState(id, { enabled: true, status: "enabled" });
    await expect(
      updateExtensionMeta(id, { priority: 7, ownerOnly: "owner" }),
    ).rejects.toBeInstanceOf(ExtensionOwnershipError);
    await expect(deleteExtension(id, "owner")).rejects.toBeInstanceOf(ExtensionOwnershipError);
    expect(await getExtensionById(id)).toMatchObject({ enabled: true, priority: 100 });
    await setExtensionState(id, { enabled: false, status: "disabled" });
    expect(await updateExtensionMeta(id, { priority: 7, ownerOnly: "owner" })).toMatchObject({
      priority: 7,
    });
    expect(await deleteExtension(id, "owner")).toBe(true);
  });

  test("matching bundles dedupe and changed hooks create a complete snapshot", async () => {
    const bundle = await loadBundleFixture("minimal");
    const first = await installExtension(bundle);
    const same = await installExtension(bundle);
    expect(same.contentDeduped).toBe(true);
    expect(same.extension.version).toBe(1);

    const changedFiles = {
      ...bundle.files,
      "hooks.ts": `${bundle.files["hooks.ts"]}\n// version 2\n`,
    };
    const changed = await installExtension({
      manifest: bundle.manifest,
      files: changedFiles,
      changeReason: "Change hooks",
    });
    expect(changed.contentDeduped).toBe(false);
    expect(changed.extension.id).toBe(first.extension.id);
    expect(changed.extension.version).toBe(2);
    expect(await getExtensionFiles(changed.extension.id)).toEqual(changedFiles);

    const versions = await listExtensionVersions(changed.extension.id);
    expect(versions.map((row) => row.version)).toEqual([2, 1]);
    expect(JSON.parse(versions[0]!.filesJson)).toEqual(changedFiles);
    expect(JSON.parse(versions[1]!.filesJson)).toEqual(bundle.files);
    expect((await getExtensionVersion(changed.extension.id, 2))?.changeReason).toBe("Change hooks");
  });

  test("manifest-only changes create a version with a complete snapshot", async () => {
    const bundle = await loadBundleFixture("minimal");
    const first = await installExtension(bundle);
    const manifest = { ...bundle.manifest, description: "Changed manifest description" };
    const changed = await installExtension({ manifest, files: bundle.files });

    expect(changed.contentDeduped).toBe(false);
    expect(changed.extension.id).toBe(first.extension.id);
    expect(changed.extension.version).toBe(2);
    const versions = await listExtensionVersions(first.extension.id);
    expect(versions.map((row) => row.version)).toEqual([2, 1]);
    expect(JSON.parse(versions[0]!.manifestJson)).toEqual(manifest);
    expect(JSON.parse(versions[1]!.manifestJson)).toEqual(bundle.manifest);
    expect(JSON.parse(versions[0]!.filesJson)).toEqual(bundle.files);
    expect(JSON.parse(versions[1]!.filesJson)).toEqual(bundle.files);
  });

  test("identical content can activate the current version without creating another version", async () => {
    const bundle = await loadBundleFixture("minimal");
    const first = await installExtension(bundle);
    const files = { ...bundle.files, "hooks.ts": `${bundle.files["hooks.ts"]}\n// version 2\n` };
    const changed = await installExtension({ manifest: bundle.manifest, files });
    expect(changed.extension).toMatchObject({ version: 2, activeVersion: 1 });

    const activated = await installExtension({ manifest: bundle.manifest, files, activate: true });
    expect(activated.contentDeduped).toBe(true);
    expect(activated.extension).toMatchObject({ version: 2, activeVersion: 2 });
    expect((await getExtensionById(first.extension.id))?.activeVersion).toBe(2);
    expect(await listExtensionVersions(first.extension.id)).toHaveLength(2);
  });

  test("concurrent changed installs allocate distinct versions atomically", async () => {
    const bundle = await loadBundleFixture("minimal");
    const first = await installExtension(bundle);
    const changedA = { ...bundle.files, "hooks.ts": `${bundle.files["hooks.ts"]}\n// A\n` };
    const changedB = { ...bundle.files, "hooks.ts": `${bundle.files["hooks.ts"]}\n// B\n` };

    const results = await Promise.all([
      installExtension({ manifest: bundle.manifest, files: changedA }),
      installExtension({ manifest: bundle.manifest, files: changedB }),
    ]);

    expect(results.map((result) => result.extension.version).sort()).toEqual([2, 3]);
    const versions = await listExtensionVersions(first.extension.id);
    expect(versions.map((row) => row.version)).toEqual([3, 2, 1]);
    expect(await getExtensionFiles(first.extension.id)).toEqual(JSON.parse(versions[0]!.filesJson));
  });

  test("metadata and state updates preserve the stored bundle", async () => {
    const installed = await installExtension(await loadBundleFixture("minimal"));
    const updated = await updateExtensionMeta(installed.extension.id, {
      priority: 10,
      config: { channelId: "C1" },
      description: "Updated description",
    });
    expect(updated?.priority).toBe(10);
    expect(updated?.configJson).toBe('{"channelId":"C1"}');
    expect(updated?.description).toBe("Updated description");

    const enabled = await setExtensionState(installed.extension.id, {
      enabled: true,
      status: "enabled",
      consecutiveFailures: 2,
      lastError: "test error",
    });
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.status).toBe("enabled");
    expect(enabled?.consecutiveFailures).toBe(2);
    expect(enabled?.lastError).toBe("test error");
  });

  test("run logs retain only the newest 500 rows", async () => {
    const installed = await installExtension(await loadBundleFixture("minimal"));
    for (let index = 0; index < 505; index++) {
      await insertExtensionRun({
        extensionId: installed.extension.id,
        version: 1,
        event: "pre.task.create",
        action: "continue",
        message: String(index),
      });
    }
    expect(
      (
        await getDbClient().get<{ count: number }>(
          "SELECT count(*) AS count FROM extension_runs WHERE extensionId = ?",
          [installed.extension.id],
        )
      )?.count,
    ).toBe(505);
    await pruneExtensionRuns(installed.extension.id);
    expect(
      (
        await getDbClient().get<{ count: number }>(
          "SELECT count(*) AS count FROM extension_runs WHERE extensionId = ?",
          [installed.extension.id],
        )
      )?.count,
    ).toBe(500);
    const rows = await listExtensionRuns(installed.extension.id, 500);
    expect(rows).toHaveLength(500);
    expect(rows[0]?.message).toBe("504");
    expect(rows.at(-1)?.message).toBe("5");
  });

  test("delete cascades extension children", async () => {
    const installed = await installExtension(await loadBundleFixture("minimal"));
    await insertExtensionRun({
      extensionId: installed.extension.id,
      version: 1,
      event: "post.task.created",
      action: "continue",
    });
    expect(await deleteExtension(installed.extension.id)).toBe(true);
    expect(await getExtensionById(installed.extension.id)).toBeNull();
    expect(await listExtensionVersions(installed.extension.id)).toEqual([]);
    expect(await listExtensionRuns(installed.extension.id)).toEqual([]);
  });
});
