import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  closeDb,
  createScheduledTask,
  getAllAgents,
  getDbClient,
  getScheduledTaskByName,
  initDb,
  updateScheduledTask,
} from "../be/db";
import { ExtensionAssetConflictError } from "../be/extensions/assets";
import { getExtensionById, getExtensionByName } from "../be/extensions/db";
import { getScript, upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { dispatchPre, listRegistered } from "../extensions/dispatcher";
import {
  activateVersion,
  disableExtension,
  enableExtension,
  installExtensionWithAssets,
  stopExtensionRuntime,
  uninstallExtension,
} from "../extensions/lifecycle";
import { dispatchScheduleTarget } from "../scheduler/scheduler";
import * as scriptLoader from "../scripts-runtime/loader";
import type { ExtensionManifest } from "../types";

const TEST_DB_PATH = "./test-extensions-assets.sqlite";

const HOOKS = `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = () => {};
export default extension;
`;
const THROWING_HOOKS = `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => {
    throw new Error("digest hook failure");
  });
};
export default extension;
`;
const SCRIPT =
  "export default async function collect(args: any) {\n  return { ok: true, args };\n}\n";
const EDITED_SCRIPT = "export default async function collect() {\n  return { edited: true };\n}\n";

type Bundle = { manifest: ExtensionManifest; files: Record<string, string> };

function bundle(
  opts: {
    schedule?: boolean;
    weekly?: boolean;
    hooks?: string;
    script?: string;
    version?: string;
    scheduleDescription?: string;
  } = {},
): Bundle {
  return {
    manifest: {
      name: "digest",
      description: "Digest",
      version: opts.version ?? "1.0.0",
      runtime: "api",
      assets: {
        hooks: "hooks.ts",
        scripts: [{ name: "digest-collect", file: "scripts/collect.ts", description: "Collect" }],
        ...(opts.schedule === false
          ? {}
          : {
              schedules: [
                {
                  name: "digest-daily",
                  ...(opts.scheduleDescription ? { description: opts.scheduleDescription } : {}),
                  script: "digest-collect",
                  cronExpression: "0 9 * * *",
                  args: { hours: 24 },
                },
                ...(opts.weekly
                  ? [
                      {
                        name: "digest-weekly",
                        script: "digest-collect",
                        cronExpression: "0 9 * * 1",
                      },
                    ]
                  : []),
              ],
            }),
      },
    },
    files: { "hooks.ts": opts.hooks ?? HOOKS, "scripts/collect.ts": opts.script ?? SCRIPT },
  };
}

async function install(b: Bundle = bundle(), activate = false) {
  return await installExtensionWithAssets({ ...b, activate });
}

async function assetRows() {
  return await getDbClient().query<{ kind: string; name: string; enabledBefore: number | null }>(
    "SELECT kind, name, enabledBefore FROM extension_assets ORDER BY kind, name",
  );
}

async function extAgentId(): Promise<string | undefined> {
  return (await getAllAgents({ includeExtensions: true })).find(
    (agent) => agent.name === "ext:digest",
  )?.id;
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

describe("extension assets", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    setScriptEmbeddingProviderForTests({
      name: "test/noop-extension-assets",
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

  beforeEach(async () => {
    await stopExtensionRuntime();
    const client = getDbClient();
    await client.run("DELETE FROM extensions");
    await client.run("DELETE FROM scheduled_tasks");
    await client.run("DELETE FROM scripts");
    await client.run("DELETE FROM agents WHERE name LIKE 'ext:%'");
  });

  test("install creates the script and a disabled schedule owned by the extension agent", async () => {
    const result = await install();
    expect(result.assets?.created).toEqual([
      { kind: "script", name: "digest-collect" },
      { kind: "schedule", name: "digest-daily" },
    ]);
    const agentId = await extAgentId();
    expect(agentId).toBeDefined();

    const script = await getScript({ name: "digest-collect", scope: "global" });
    expect(script).toMatchObject({ createdByAgentId: agentId, typeChecked: true });
    const schedule = await getScheduledTaskByName("digest-daily");
    expect(schedule).toMatchObject({
      enabled: false,
      targetType: "script",
      scriptName: "digest-collect",
      scriptArgs: { hours: 24 },
      createdByAgentId: agentId,
      timezone: "UTC",
    });
    expect(schedule?.nextRunAt).toBeUndefined();
    expect(await assetRows()).toEqual([
      { kind: "schedule", name: "digest-daily", enabledBefore: 1 },
      { kind: "script", name: "digest-collect", enabledBefore: null },
    ]);

    // Reinstalling the same content is a no-op for assets.
    const again = await install();
    expect(again.contentDeduped).toBe(true);
    expect(again.assets).toMatchObject({ created: [], updated: [], skipped: [] });
  });

  test("a script that fails its typecheck writes nothing", async () => {
    await expect(
      install(
        bundle({
          script: "export default async function collect(): Promise<number> { return 'x'; }\n",
        }),
      ),
    ).rejects.toThrow("script digest-collect");
    expect(await getExtensionByName("digest")).toBeNull();
    expect(await getScript({ name: "digest-collect", scope: "global" })).toBeNull();
    expect(await assetRows()).toEqual([]);
  });

  test("a name collision with a foreign schedule fails and writes nothing", async () => {
    await createScheduledTask({
      name: "digest-daily",
      intervalMs: 60_000,
      taskTemplate: "someone else's",
    });
    await expect(install()).rejects.toThrow(
      'schedule "digest-daily" already exists and does not belong to this extension',
    );
    expect(await getExtensionByName("digest")).toBeNull();
    expect(await getScript({ name: "digest-collect", scope: "global" })).toBeNull();
    expect(await extAgentId()).toBeUndefined();
  });

  test("enable turns the schedule on, disable pauses it, and a user's choice survives", async () => {
    const { extension } = await install();
    await enableExtension(extension.id);
    let schedule = await getScheduledTaskByName("digest-daily");
    expect(schedule?.enabled).toBe(true);
    expect(schedule?.nextRunAt).toBeString();

    await disableExtension(extension.id);
    schedule = await getScheduledTaskByName("digest-daily");
    expect(schedule?.enabled).toBe(false);
    expect(schedule?.nextRunAt).toBeUndefined();

    // Enable, then the user turns the schedule off while the extension runs.
    await enableExtension(extension.id);
    await updateScheduledTask(schedule!.id, { enabled: false, nextRunAt: null });
    await disableExtension(extension.id);
    await enableExtension(extension.id);
    expect((await getScheduledTaskByName("digest-daily"))?.enabled).toBe(false);

    // Re-enabling an already enabled extension (boot, reload) leaves live state alone.
    await updateScheduledTask(schedule!.id, { enabled: true });
    await enableExtension(extension.id);
    expect((await getScheduledTaskByName("digest-daily"))?.enabled).toBe(true);
  });

  test("the scheduled script runs as the extension agent", async () => {
    const { extension } = await install();
    await enableExtension(extension.id);
    const runScript = spyOn(scriptLoader, "runScript").mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    } as Awaited<ReturnType<typeof scriptLoader.runScript>>);
    try {
      await dispatchScheduleTarget((await getScheduledTaskByName("digest-daily"))!);
      expect(runScript).toHaveBeenCalledTimes(1);
      expect(runScript.mock.calls[0]?.[0]).toMatchObject({
        agentId: await extAgentId(),
        args: { hours: 24 },
        source: SCRIPT,
      });
    } finally {
      runScript.mockRestore();
    }
  });

  test("uninstall deletes pristine assets and detaches edited ones", async () => {
    const { extension } = await install();
    await upsertScriptByName({
      name: "digest-collect",
      scope: "global",
      source: EDITED_SCRIPT,
      description: "Collect",
      intent: "Collect",
      signatureJson: "{}",
      embeddingMode: "skip",
    });
    expect(await uninstallExtension(extension.id)).toEqual({
      deleted: [{ kind: "schedule", name: "digest-daily" }],
      detached: [{ kind: "script", name: "digest-collect" }],
    });
    expect(await getExtensionByName("digest")).toBeNull();
    expect(await getScheduledTaskByName("digest-daily")).toBeNull();
    expect((await getScript({ name: "digest-collect", scope: "global" }))?.source).toBe(
      EDITED_SCRIPT,
    );
    expect(await assetRows()).toEqual([]);
    // The extension agent stays as a tombstone.
    expect(await extAgentId()).toBeDefined();
  });

  test("upgrades update pristine assets and keep edited ones", async () => {
    const { extension } = await install();
    const updatedScript = SCRIPT.replace("ok: true", "ok: 1");
    const staged = await install(bundle({ script: updatedScript, version: "1.1.0" }));
    expect(staged.assets).toBeNull();
    expect((await getScript({ name: "digest-collect", scope: "global" }))?.source).toBe(SCRIPT);

    await activateVersion(extension.id, 2);
    expect((await getScript({ name: "digest-collect", scope: "global" }))?.source).toBe(
      updatedScript,
    );

    // A user edit is never overwritten by the next upgrade.
    await upsertScriptByName({
      name: "digest-collect",
      scope: "global",
      source: EDITED_SCRIPT,
      description: "Collect",
      intent: "Collect",
      signatureJson: "{}",
      embeddingMode: "skip",
    });
    const result = await install(bundle({ script: SCRIPT, version: "1.2.0" }), true);
    expect(result.assets?.skipped).toEqual([{ kind: "script", name: "digest-collect" }]);
    expect((await getScript({ name: "digest-collect", scope: "global" }))?.source).toBe(
      EDITED_SCRIPT,
    );
  });

  test("dropping a schedule description keeps the schedule pristine", async () => {
    const { extension } = await install(bundle({ scheduleDescription: "Daily digest" }));
    await install(bundle({ version: "2.0.0" }));
    await activateVersion(extension.id, 2);
    expect((await getScheduledTaskByName("digest-daily"))?.description).toBe("");

    // The update wrote "" for the missing description: still the extension's own write.
    const again = await install(bundle({ version: "3.0.0" }), true);
    expect(again.assets).toMatchObject({ updated: [], skipped: [] });
    expect(await uninstallExtension(extension.id)).toMatchObject({
      deleted: [
        { kind: "schedule", name: "digest-daily" },
        { kind: "script", name: "digest-collect" },
      ],
      detached: [],
    });
  });

  test("activating a version without the schedule deletes it", async () => {
    const { extension } = await install();
    await install(bundle({ schedule: false, version: "2.0.0" }));
    expect(await getScheduledTaskByName("digest-daily")).not.toBeNull();

    await activateVersion(extension.id, 2);
    expect(await getScheduledTaskByName("digest-daily")).toBeNull();
    expect(await assetRows()).toEqual([
      { kind: "script", name: "digest-collect", enabledBefore: null },
    ]);
  });
  test("a failed version activation keeps an enabled extension on its old version", async () => {
    const { extension } = await install();
    await enableExtension(extension.id);
    await install(bundle({ weekly: true, version: "2.0.0" }));
    const foreign = await createScheduledTask({
      name: "digest-weekly",
      intervalMs: 60_000,
      taskTemplate: "someone else's",
    });
    const daily = await getScheduledTaskByName("digest-daily");
    expect(daily?.enabled).toBe(true);

    await expect(activateVersion(extension.id, 2)).rejects.toBeInstanceOf(
      ExtensionAssetConflictError,
    );

    expect(await getExtensionById(extension.id)).toMatchObject({
      enabled: true,
      status: "enabled",
      activeVersion: 1,
    });
    expect(listRegistered().map((loaded) => loaded.record.id)).toEqual([extension.id]);
    expect(await getScheduledTaskByName("digest-daily")).toMatchObject({
      id: daily!.id,
      enabled: true,
      nextRunAt: daily!.nextRunAt,
    });
    expect(await getScheduledTaskByName("digest-weekly")).toMatchObject({
      id: foreign.id,
      enabled: foreign.enabled,
      taskTemplate: "someone else's",
    });
    expect(await assetRows()).toEqual([
      { kind: "schedule", name: "digest-daily", enabledBefore: null },
      { kind: "script", name: "digest-collect", enabledBefore: null },
    ]);
  });

  test("auto-disable pauses the schedule and a later enable restores it", async () => {
    const saved = process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES;
    process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES = "3";
    try {
      const { extension } = await install(bundle({ hooks: THROWING_HOOKS }));
      await enableExtension(extension.id);
      expect((await getScheduledTaskByName("digest-daily"))?.enabled).toBe(true);

      for (let attempt = 0; attempt < 3; attempt++) {
        await dispatchPre("pre.task.create", {
          options: {},
          description: "start",
          origin: "rest",
        });
      }

      expect(await getExtensionById(extension.id)).toMatchObject({
        enabled: false,
        status: "auto-disabled",
      });
      const paused = await getScheduledTaskByName("digest-daily");
      expect(paused?.enabled).toBe(false);
      expect(paused?.nextRunAt).toBeUndefined();

      await enableExtension(extension.id);
      const restored = await getScheduledTaskByName("digest-daily");
      expect(restored?.enabled).toBe(true);
      expect(restored?.nextRunAt).toBeString();
    } finally {
      if (saved === undefined) delete process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES;
      else process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES = saved;
    }
  });
});
