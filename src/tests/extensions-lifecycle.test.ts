import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, createTaskExtended, getAllAgents, getDbClient, getKv, initDb } from "../be/db";
import type { InstallExtensionArgs as ExtensionInstallBody } from "../be/extensions/db";
import {
  getExtensionById,
  installExtension,
  listExtensionRuns,
  setExtensionState,
} from "../be/extensions/db";
import { dispatchPre, listRegistered } from "../extensions/dispatcher";
import {
  activateVersion,
  disableExtension,
  enableExtension,
  loadEnabledExtensions,
  stopExtensionRuntime,
} from "../extensions/lifecycle";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-lifecycle.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function install(bundle: ExtensionInstallBody) {
  return (await installExtension(bundle)).extension;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out while waiting for extension event");
    await Bun.sleep(20);
  }
}

describe("extension lifecycle", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    await stopExtensionRuntime();
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    await stopExtensionRuntime();
    const client = getDbClient();
    await client.run("DELETE FROM agent_tasks");
    await client.run("DELETE FROM extensions");
    await client.run("DELETE FROM kv_entries");
  });

  test("enable creates an offline extension agent and disable unregisters", async () => {
    const extension = await install(await loadBundleFixture("minimal"));
    const enabled = await enableExtension(extension.id);
    expect(enabled).toMatchObject({ enabled: true, status: "enabled" });
    expect(listRegistered().map((loaded) => loaded.record.id)).toEqual([extension.id]);

    const agent = (await getAllAgents({ includeExtensions: true })).find(
      (candidate) => candidate.name === "ext:minimal",
    );
    expect(agent).toMatchObject({
      id: enabled.agentId,
      status: "offline",
      role: "extension",
      description: "System agent for extension minimal",
      maxTasks: 0,
    });

    expect(await disableExtension(extension.id)).toMatchObject({
      enabled: false,
      status: "disabled",
    });
    expect(listRegistered()).toHaveLength(0);
  });

  test("activation loads its immutable snapshot, not a concurrently advanced file projection", async () => {
    const extension = await install(await loadBundleFixture("minimal"));
    // Simulate a worker draft replacing the mutable files after activation read its row.
    await getDbClient().run("UPDATE extension_files SET content = ? WHERE extensionId = ?", [
      'throw new Error("unapproved draft executed");',
      extension.id,
    ]);
    const enabled = await enableExtension(extension.id);
    expect(enabled).toMatchObject({ enabled: true, activeVersion: 1 });
    expect(
      await dispatchPre("pre.task.create", {
        options: {},
        description: "snapshot check",
        origin: "rest",
      }),
    ).toEqual({ action: "continue" });
  });

  test("activate-version swaps source and reloads an enabled extension", async () => {
    const bundle = await loadBundleFixture("priority-a");
    const extension = await install(bundle);
    await enableExtension(extension.id);

    const versionTwo: ExtensionInstallBody = {
      manifest: bundle.manifest,
      files: {
        "hooks.ts": `
import { block, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => block("version two"));
};
export default extension;
`,
      },
    };
    await installExtension(versionTwo);

    expect(await activateVersion(extension.id, 2)).toMatchObject({
      activeVersion: 2,
      enabled: true,
    });
    expect(
      await dispatchPre("pre.task.create", {
        options: {},
        description: "start",
        origin: "rest",
      }),
    ).toMatchObject({ action: "block", reason: "version two" });

    expect(await activateVersion(extension.id, 1)).toMatchObject({
      activeVersion: 1,
      enabled: true,
    });
    expect(
      await dispatchPre("pre.task.create", {
        options: {},
        description: "start",
        origin: "rest",
      }),
    ).toEqual({ action: "modify", data: { description: "starta" } });
  });

  test("boot loads enabled rows and continues after one load error", async () => {
    const valid = await install(await loadBundleFixture("post-logger"));
    const invalidBundle = await loadBundleFixture("minimal");
    invalidBundle.manifest = { ...invalidBundle.manifest, name: "boot-invalid" };
    invalidBundle.files["hooks.ts"] = "export const invalid = true;";
    const invalid = await install(invalidBundle);
    await setExtensionState(valid.id, { enabled: true, status: "enabled" });
    await setExtensionState(invalid.id, { enabled: true, status: "enabled" });

    await loadEnabledExtensions();

    expect(listRegistered().map((loaded) => loaded.record.id)).toEqual([valid.id]);
    expect(await getExtensionById(invalid.id)).toMatchObject({ enabled: true, status: "error" });
    expect(await listExtensionRuns(invalid.id)).toMatchObject([{ action: "load-error" }]);

    await createTaskExtended("boot-loaded extension test", { source: "api" });
    await waitFor(async () =>
      (await listExtensionRuns(valid.id)).some(
        (run) => run.event === "post.task.created" && run.action === "continue",
      ),
    );
  });

  test("the post bridge dispatches post.task.created after commit", async () => {
    const extension = await install(await loadBundleFixture("post-logger"));
    const enabled = await enableExtension(extension.id);
    await createTaskExtended("extension post bridge test", { source: "api" });

    await waitFor(async () =>
      (await listExtensionRuns(extension.id)).some(
        (run) => run.event === "post.task.created" && run.action === "continue",
      ),
    );
    expect(await getExtensionById(extension.id)).toMatchObject({
      enabled: true,
      consecutiveFailures: 0,
    });
    expect(await getKv(`task:agent:${enabled.agentId}`, "ext:post-logger:created")).toMatchObject({
      value: 1,
    });
  });

  test("five post handler failures auto-disable and re-enable resets the counter", async () => {
    const extension = await install(await loadBundleFixture("throws"));
    await enableExtension(extension.id);

    for (let index = 0; index < 5; index += 1) {
      await createTaskExtended(`throwing extension test ${index}`, { source: "api" });
      await waitFor(
        async () => (await getExtensionById(extension.id))!.consecutiveFailures > index,
      );
    }

    expect(await getExtensionById(extension.id)).toMatchObject({
      enabled: false,
      status: "auto-disabled",
      consecutiveFailures: 5,
    });
    expect(listRegistered()).toHaveLength(0);
    expect(await enableExtension(extension.id)).toMatchObject({
      enabled: true,
      status: "enabled",
      consecutiveFailures: 0,
    });
  });

  test("the post bridge skips the extension that created a task", async () => {
    const first = await install(await loadBundleFixture("post-logger"));
    const secondBundle = await loadBundleFixture("post-logger");
    secondBundle.manifest = { ...secondBundle.manifest, name: "other-logger" };
    const second = await install(secondBundle);
    const creator = await enableExtension(first.id);
    await enableExtension(second.id);
    await createTaskExtended("extension-created task", {
      source: "api",
      creatorAgentId: creator.agentId!,
    });
    await waitFor(async () => (await listExtensionRuns(second.id)).length > 0);
    expect(await listExtensionRuns(first.id)).toEqual([]);
    expect(await listExtensionRuns(second.id)).toMatchObject([{ action: "continue" }]);
  });
});
