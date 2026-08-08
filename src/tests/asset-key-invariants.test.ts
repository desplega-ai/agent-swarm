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

beforeAll(() => {
  initDb(TEST_DB_PATH);
  agentId = createAgent({ name: "namespace-worker", isLead: false, status: "idle" }).id;
  userId = createUser({ name: "Namespace User", email: "namespace@example.com" }).id;
  appId = createApp({
    name: "Default app",
    definition: { models: {}, pages: {}, defaultPage: "main" } as never,
  }).id;
  scriptId = insertScript({
    name: "default-script",
    scope: "agent",
    scopeId: agentId,
    source: "export default async function () { return { ok: true }; }",
    description: "Asset namespace test script",
    intent: "Verify script asset keys",
    signatureJson: "{}",
    agentId,
    embeddingMode: "skip",
  }).id;
});

afterAll(() => {
  closeDb();
});

describe("cross-entity asset namespace invariants", () => {
  test("all primary entities receive deterministic resource-specific shared keys", () => {
    const taskA = createTaskExtended("first", { agentId });
    const taskB = createTaskExtended("second", { agentId });
    const workflow = createWorkflow({ name: "default-workflow", definition: { nodes: [] } });
    const schedule = createScheduledTask({
      name: "default-schedule",
      intervalMs: 60_000,
      taskTemplate: "scheduled work",
    });
    const page = createPage({
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
      getDb()
        .prepare<{ key: string }, [string]>('SELECT "key" AS key FROM apps WHERE id = ?')
        .get(appId)?.key,
    ).toBe(`shared/app:${appId}/`);
    expect(
      getDb()
        .prepare<{ key: string }, [string]>('SELECT "key" AS key FROM scripts WHERE id = ?')
        .get(scriptId)?.key,
    ).toBe(`shared/script:${scriptId}/`);
    expect(auditAssetKeys(getDb()).fatalCount).toBe(0);
  });

  test("app and script triggers reject malformed keys", () => {
    for (const [table, id] of [
      ["apps", appId],
      ["scripts", scriptId],
    ] as const) {
      expect(() =>
        getDb().run(`UPDATE ${table} SET "key" = ? WHERE id = ?`, ["Shared/invalid", id]),
      ).toThrow("invalid asset namespace key");
    }
  });

  test("children inherit a parent namespace unless explicitly overridden", () => {
    const parent = createTaskExtended("parent", { agentId, key: "shared/projects/" });
    const child = createTaskExtended("child", { parentTaskId: parent.id });
    const override = createTaskExtended("override", {
      parentTaskId: parent.id,
      key: "shared/other/",
    });
    expect(child.key).toBe("shared/projects/");
    expect(override.key).toBe("shared/other/");
  });

  test("schedule dispatch inherits its schedule namespace", () => {
    const schedule = createScheduledTask({
      name: "namespaced-schedule",
      key: "shared/automation/",
      intervalMs: 60_000,
      taskTemplate: "scheduled work",
      targetAgentId: agentId,
    });
    expect(createStandaloneScheduleTask(schedule).key).toBe("shared/automation/");
  });

  test("agent-fs mappings are transactional metadata and task moves do not change provider paths", () => {
    const task = createTaskExtended("mapped task", { agentId, key: "shared/reports/" });
    const attachment = insertTaskAttachment({
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
    const before = getAssetKeyMappingByProvider({
      providerId: "agent-fs",
      providerOrgId: "org-1",
      providerDriveId: "drive-1",
      providerKey: "thoughts/reports/report.md",
    });
    expect(before?.key).toBe("shared/reports/");
    expect(before?.sourceEntityId).toBe(attachment.id);
    expect(
      upsertAssetKeyMapping({
        providerId: "agent-fs",
        providerOrgId: "org-1",
        providerDriveId: "drive-1",
        providerKey: "thoughts/reports/report.md",
        key: "shared/reports/",
      }).sourceEntityType,
    ).toBe("task-attachment");

    expect(
      moveAssetKey({ entityType: "task", id: task.id, key: "shared/archive/", changedBy: userId }),
    ).toBe(true);
    expect(getTaskById(task.id)?.key).toBe("shared/archive/");
    const after = getAssetKeyMappingByProvider({
      providerId: "agent-fs",
      providerOrgId: "org-1",
      providerDriveId: "drive-1",
      providerKey: "thoughts/reports/report.md",
    });
    expect(after?.key).toBe("shared/archive/");
    expect(after?.providerKey).toBe(before?.providerKey);
    const movedTypes = new Set(
      getDb()
        .prepare<{ entity_type: string }, [string, string]>(
          "SELECT entity_type FROM asset_key_history WHERE entity_id IN (?, ?)",
        )
        .all(task.id, before!.id)
        .map((row) => row.entity_type),
    );
    expect(movedTypes).toEqual(new Set(["task", "file"]));
    expect(() =>
      moveAssetKey({ entityType: "file", id: before!.id, key: "shared/detached/" }),
    ).toThrow("move with their parent task");
    expect(auditAssetKeys(getDb()).warningCount).toBe(0);
  });

  test("standalone provider mappings default to an fs resource key and remain idempotent", () => {
    const created = upsertAssetKeyMapping({
      providerId: "agent-fs",
      providerOrgId: "org-default",
      providerDriveId: "drive-default",
      providerKey: "misc/default.md",
    });
    expect(created.key).toBe(`shared/fs:agent-fs:${created.id}/`);

    const repeated = upsertAssetKeyMapping({
      providerId: "agent-fs",
      providerOrgId: "org-default",
      providerDriveId: "drive-default",
      providerKey: "misc/default.md",
    });
    expect(repeated.id).toBe(created.id);
    expect(repeated.key).toBe(created.key);
  });

  test("aggregate summaries stay lightweight and include files by logical key", () => {
    const summaries = listAssetSummaries({ keyPrefix: "shared/", limit: 1000 });
    expect(summaries.some((asset) => asset.entityType === "task")).toBe(true);
    expect(summaries.some((asset) => asset.entityType === "workflow")).toBe(true);
    expect(summaries.some((asset) => asset.entityType === "schedule")).toBe(true);
    expect(summaries.some((asset) => asset.entityType === "page")).toBe(true);
    expect(summaries.some((asset) => asset.entityType === "app" && asset.id === appId)).toBe(true);
    expect(summaries.some((asset) => asset.entityType === "script" && asset.id === scriptId)).toBe(
      true,
    );
    expect(summaries.some((asset) => asset.entityType === "file")).toBe(true);
    const expectedChecked = getDb()
      .prepare<{ count: number }, []>(
        `SELECT
           (SELECT COUNT(*) FROM agent_tasks) +
           (SELECT COUNT(*) FROM workflows) +
           (SELECT COUNT(*) FROM scheduled_tasks) +
           (SELECT COUNT(*) FROM pages) +
           (SELECT COUNT(*) FROM apps) +
           (SELECT COUNT(*) FROM scripts) +
           (SELECT COUNT(*) FROM asset_key_mappings) AS count`,
      )
      .get()!.count;
    expect(auditAssetKeys(getDb()).checked).toBe(expectedChecked);
    expect(JSON.stringify(summaries)).not.toContain("scheduled work");
    expect(JSON.stringify(summaries)).not.toContain("<p>ok</p>");
  });

  test("app and script moves update keys and write typed history rows", () => {
    expect(
      moveAssetKey({ entityType: "app", id: appId, key: "shared/products/", changedBy: userId }),
    ).toBe(true);
    expect(
      moveAssetKey({
        entityType: "script",
        id: scriptId,
        key: "shared/automation/",
        changedBy: userId,
      }),
    ).toBe(true);

    expect(
      getDb()
        .prepare<{ key: string }, [string]>('SELECT "key" AS key FROM apps WHERE id = ?')
        .get(appId),
    ).toEqual({ key: "shared/products/" });
    expect(
      getDb()
        .prepare<{ key: string }, [string]>('SELECT "key" AS key FROM scripts WHERE id = ?')
        .get(scriptId),
    ).toEqual({ key: "shared/automation/" });
    expect(
      getDb()
        .prepare<{ entity_type: string; new_key: string }, [string, string]>(
          "SELECT entity_type, new_key FROM asset_key_history WHERE entity_id IN (?, ?) ORDER BY entity_type",
        )
        .all(appId, scriptId),
    ).toEqual([
      { entity_type: "app", new_key: "shared/products/" },
      { entity_type: "script", new_key: "shared/automation/" },
    ]);
  });

  test("prefix filters treat SQL wildcard characters as literal key content", () => {
    const literal = createTaskExtended("literal wildcard", { agentId, key: "shared/percent%/" });
    const neighbor = createTaskExtended("wildcard neighbor", { agentId, key: "shared/percentx/" });
    const matches = listAssetSummaries({
      keyPrefix: "shared/percent%/",
      types: ["task"],
    });
    expect(matches.map((asset) => asset.id)).toContain(literal.id);
    expect(matches.map((asset) => asset.id)).not.toContain(neighbor.id);
  });

  test("provider drift remains readable, blocks moves, and can be repaired idempotently", () => {
    const mapping = getAssetKeyMappingByProvider({
      providerId: "agent-fs",
      providerOrgId: "org-1",
      providerDriveId: "drive-1",
      providerKey: "thoughts/reports/report.md",
    });
    expect(mapping).not.toBeNull();
    getDb().run('UPDATE asset_key_mappings SET "key" = ? WHERE id = ?', [
      "shared/drift/",
      mapping!.id,
    ]);
    expect(auditAssetKeys(getDb()).warningCount).toBeGreaterThan(0);
    const anyTask = listAssetSummaries({ types: ["task"], limit: 1 })[0]!;
    expect(() =>
      moveAssetKey({ entityType: "task", id: anyTask.id, key: "shared/blocked/" }),
    ).toThrow("blocked until");

    upsertAssetKeyMapping({
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

  test("personal namespace users are audited and missing users are repairable warnings", () => {
    const task = createTaskExtended("personal", {
      agentId,
      key: `personal/${userId}/drafts/`,
    });
    expect(auditAssetKeys(getDb()).warningCount).toBe(0);

    getDb().run("PRAGMA foreign_keys = OFF");
    getDb().run("DELETE FROM users WHERE id = ?", [userId]);
    getDb().run("PRAGMA foreign_keys = ON");
    const warning = auditAssetKeys(getDb());
    expect(warning.issues.some((issue) => issue.code === "unknown-personal-user")).toBe(true);

    getDb().run('UPDATE agent_tasks SET "key" = ? WHERE id = ?', ["shared/repaired/", task.id]);
    expect(auditAssetKeys(getDb()).warningCount).toBe(0);
  });
});
