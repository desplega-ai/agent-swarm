import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as db from "../be/db";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createWorkflow,
  getAgentSkills,
  getAllAgents,
  getDbClient,
  getScheduledTaskByName,
  initDb,
  installSkill,
  listWorkflows,
  updateScheduledTask,
  updateSkill,
  updateWorkflow,
} from "../be/db";
import { ExtensionAssetConflictError } from "../be/extensions/assets";
import { getExtensionById, getExtensionByName } from "../be/extensions/db";
import { deleteScript, getScript, upsertScriptByName } from "../be/scripts/db";
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
import { telemetry } from "../telemetry";
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

const WORKFLOW = `name: digest-report
description: Collect on demand
definition:
  nodes:
    - id: collect
      type: swarm-script
      config:
        scriptName: digest-collect
        scope: global
`;
const SKILL =
  "---\nname: digest-guide\ndescription: How to read the digest\n---\n\n# Digest guide\n";

function bundle(
  opts: {
    schedule?: boolean;
    weekly?: boolean;
    hooks?: string;
    script?: string;
    version?: string;
    workflow?: string | false;
    skill?: string | false;
    scheduleDescription?: string;
  } = {},
): Bundle {
  const files: Record<string, string> = {
    "hooks.ts": opts.hooks ?? HOOKS,
    "scripts/collect.ts": opts.script ?? SCRIPT,
  };
  if (opts.workflow) files["workflows/report.yaml"] = opts.workflow;
  if (opts.skill) {
    files["skills/digest-guide/SKILL.md"] = opts.skill;
    files["skills/digest-guide/files/sample.json"] = '{"completed": 1}';
  }
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
        ...(opts.workflow ? { workflows: [{ file: "workflows/report.yaml" }] } : {}),
        ...(opts.skill ? { skills: [{ dir: "skills/digest-guide" }] } : {}),
      },
    },
    files,
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
    await client.run("DELETE FROM workflows");
    await client.run("DELETE FROM skills");
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

  test("a script edited only in its metadata is kept on upgrade and uninstall", async () => {
    const { extension } = await install();
    const installed = (await getScript({ name: "digest-collect", scope: "global" }))!;
    await upsertScriptByName({
      name: "digest-collect",
      scope: "global",
      source: installed.source,
      description: "My own description",
      intent: installed.intent,
      signatureJson: installed.signatureJson,
      argsJsonSchema: installed.argsJsonSchema,
      embeddingMode: "skip",
    });

    const upgrade = await install(bundle({ version: "2.0.0" }), true);
    expect(upgrade.assets?.skipped).toEqual([{ kind: "script", name: "digest-collect" }]);
    expect((await getScript({ name: "digest-collect", scope: "global" }))?.description).toBe(
      "My own description",
    );

    expect(await uninstallExtension(extension.id)).toEqual({
      deleted: [{ kind: "schedule", name: "digest-daily" }],
      detached: [{ kind: "script", name: "digest-collect" }],
    });
    expect((await getScript({ name: "digest-collect", scope: "global" }))?.description).toBe(
      "My own description",
    );
  });

  test("a script deleted and recreated under the same name is not the extension's", async () => {
    const { extension } = await install();
    const installed = (await getScript({ name: "digest-collect", scope: "global" }))!;
    await deleteScript({ name: "digest-collect", scope: "global" });
    // Same name, source and metadata: only the id differs.
    const { script: replacement } = await upsertScriptByName({
      name: "digest-collect",
      scope: "global",
      source: installed.source,
      description: installed.description,
      intent: installed.intent,
      signatureJson: installed.signatureJson,
      argsJsonSchema: installed.argsJsonSchema,
      embeddingMode: "skip",
    });
    expect(replacement.id).not.toBe(installed.id);

    // An upgrade must not adopt it.
    await expect(install(bundle({ version: "2.0.0" }), true)).rejects.toThrow(
      'script "digest-collect" already exists and does not belong to this extension',
    );

    // Uninstall must not delete it.
    expect(await uninstallExtension(extension.id)).toEqual({
      deleted: [{ kind: "schedule", name: "digest-daily" }],
      detached: [],
    });
    expect((await getScript({ name: "digest-collect", scope: "global" }))?.id).toBe(replacement.id);
  });

  test("a schedule pointed at another target is kept on uninstall", async () => {
    const { extension } = await install();
    const schedule = (await getScheduledTaskByName("digest-daily"))!;
    // scriptName stays stored; only the target changes.
    await updateScheduledTask(schedule.id, {
      targetType: "agent-task",
      taskTemplate: "Summarize yesterday",
    });
    expect((await getScheduledTaskByName("digest-daily"))?.scriptName).toBe("digest-collect");

    expect(await uninstallExtension(extension.id)).toEqual({
      deleted: [{ kind: "script", name: "digest-collect" }],
      detached: [{ kind: "schedule", name: "digest-daily" }],
    });
    expect(await getScheduledTaskByName("digest-daily")).toMatchObject({
      id: schedule.id,
      targetType: "agent-task",
    });
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

  test("workflows and skills are created disabled and follow the extension's enabled state", async () => {
    const { extension, assets } = await install(bundle({ workflow: WORKFLOW, skill: SKILL }));
    expect(assets?.created).toEqual([
      { kind: "script", name: "digest-collect" },
      { kind: "schedule", name: "digest-daily" },
      { kind: "workflow", name: "digest-report" },
      { kind: "skill", name: "digest-guide" },
    ]);
    const agentId = await extAgentId();

    const workflow = (await listWorkflows()).find((w) => w.name === "digest-report");
    expect(workflow).toMatchObject({ enabled: false, createdByAgentId: agentId });
    expect((await listWorkflows({ enabled: true })).map((w) => w.name)).not.toContain(
      "digest-report",
    );

    const skill = await getDbClient().get<{
      id: string;
      scope: string;
      ownerAgentId: string;
      isEnabled: number;
      systemDefault: number;
    }>("SELECT id, scope, ownerAgentId, isEnabled, systemDefault FROM skills WHERE name = ?", [
      "digest-guide",
    ]);
    expect(skill).toMatchObject({
      scope: "global",
      ownerAgentId: agentId,
      isEnabled: 0,
      systemDefault: 0,
    });
    const files = await getDbClient().query<{ path: string }>(
      "SELECT path FROM skill_files WHERE skillId = ?",
      [skill!.id],
    );
    expect(files.map((file) => file.path)).toEqual(["sample.json"]);

    // Installed on an agent, a disabled extension skill still does not resolve.
    const reader = await createAgent({ name: "digest-reader", isLead: false, status: "idle" });
    await installSkill(reader.id, skill!.id);
    const names = async () => (await getAgentSkills(reader.id)).map((s) => s.name);
    expect(await names()).not.toContain("digest-guide");

    await enableExtension(extension.id);
    expect((await listWorkflows({ enabled: true })).map((w) => w.name)).toContain("digest-report");
    expect(await names()).toContain("digest-guide");

    await disableExtension(extension.id);
    expect((await listWorkflows({ enabled: true })).map((w) => w.name)).not.toContain(
      "digest-report",
    );
    expect(await names()).not.toContain("digest-guide");

    // All four kinds survive disable -> enable, and a user's choice sticks.
    await enableExtension(extension.id);
    await updateSkill(skill!.id, { isEnabled: false });
    await disableExtension(extension.id);
    await enableExtension(extension.id);
    expect(await names()).not.toContain("digest-guide");
    expect((await listWorkflows({ enabled: true })).map((w) => w.name)).toContain("digest-report");
    expect((await getScheduledTaskByName("digest-daily"))?.enabled).toBe(true);
    await disableExtension(extension.id);

    // Reinstalling the same bundle leaves every asset alone.
    const again = await install(bundle({ workflow: WORKFLOW, skill: SKILL }));
    expect(again.assets).toMatchObject({ created: [], updated: [], skipped: [] });

    expect(await uninstallExtension(extension.id)).toEqual({
      deleted: [
        { kind: "skill", name: "digest-guide" },
        { kind: "workflow", name: "digest-report" },
        { kind: "schedule", name: "digest-daily" },
        { kind: "script", name: "digest-collect" },
      ],
      detached: [],
    });
    expect((await listWorkflows()).map((w) => w.name)).not.toContain("digest-report");
    expect(await getDbClient().get("SELECT id FROM skills WHERE name = 'digest-guide'")).toBeNull();
  });

  test("an invalid workflow definition fails install and writes nothing", async () => {
    const broken = WORKFLOW.replace("type: swarm-script", "type: not-a-node-type");
    await expect(install(bundle({ workflow: broken }))).rejects.toThrow("workflow digest-report");
    expect(await getExtensionByName("digest")).toBeNull();
    expect(await getScript({ name: "digest-collect", scope: "global" })).toBeNull();
  });

  test("a workflow or skill without the name prefix fails install", async () => {
    await expect(
      install(bundle({ workflow: WORKFLOW.replace("name: digest-report", "name: report") })),
    ).rejects.toThrow('workflow name must start with "digest-"');
    await expect(
      install(bundle({ skill: SKILL.replace("name: digest-guide", "name: guide") })),
    ).rejects.toThrow('name "guide" must start with "digest-"');
    expect(await getExtensionByName("digest")).toBeNull();
  });

  test("dropping a workflow description keeps the workflow pristine", async () => {
    const { extension } = await install(bundle({ workflow: WORKFLOW }));
    const bare = WORKFLOW.replace("description: Collect on demand\n", "");
    await install(bundle({ workflow: bare, version: "2.0.0" }));
    await activateVersion(extension.id, 2);
    expect((await listWorkflows()).find((w) => w.name === "digest-report")?.description).toBe("");

    // The update wrote "" for the missing description: still the extension's own write.
    const again = await install(bundle({ workflow: bare, version: "3.0.0" }), true);
    expect(again.assets).toMatchObject({ updated: [], skipped: [] });
    expect(await uninstallExtension(extension.id)).toMatchObject({
      deleted: expect.arrayContaining([{ kind: "workflow", name: "digest-report" }]),
      detached: [],
    });
  });

  test("a rolled-back install emits no workflow telemetry", async () => {
    const events: string[] = [];
    const workflowSpy = spyOn(telemetry, "workflow").mockImplementation((event) => {
      events.push(event);
    });
    // The skill is written after the workflow, so this fails the install mid-transaction.
    const filesSpy = spyOn(db, "upsertSkillFiles").mockRejectedValue(
      new Error("skill write failed"),
    );
    try {
      await expect(install(bundle({ workflow: WORKFLOW, skill: SKILL }))).rejects.toThrow(
        "skill write failed",
      );
      expect((await listWorkflows()).map((w) => w.name)).not.toContain("digest-report");
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual([]);

      filesSpy.mockRestore();
      await install(bundle({ workflow: WORKFLOW, skill: SKILL }));
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(["created"]);
    } finally {
      filesSpy.mockRestore();
      workflowSpy.mockRestore();
    }
  });

  test.each([
    ["description", { description: "edited by a user" }],
    ["scope", { scope: "swarm" as const }],
    ["model", { model: "opus" }],
    ["allowedTools", { allowedTools: "Read" }],
    ["userInvocable", { userInvocable: false }],
  ])("a skill whose %s a user edited is kept on upgrade and detached on uninstall", async (_field, edit) => {
    const { extension } = await install(bundle({ skill: SKILL }));
    const skill = await getDbClient().get<{ id: string }>(
      "SELECT id FROM skills WHERE name = 'digest-guide'",
    );
    await updateSkill(skill!.id, edit);

    const upgraded = await install(
      bundle({ skill: SKILL.replace("# Digest guide", "# Digest guide v2"), version: "2.0.0" }),
      true,
    );
    expect(upgraded.assets?.skipped).toEqual([{ kind: "skill", name: "digest-guide" }]);
    expect(await uninstallExtension(extension.id)).toMatchObject({
      detached: [{ kind: "skill", name: "digest-guide" }],
    });
    expect(
      await getDbClient().get("SELECT content FROM skills WHERE name = 'digest-guide'"),
    ).toEqual({ content: SKILL });
  });

  test("an upgrade clears skill metadata the new version drops", async () => {
    const withModel = SKILL.replace("description:", "model: opus\ndescription:");
    const { extension } = await install(bundle({ skill: withModel }));
    await install(bundle({ skill: SKILL, version: "2.0.0" }));
    await activateVersion(extension.id, 2);
    expect(await getDbClient().get("SELECT model FROM skills WHERE name = 'digest-guide'")).toEqual(
      {
        model: null,
      },
    );
    const again = await install(bundle({ skill: SKILL, version: "3.0.0" }), true);
    expect(again.assets).toMatchObject({ updated: [], skipped: [] });
  });

  test("uninstall detaches an edited workflow and keeps it", async () => {
    const { extension } = await install(bundle({ workflow: WORKFLOW }));
    const workflow = (await listWorkflows()).find((w) => w.name === "digest-report")!;
    await updateWorkflow(workflow.id, { description: "edited by a user" });
    expect(await uninstallExtension(extension.id)).toMatchObject({
      detached: [{ kind: "workflow", name: "digest-report" }],
    });
    expect((await listWorkflows()).find((w) => w.name === "digest-report")?.description).toBe(
      "edited by a user",
    );
  });

  test("a skill name used anywhere else is a collision", async () => {
    await getDbClient().run(
      `INSERT INTO skills (id, name, description, content, type, scope, createdAt, lastUpdatedAt)
       VALUES (?, 'digest-guide', 'someone else', '---', 'personal', 'swarm', datetime('now'), datetime('now'))`,
      [crypto.randomUUID()],
    );
    await expect(install(bundle({ skill: SKILL }))).rejects.toThrow(
      'skill "digest-guide" already exists and does not belong to this extension',
    );
    expect(await getExtensionByName("digest")).toBeNull();
  });

  async function extensionAssetState() {
    const agentId = await extAgentId();
    const workflow = (await listWorkflows()).find(
      (w) => w.name === "digest-report" && w.createdByAgentId === agentId,
    );
    const skill = await getDbClient().get<{ isEnabled: number }>(
      "SELECT isEnabled FROM skills WHERE name = 'digest-guide' AND ownerAgentId = ?",
      [agentId ?? ""],
    );
    const schedule = await getScheduledTaskByName("digest-daily");
    return {
      schedule: schedule ? { enabled: schedule.enabled, nextRunAt: schedule.nextRunAt } : null,
      workflow: workflow ? workflow.enabled : null,
      skill: skill ? skill.isEnabled === 1 : null,
    };
  }

  test.each([
    "schedule",
    "workflow",
    "skill",
  ] as const)("a %s conflict on activation keeps an enabled extension on its old version", async (kind) => {
    const { extension } = await install(
      bundle({
        workflow: kind === "workflow" ? false : WORKFLOW,
        skill: kind === "skill" ? false : SKILL,
      }),
    );
    await enableExtension(extension.id);
    await install(
      bundle({ weekly: kind === "schedule", workflow: WORKFLOW, skill: SKILL, version: "2.0.0" }),
    );
    if (kind === "schedule") {
      await createScheduledTask({
        name: "digest-weekly",
        intervalMs: 60_000,
        taskTemplate: "someone else's",
      });
    } else if (kind === "workflow") {
      await createWorkflow({
        name: "digest-report",
        description: "someone else's",
        definition: { nodes: [] },
      });
    } else {
      await getDbClient().run(
        `INSERT INTO skills (id, name, description, content, type, scope, createdAt, lastUpdatedAt)
           VALUES (?, 'digest-guide', 'someone else', '---', 'personal', 'swarm', datetime('now'), datetime('now'))`,
        [crypto.randomUUID()],
      );
    }
    const before = await extensionAssetState();
    expect(before).toEqual({
      schedule: { enabled: true, nextRunAt: expect.any(String) },
      workflow: kind === "workflow" ? null : true,
      skill: kind === "skill" ? null : true,
    });

    await expect(activateVersion(extension.id, 2)).rejects.toBeInstanceOf(
      ExtensionAssetConflictError,
    );

    expect(await getExtensionById(extension.id)).toMatchObject({
      enabled: true,
      status: "enabled",
      activeVersion: 1,
    });
    expect(listRegistered().map((loaded) => loaded.record.id)).toEqual([extension.id]);
    expect(await extensionAssetState()).toEqual(before);
    expect((await assetRows()).every((row) => row.enabledBefore === null)).toBe(true);
    // The foreign asset is untouched.
    if (kind === "schedule") {
      expect((await getScheduledTaskByName("digest-weekly"))?.taskTemplate).toBe("someone else's");
    } else if (kind === "workflow") {
      expect(
        (await listWorkflows()).filter((w) => w.name === "digest-report").map((w) => w.description),
      ).toEqual(["someone else's"]);
    } else {
      expect(
        await getDbClient().get("SELECT description FROM skills WHERE name = 'digest-guide'"),
      ).toEqual({ description: "someone else" });
    }
  });

  test("auto-disable pauses schedules, workflows and skills and a later enable restores them", async () => {
    const saved = process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES;
    process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES = "3";
    try {
      const { extension } = await install(
        bundle({ hooks: THROWING_HOOKS, workflow: WORKFLOW, skill: SKILL }),
      );
      await enableExtension(extension.id);
      expect(await extensionAssetState()).toEqual({
        schedule: { enabled: true, nextRunAt: expect.any(String) },
        workflow: true,
        skill: true,
      });

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
      expect(await extensionAssetState()).toEqual({
        schedule: { enabled: false, nextRunAt: undefined },
        workflow: false,
        skill: false,
      });

      await enableExtension(extension.id);
      expect(await extensionAssetState()).toEqual({
        schedule: { enabled: true, nextRunAt: expect.any(String) },
        workflow: true,
        skill: true,
      });
    } finally {
      if (saved === undefined) delete process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES;
      else process.env.EXTENSION_MAX_CONSECUTIVE_FAILURES = saved;
    }
  });
});
