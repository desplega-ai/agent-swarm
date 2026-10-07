import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { memorySnippet, renderMemoriesPrompt } from "../prompts/memories";

const longPrompt = `Implement the thing. ${"Background detail that is not the outcome. ".repeat(12)}`;

describe("renderMemoriesPrompt — outcome, date and source", () => {
  test("a task_completion line shows the output, not the start of a >300-char prompt", () => {
    expect(longPrompt.length).toBeGreaterThan(300);
    const prompt = renderMemoriesPrompt([
      {
        id: "m-1",
        name: "Task: Implement the thing",
        content: `Task: ${longPrompt}\n\nOutput:\nShipped PR #42; tests green.`,
        similarity: 0.9,
        source: "task_completion",
        createdAt: "2026-09-29T07:20:00.000Z",
      },
    ]);
    expect(prompt).toContain(
      "- [2026-09-29, task_completion] **Task: Implement the thing** (id: m-1): Shipped PR #42; tests green.",
    );
    expect(prompt).not.toContain("Background detail");
  });

  test("a failed task_completion shows the failure reason without the boilerplate tail", () => {
    const snippet = memorySnippet({
      id: "m-2",
      name: "x",
      content: `Task: ${longPrompt}\n\nFailure reason:\nCI red on main.\n\nThis task failed. Learn from this to avoid repeating the mistake.`,
      similarity: 0.9,
      source: "task_completion",
    });
    expect(snippet).toBe("FAILED: CI red on main.");
  });

  test("the last Output marker wins when the task prompt embeds an earlier one", () => {
    const snippet = memorySnippet({
      id: "m-3",
      name: "x",
      content:
        'Task: Worker task completed.\nTask: "y"\n\nOutput:\nold worker output\n\nOutput:\nreview done',
      similarity: 0.9,
      source: "task_completion",
    });
    expect(snippet).toBe("review done");
  });

  test("summary wins when set; other sources keep their content; missing metadata adds no prefix", () => {
    expect(
      memorySnippet({
        id: "m-4",
        name: "x",
        content: `Task: ${longPrompt}\n\nOutput:\nlong output`,
        similarity: 0.9,
        source: "task_completion",
        summary: "  short summary  ",
      }),
    ).toBe("short summary");
    const prompt = renderMemoriesPrompt([
      { id: "m-5", name: "manual note", content: "Output:\nkeep me", similarity: 0.9 },
    ]);
    expect(prompt).toContain("- **manual note** (id: m-5): Output:\nkeep me");
  });
});

describe("200_backfill_auto_memory_expiry", () => {
  const TEST_DB_PATH = "./test-memory-injection-outcome.sqlite";
  const agentId = crypto.randomUUID();
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    await createAgent({ id: agentId, name: "Backfill Agent", isLead: false, status: "idle" });
    store = new SqliteMemoryStore();
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  test("sets a 7-day expiry on legacy agent-scope auto memories only", async () => {
    const base = { agentId, name: "m", content: "Task: x\n\nOutput:\ny" };
    const completion = await store.store({ ...base, scope: "agent", source: "task_completion" });
    const session = await store.store({ ...base, scope: "agent", source: "session_summary" });
    const swarm = await store.store({ ...base, scope: "swarm", source: "task_completion" });
    const manual = await store.store({ ...base, scope: "agent", source: "manual" });
    const longterm = await store.store({
      ...base,
      scope: "agent",
      source: "task_completion",
      key: "/longterm/facts/backfill/keep",
    });
    const alreadySet = await store.store({ ...base, scope: "agent", source: "task_completion" });

    const db = getDbClient();
    const legacy = [completion, session, swarm, manual, longterm];
    for (const row of legacy) {
      await db.run("UPDATE agent_memory SET expiresAt = NULL WHERE id = ?", [row.id]);
    }
    const presetExpiry = "2099-01-01T00:00:00.000Z";
    await db.run("UPDATE agent_memory SET expiresAt = ? WHERE id = ?", [
      presetExpiry,
      alreadySet.id,
    ]);

    const sql = await Bun.file(
      new URL("../be/migrations/200_backfill_auto_memory_expiry.sql", import.meta.url),
    ).text();
    const before = Date.now();
    await db.run(sql);

    const expiry = async (id: string) =>
      (
        await db.get<{ expiresAt: string | null }>(
          "SELECT expiresAt FROM agent_memory WHERE id = ?",
          [id],
        )
      )?.expiresAt ?? null;

    for (const row of [completion, session]) {
      const value = await expiry(row.id);
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const days = (Date.parse(value!) - before) / 86_400_000;
      expect(days).toBeGreaterThan(6.99);
      expect(days).toBeLessThan(7.01);
    }
    for (const row of [swarm, manual, longterm]) expect(await expiry(row.id)).toBeNull();
    expect(await expiry(alreadySet.id)).toBe(presetExpiry);
  });
});
