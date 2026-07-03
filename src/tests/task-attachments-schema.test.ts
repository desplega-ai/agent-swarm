import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  deleteTaskAttachment,
  getDb,
  getTaskAttachments,
  initDb,
  insertTaskAttachment,
  replaceTaskAttachment,
} from "../be/db";
import { AttachmentInputSchema, TaskAttachmentSchema } from "../types";

const TEST_DB_PATH = "./test-task-attachments-schema.sqlite";

describe("task_attachments provider-agnostic metadata", () => {
  let agentId: string;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    const agent = createAgent({
      name: "Provider Attachment Worker",
      description: "Test agent for provider attachment metadata",
      role: "worker",
      isLead: false,
      status: "busy",
      maxTasks: 1,
      capabilities: [],
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  function newTask(label: string) {
    return createTaskExtended(label, {
      agentId,
      source: "mcp",
      priority: 50,
    });
  }

  test("insertTaskAttachment defaults provider fields and serializes capabilities", () => {
    const task = newTask("provider defaults");
    const stored = insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "report.md",
      kind: "agent-fs",
      path: "tasks/task/report.md",
      capabilities: { versioning: true, hash: "abc" },
    });

    expect(stored.providerId).toBe("agent-fs");
    expect(stored.providerKey).toBe("tasks/task/report.md");
    expect(stored.capabilities).toEqual({ versioning: true, hash: "abc" });
    expect(TaskAttachmentSchema.safeParse(stored).success).toBe(true);
  });

  test("legacy-shaped rows with null provider fields are readable after migration defaults", () => {
    const task = newTask("legacy provider row");
    const id = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO task_attachments
           (id, task_id, agent_id, name, kind, path, provider_id, provider_key, is_primary)
         VALUES (?, ?, ?, ?, 'agent-fs', ?, NULL, NULL, 0)`,
      )
      .run(id, task.id, agentId, "legacy.txt", "/legacy/legacy.txt");

    const row = getTaskAttachments(task.id)[0];
    expect(row.providerId).toBeUndefined();
    expect(row.providerKey).toBeUndefined();

    const inserted = insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "legacy-copy.txt",
      kind: "shared-fs",
      path: "/legacy/shared.txt",
    });
    expect(inserted.providerId).toBe("agent-fs");
    expect(inserted.providerKey).toBe("/legacy/shared.txt");
  });

  test("deleteTaskAttachment removes a row", () => {
    const task = newTask("delete attachment");
    const stored = insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "delete.txt",
      kind: "url",
      url: "https://example.com/delete.txt",
    });

    expect(deleteTaskAttachment(stored.id)).toBe(true);
    expect(deleteTaskAttachment(stored.id)).toBe(false);
    expect(getTaskAttachments(task.id)).toEqual([]);
  });

  test("replaceTaskAttachment swaps metadata while preserving task ownership", () => {
    const task = newTask("replace attachment");
    const stored = insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "old.txt",
      kind: "url",
      url: "https://example.com/old.txt",
    });

    const replaced = replaceTaskAttachment(stored.id, {
      agentId,
      name: "new.txt",
      kind: "agent-fs",
      path: "/new.txt",
      providerId: "agent-fs",
      providerKey: "/new.txt",
      capabilities: { searchable: true },
      isPrimary: true,
    });

    expect(replaced?.id).toBe(stored.id);
    expect(replaced?.taskId).toBe(task.id);
    expect(replaced?.name).toBe("new.txt");
    expect(replaced?.kind).toBe("agent-fs");
    expect(replaced?.providerId).toBe("agent-fs");
    expect(replaced?.providerKey).toBe("/new.txt");
    expect(replaced?.capabilities).toEqual({ searchable: true });
    expect(replaced?.isPrimary).toBe(true);
  });

  test("AttachmentInputSchema accepts provider metadata", () => {
    const parsed = AttachmentInputSchema.safeParse({
      kind: "agent-fs",
      name: "provider.txt",
      path: "/provider.txt",
      providerId: "agent-fs",
      providerKey: "/provider.txt",
      capabilities: { signedUrl: true },
    });
    expect(parsed.success).toBe(true);
  });
});
