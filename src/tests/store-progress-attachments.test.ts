import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getTaskAttachments,
  initDb,
  insertTaskAttachment,
} from "../be/db";
import { AttachmentInputSchema, TaskAttachmentSchema } from "../types";

const TEST_DB_PATH = "./test-store-progress-attachments.sqlite";

describe("task_attachments — Phase 1 (pointer-based, append-only)", () => {
  let agentId: string;

  beforeAll(async () => {
    await initDb(TEST_DB_PATH);
    const agent = await createAgent({
      name: "Attachment Test Worker",
      description: "Test agent for task attachments",
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
      } catch {
        // ignore
      }
    }
  });

  async function newTask(label: string) {
    return await createTaskExtended(label, {
      agentId,
      source: "mcp",
      priority: 50,
    });
  }

  test("insert on progress call: inserts attachment row", async () => {
    const task = await newTask("attach on progress");
    const stored = await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "report.pdf",
      kind: "agent-fs",
      path: "/thoughts/2026-05-22/report.pdf",
      intent: "deliverable for Taras",
    });

    expect(stored.id).toBeDefined();
    expect(stored.taskId).toBe(task.id);
    expect(stored.agentId).toBe(agentId);
    expect(stored.kind).toBe("agent-fs");
    expect(stored.path).toBe("/thoughts/2026-05-22/report.pdf");
    expect(stored.intent).toBe("deliverable for Taras");

    const rows = await getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("report.pdf");
  });

  test("insert on completion call: attachments accumulate across calls", async () => {
    const task = await newTask("attach across calls");

    await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "step1.png",
      kind: "agent-fs",
      path: "/runs/step1.png",
      intent: "progress snapshot",
    });
    await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "final.md",
      kind: "agent-fs",
      path: "/runs/final.md",
      intent: "completion summary",
      isPrimary: true,
    });

    const rows = await getTaskAttachments(task.id);
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe("step1.png");
    expect(rows[1].name).toBe("final.md");
    expect(rows[1].isPrimary).toBe(true);
  });

  test("dedup by sha256 across kinds + paths (sha256 wins)", async () => {
    const task = await newTask("dedup by sha256");
    const a = await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "report.pdf",
      kind: "agent-fs",
      path: "/a/path/report.pdf",
      sha256: "abc123",
    });
    // Same task + same sha256 — even with different name/path/kind — should
    // resolve to the original row.
    const b = await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "duplicate-renamed.pdf",
      kind: "agent-fs",
      path: "/different/path/report.pdf",
      sha256: "abc123",
    });

    expect(b.id).toBe(a.id);
    expect((await getTaskAttachments(task.id)).length).toBe(1);
  });

  test("dedup by (kind, pointer, name) tuple when sha256 missing", async () => {
    const task = await newTask("dedup by tuple");
    const a = await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "page.html",
      kind: "url",
      url: "https://example.com/page",
    });
    const b = await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "page.html",
      kind: "url",
      url: "https://example.com/page",
    });

    expect(b.id).toBe(a.id);
    expect((await getTaskAttachments(task.id)).length).toBe(1);
  });

  test("dedup by tuple: name change is treated as a new attachment", async () => {
    const task = await newTask("dedup by tuple name-sensitive");
    await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "page.html",
      kind: "url",
      url: "https://example.com/page",
    });
    await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "page-renamed.html",
      kind: "url",
      url: "https://example.com/page",
    });

    expect((await getTaskAttachments(task.id)).length).toBe(2);
  });

  test("dedup is scoped per task — same pointer on a different task inserts", async () => {
    const t1 = await newTask("dedup scope task 1");
    const t2 = await newTask("dedup scope task 2");
    await insertTaskAttachment({
      taskId: t1.id,
      agentId,
      name: "shared.pdf",
      kind: "agent-fs",
      path: "/shared/shared.pdf",
      sha256: "shared-sha",
    });
    await insertTaskAttachment({
      taskId: t2.id,
      agentId,
      name: "shared.pdf",
      kind: "agent-fs",
      path: "/shared/shared.pdf",
      sha256: "shared-sha",
    });

    expect((await getTaskAttachments(t1.id)).length).toBe(1);
    expect((await getTaskAttachments(t2.id)).length).toBe(1);
  });

  test("zod AttachmentInputSchema rejects array of length > 20", () => {
    const schema = AttachmentInputSchema.array().max(20);
    const ok = Array.from({ length: 20 }).map((_, i) => ({
      kind: "url" as const,
      name: `n-${i}`,
      url: `https://example.com/${i}`,
    }));
    const tooMany = [...ok, { kind: "url" as const, name: "n-21", url: "https://example.com/21" }];

    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse(tooMany).success).toBe(false);
  });

  test("zod AttachmentInputSchema enforces kind enum + per-variant fields", () => {
    // unknown `kind` rejected
    const bad = AttachmentInputSchema.safeParse({
      kind: "inline",
      name: "x",
      path: "/x",
    });
    expect(bad.success).toBe(false);

    // url variant requires `url`, not `path`
    const wrongShape = AttachmentInputSchema.safeParse({
      kind: "url",
      name: "x",
      path: "/x",
    });
    expect(wrongShape.success).toBe(false);

    // page variant requires `pageId`
    const okPage = AttachmentInputSchema.safeParse({
      kind: "page",
      name: "p",
      pageId: "page-123",
    });
    expect(okPage.success).toBe(true);
  });

  test("SQL kind CHECK constraint rejects an unknown kind", async () => {
    const task = await newTask("kind check raw insert");
    expect(async () => {
      (await getDb()).run(
        `INSERT INTO task_attachments (id, task_id, agent_id, name, kind, path)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), task.id, agentId, "bogus.bin", "inline", "/tmp/x"],
      );
    }).toThrow();
  });

  test("ON DELETE CASCADE: deleting parent task removes attachments", async () => {
    const task = await newTask("cascade delete");
    await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "a.txt",
      kind: "agent-fs",
      path: "/a.txt",
    });
    expect((await getTaskAttachments(task.id)).length).toBe(1);

    (await getDb()).run("DELETE FROM agent_tasks WHERE id = ?", [task.id]);
    expect((await getTaskAttachments(task.id)).length).toBe(0);
  });

  // Regression: created_at must be ISO-8601 UTC so a stored row round-trips
  // through `TaskAttachmentSchema` — that schema is `get-task-details`'s
  // declared outputSchema. A plain `datetime('now')` default (space
  // separator, no trailing Z) fails `z.iso.datetime()` and made the tool
  // return rows that violate its own contract.
  test("stored rows satisfy TaskAttachmentSchema end-to-end (insert -> read -> parse)", async () => {
    const task = await newTask("schema round-trip");

    // The row RETURNING from the insert helper must already parse.
    const inserted = await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "report.pdf",
      kind: "agent-fs",
      path: "/thoughts/report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      sha256: "roundtrip-sha",
      intent: "deliverable for Taras",
      description: "the final report",
      isPrimary: true,
    });
    const insertParse = TaskAttachmentSchema.safeParse(inserted);
    expect(insertParse.success).toBe(true);

    // And the row read back via getTaskAttachments must parse too.
    const rows = await getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    for (const row of rows) {
      const parsed = TaskAttachmentSchema.safeParse(row);
      if (!parsed.success) {
        throw new Error(
          `TaskAttachmentSchema rejected a stored row: ${JSON.stringify(parsed.error.issues)}`,
        );
      }
    }

    // created_at must be ISO-8601 UTC: T separator + trailing Z.
    expect(rows[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test("created_at parses with a minimal-fields attachment too", async () => {
    const task = await newTask("schema round-trip minimal");
    await insertTaskAttachment({
      taskId: task.id,
      agentId: null,
      name: "x.txt",
      kind: "url",
      url: "https://example.com/x",
    });
    const rows = await getTaskAttachments(task.id);
    expect(rows.length).toBe(1);
    expect(TaskAttachmentSchema.safeParse(rows[0]).success).toBe(true);
  });

  // Phase 2a follow-up: agent-fs attachments can now carry org_id / drive_id
  // so renderers (Slack, UI) can build a public live-host URL.
  test("agent-fs attachment persists orgId and driveId across the round-trip", async () => {
    const task = await newTask("agent-fs org/drive round-trip");
    const stored = await insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "doc.md",
      kind: "agent-fs",
      path: "/thoughts/doc.md",
      orgId: "org-abc",
      driveId: "drive-xyz",
    });
    expect(stored.orgId).toBe("org-abc");
    expect(stored.driveId).toBe("drive-xyz");

    const rows = await getTaskAttachments(task.id);
    const target = rows.find((r) => r.id === stored.id);
    expect(target?.orgId).toBe("org-abc");
    expect(target?.driveId).toBe("drive-xyz");
    expect(TaskAttachmentSchema.safeParse(target).success).toBe(true);
  });

  test("AttachmentInputSchema accepts agent-fs with optional orgId/driveId", () => {
    const withIds = AttachmentInputSchema.safeParse({
      kind: "agent-fs",
      name: "doc",
      path: "/x",
      orgId: "o",
      driveId: "d",
    });
    expect(withIds.success).toBe(true);

    const withoutIds = AttachmentInputSchema.safeParse({
      kind: "agent-fs",
      name: "doc",
      path: "/x",
    });
    expect(withoutIds.success).toBe(true);
  });
});
