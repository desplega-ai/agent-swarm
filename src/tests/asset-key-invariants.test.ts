import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../apps/store";
import { auditAssetKeys } from "../be/asset-key-audit";
import {
  closeDb,
  createAgent,
  createPage,
  createScheduledTask,
  createTaskExtended,
  createUser,
  createWorkflow,
  getAssetKeyMappingByProvider,
  getDb,
  getDbClient,
  getTaskById,
  initDb,
  insertTaskAttachment,
  listAssetSummaries,
  moveAssetKey,
  upsertAssetKeyMapping,
} from "../be/db";
import { insertScript } from "../be/scripts/db";
import { createStandaloneScheduleTask } from "../scheduler/scheduler";

const TEST_DB_PATH = "./test-asset-key-invariants.sqlite";

let agentId: string;
let userId: string;
let appId: string;
let scriptId: string;

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "namespace-worker", isLead: false, status: "idle" })).id;
  userId = (await createUser({ name: "Namespace User", email: "namespace@example.com" })).id;
  appId = (
    await createApp({
      name: "Default app",
      definition: { models: {}, pages: {}, defaultPage: "main" } as never,
    })
  ).id;
  scriptId = (
    await insertScript({
      name: "default-script",
      scope: "agent",
      scopeId: agentId,
      source: "export default async function () { return { ok: true }; }",
      description: "Asset namespace test script",
      intent: "Verify script asset keys",
      signatureJson: "{}",
      agentId,
      embeddingMode: "skip",
    })
  ).id;
});

afterAll(() => {
  closeDb();
});

describe("cross-entity asset namespace invariants", () => {
  test("all primary entities receive deterministic resource-specific shared keys", async () => {
    const taskA = await createTaskExtended("first", { agentId });
    const taskB = await createTaskExtended("second", { agentId });
    const workflow = await createWorkflow({ name: "default-workflow", definition: { nodes: [] } });
    const schedule = await createScheduledTask({
      name: "default-schedule",
      intervalMs: 60_000,
      taskTemplate: "scheduled work",
    });
    const page = await createPage({
      agentId,
      slug: "default-page",
      title: "Default page",
      contentType: "text/html",
      body: "<p>ok</p>",
    });

    expect([taskA.key, taskB.key, workflow.key, schedule.key, page.key]).toEqual([
      `shared/task:${taskA.id}/`,
      `shared/task:${taskB.id}/`,
      `shared/workflow:${workflow.id}/`,
      `shared/schedule:${schedule.id}/`,
      `shared/page:${page.id}/`,
    ]);
    expect(
      (
        await getDbClient().get<{ key: string }>('SELECT "key" AS key FROM apps WHERE id = ?', [
          appId,
        ])
      )?.key,
    ).toBe(`shared/app:${appId}/`);
    expect(
      (
        await getDbClient().get<{ key: string }>('SELECT "key" AS key FROM scripts WHERE id = ?', [
          scriptId,
        ])
      )?.key,
    ).toBe(`shared/script:${scriptId}/`);
    expect(auditAssetKeys(getDb()).fatalCount).toBe(0);
  });

  test("app and script triggers reject malformed keys", async () => {
    for (const [table, id] of [
      ["apps", appId],
      ["scripts", scriptId],
    ] as const) {
      await expect(
        getDbClient().run(`UPDATE ${table} SET "key" = ? WHERE id = ?`, ["Shared/invalid", id]),
      ).rejects.toThrow("invalid asset namespace key");
    }
  });

  test("children inherit a parent namespace unless explicitly overridden", async () => {
    const parent = await createTaskExtended("parent", { agentId, key: "shared/projects/" });
    const child = await createTaskExtended("child", { parentTaskId: parent.id });
    const override = await createTaskExtended("override", {
      parentTaskId: parent.id,
      key: "shared/other/",
    });
    expect(child.key).toBe("shared/projects/");
    expect(override.key).toBe("shared/other/");
  });

  test("schedule dispatch inherits its schedule namespace", async () => {
    const schedule = await createScheduledTask({
      name: "namespaced-schedule",
      key: "shared/automation/",
      intervalMs: 60_000,
      taskTemplate: "scheduled work",
      targetAgentId: agentId,
    });
    expect((await createStandaloneScheduleTask(schedule)).key).toBe("shared/automation/");
  });

  test("agent-fs mappings are transactional metadata and task moves do not change provider paths", async () => {
    const task = await createTaskExtended("mapped task", { agentId, key: "shared/reports/" });
    const attachment = await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "report.md",
      kind: "agent-fs",
      path: "thoughts/reports/report.md",
      providerId: "agent-fs",
      providerKey: "thoughts/reports/report.md",
      orgId: "org-1",
      driveId: "drive-1",
    });
    const before = await getAssetKeyMappingByProvider({
      providerId: "agent-fs",
      providerOrgId: "org-1",
      providerDriveId: "drive-1",
      providerKey: "thoughts/reports/report.md",
    });
    expect(before?.key).toBe("shared/reports/");
    expect(before?.sourceEntityId).toBe(attachment.id);
    expect(
      (
        await upsertAssetKeyMapping({
          providerId: "agent-fs",
          providerOrgId: "org-1",
          providerDriveId: "drive-1",
          providerKey: "thoughts/reports/report.md",
          key: "shared/reports/",
        })
      ).sourceEntityType,
    ).toBe("task-attachment");

    expect(
      await moveAssetKey({
        entityType: "task",
        id: task.id,
        key: "shared/archive/",
        changedBy: userId,
      }),
    ).toBe(true);
    expect((await getTaskById(task.id))?.key).toBe("shared/archive/");
    const after = await getAssetKeyMappingByProvider({
      providerId: "agent-fs",
      providerOrgId: "org-1",
      providerDriveId: "drive-1",
      providerKey: "thoughts/reports/report.md",
    });
    expect(after?.key).toBe("shared/archive/");
    expect(after?.providerKey).toBe(before?.providerKey);
    const movedTypes = new Set(
      (
        await getDbClient().query<{ entity_type: string }>(
          "SELECT entity_type FROM asset_key_history WHERE entity_id IN (?, ?)",
          [task.id, before!.id],
        )
      ).map((row) => row.entity_type),
    );
    expect(movedTypes).toEqual(new Set(["task", "file"]));
    await expect(
      moveAssetKey({ entityType: "file", id: before!.id, key: "shared/detached/" }),
    ).rejects.toThrow("move with their parent task");
    expect(auditAssetKeys(getDb()).warningCount).toBe(0);
  });

  test("standalone provider mappings default to an fs resource key and remain idempotent", async () => {
    const created = await upsertAssetKeyMapping({
      providerId: "agent-fs",
      providerOrgId: "org-default",
      providerDriveId: "drive-default",
      providerKey: "misc/default.md",
    });
    expect(created.key).toBe(`shared/fs:agent-fs:${created.id}/`);

    const repeated = await upsertAssetKeyMapping({
      providerId: "agent-fs",
      providerOrgId: "org-default",
      providerDriveId: "drive-default",
      providerKey: "misc/default.md",
    });
    expect(repeated.id).toBe(created.id);
    expect(repeated.key).toBe(created.key);
  });

  test("aggregate summaries stay lightweight and include files by logical key", async () => {
    const summaries = await listAssetSummaries({ keyPrefix: "shared/", limit: 1000 });
    expect(summaries.some((asset) => asset.entityType === "task")).toBe(true);
    expect(summaries.some((asset) => asset.entityType === "workflow")).toBe(true);
    expect(summaries.some((asset) => asset.entityType === "schedule")).toBe(true);
    expect(summaries.some((asset) => asset.entityType === "page")).toBe(true);
    expect(summaries.some((asset) => asset.entityType === "app" && asset.id === appId)).toBe(true);
    expect(summaries.some((asset) => asset.entityType === "script" && asset.id === scriptId)).toBe(
      true,
    );
    expect(summaries.some((asset) => asset.entityType === "file")).toBe(true);
    const expectedChecked = (await getDbClient().get<{ count: number }>(
      `SELECT
           (SELECT COUNT(*) FROM agent_tasks) +
           (SELECT COUNT(*) FROM workflows) +
           (SELECT COUNT(*) FROM scheduled_tasks) +
           (SELECT COUNT(*) FROM pages) +
           (SELECT COUNT(*) FROM apps) +
           (SELECT COUNT(*) FROM scripts) +
           (SELECT COUNT(*) FROM asset_key_mappings) AS count`,
    ))!.count;
    expect(auditAssetKeys(getDb()).checked).toBe(expectedChecked);
    expect(JSON.stringify(summaries)).not.toContain("scheduled work");
    expect(JSON.stringify(summaries)).not.toContain("<p>ok</p>");
  });

  test("app and script moves update keys and write typed history rows", async () => {
    expect(
      await moveAssetKey({
        entityType: "app",
        id: appId,
        key: "shared/products/",
        changedBy: userId,
      }),
    ).toBe(true);
    expect(
      await moveAssetKey({
        entityType: "script",
        id: scriptId,
        key: "shared/automation/",
        changedBy: userId,
      }),
    ).toBe(true);

    expect(
      await getDbClient().get<{ key: string }>('SELECT "key" AS key FROM apps WHERE id = ?', [
        appId,
      ]),
    ).toEqual({ key: "shared/products/" });
    expect(
      await getDbClient().get<{ key: string }>('SELECT "key" AS key FROM scripts WHERE id = ?', [
        scriptId,
      ]),
    ).toEqual({ key: "shared/automation/" });
    expect(
      await getDbClient().query<{ entity_type: string; new_key: string }>(
        "SELECT entity_type, new_key FROM asset_key_history WHERE entity_id IN (?, ?) ORDER BY entity_type",
        [appId, scriptId],
      ),
    ).toEqual([
      { entity_type: "app", new_key: "shared/products/" },
      { entity_type: "script", new_key: "shared/automation/" },
    ]);
  });

  test("prefix filters treat SQL wildcard characters as literal key content", async () => {
    const literal = await createTaskExtended("literal wildcard", {
      agentId,
      key: "shared/percent%/",
    });
    const neighbor = await createTaskExtended("wildcard neighbor", {
      agentId,
      key: "shared/percentx/",
    });
    const matches = await listAssetSummaries({
      keyPrefix: "shared/percent%/",
      types: ["task"],
    });
    expect(matches.map((asset) => asset.id)).toContain(literal.id);
    expect(matches.map((asset) => asset.id)).not.toContain(neighbor.id);
  });

  test("provider drift remains readable, blocks moves, and can be repaired idempotently", async () => {
    const mapping = await getAssetKeyMappingByProvider({
      providerId: "agent-fs",
      providerOrgId: "org-1",
      providerDriveId: "drive-1",
      providerKey: "thoughts/reports/report.md",
    });
    expect(mapping).not.toBeNull();
    await getDbClient().run('UPDATE asset_key_mappings SET "key" = ? WHERE id = ?', [
      "shared/drift/",
      mapping!.id,
    ]);
    expect(auditAssetKeys(getDb()).warningCount).toBeGreaterThan(0);
    const anyTask = (await listAssetSummaries({ types: ["task"], limit: 1 }))[0]!;
    await expect(
      moveAssetKey({ entityType: "task", id: anyTask.id, key: "shared/blocked/" }),
    ).rejects.toThrow("blocked until");

    await upsertAssetKeyMapping({
      providerId: mapping!.providerId,
      providerOrgId: mapping!.providerOrgId,
      providerDriveId: mapping!.providerDriveId,
      providerKey: mapping!.providerKey,
      key: "shared/archive/",
      sourceEntityType: "task-attachment",
      sourceEntityId: mapping!.sourceEntityId,
      updatedBy: userId,
    });
    expect(auditAssetKeys(getDb()).warningCount).toBe(0);
  });

  test("personal namespace users are audited and missing users are repairable warnings", async () => {
    const task = await createTaskExtended("personal", {
      agentId,
      key: `personal/${userId}/drafts/`,
    });
    expect(auditAssetKeys(getDb()).warningCount).toBe(0);

    await getDbClient().run("PRAGMA foreign_keys = OFF");
    await getDbClient().run("DELETE FROM users WHERE id = ?", [userId]);
    await getDbClient().run("PRAGMA foreign_keys = ON");
    const warning = auditAssetKeys(getDb());
    expect(warning.issues.some((issue) => issue.code === "unknown-personal-user")).toBe(true);

    await getDbClient().run('UPDATE agent_tasks SET "key" = ? WHERE id = ?', [
      "shared/repaired/",
      task.id,
    ]);
    expect(auditAssetKeys(getDb()).warningCount).toBe(0);
  });
});
