import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createSessionLogs,
  createTaskExtended,
  getDbClient,
  getSessionLogsBySession,
  getSessionLogsByTaskId,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-session-logs.sqlite";

describe("Session Logs Storage", () => {
  beforeAll(async () => {
    // Clean up any existing test database
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }

    // Initialize test database
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    // Close database
    closeDb();

    // Clean up test database file
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  describe("Database Functions", () => {
    test("should create and retrieve session logs by taskId", async () => {
      // Create a task first
      const task = await createTaskExtended("Test task for session logs");

      // Create session logs for the task
      await createSessionLogs({
        taskId: task.id,
        sessionId: "test-session-1",
        iteration: 1,
        cli: "claude",
        lines: ['{"type":"system"}', '{"type":"assistant","message":"Hello"}'],
      });

      // Retrieve logs
      const logs = await getSessionLogsByTaskId(task.id);

      expect(logs.length).toBe(2);
      expect(logs[0]?.content).toBe('{"type":"system"}');
      expect(logs[1]?.content).toBe('{"type":"assistant","message":"Hello"}');
      expect(logs[0]?.taskId).toBe(task.id);
      expect(logs[0]?.sessionId).toBe("test-session-1");
      expect(logs[0]?.iteration).toBe(1);
      expect(logs[0]?.cli).toBe("claude");
      expect(logs[0]?.lineNumber).toBe(0);
      expect(logs[1]?.lineNumber).toBe(1);
    });

    test("should create session logs without taskId", async () => {
      await createSessionLogs({
        sessionId: "ai-loop-session",
        iteration: 1,
        cli: "claude",
        lines: ['{"type":"system","subtype":"init"}'],
      });

      // Retrieve by session
      const logs = await getSessionLogsBySession("ai-loop-session", 1);

      expect(logs.length).toBe(1);
      expect(logs[0]?.taskId).toBeUndefined();
      expect(logs[0]?.sessionId).toBe("ai-loop-session");
    });

    test("should order logs by iteration and lineNumber", async () => {
      const task = await createTaskExtended("Task for ordering test");

      // Create logs for multiple iterations
      await createSessionLogs({
        taskId: task.id,
        sessionId: "order-session",
        iteration: 1,
        cli: "claude",
        lines: ["line1-iter1", "line2-iter1"],
      });

      await createSessionLogs({
        taskId: task.id,
        sessionId: "order-session",
        iteration: 2,
        cli: "claude",
        lines: ["line1-iter2", "line2-iter2"],
      });

      const logs = await getSessionLogsByTaskId(task.id);

      expect(logs.length).toBe(4);
      // First iteration, first line
      expect(logs[0]?.content).toBe("line1-iter1");
      expect(logs[0]?.iteration).toBe(1);
      expect(logs[0]?.lineNumber).toBe(0);
      // First iteration, second line
      expect(logs[1]?.content).toBe("line2-iter1");
      expect(logs[1]?.iteration).toBe(1);
      expect(logs[1]?.lineNumber).toBe(1);
      // Second iteration, first line
      expect(logs[2]?.content).toBe("line1-iter2");
      expect(logs[2]?.iteration).toBe(2);
      expect(logs[2]?.lineNumber).toBe(0);
      // Second iteration, second line
      expect(logs[3]?.content).toBe("line2-iter2");
      expect(logs[3]?.iteration).toBe(2);
      expect(logs[3]?.lineNumber).toBe(1);
    });

    test("keeps write order across many flushes of one iteration", async () => {
      const task = await createTaskExtended("Task for multi-flush ordering");
      // The runner flushes every 50 lines or 5s, so one iteration arrives as
      // many POSTs. Each POST used to restart lineNumber at 0.
      const written: string[] = [];
      for (let flush = 0; flush < 3; flush++) {
        const lines = [0, 1, 2, 3].map((i) => `flush${flush}-line${i}`);
        written.push(...lines);
        await createSessionLogs({
          taskId: task.id,
          sessionId: "multi-flush-session",
          iteration: 1,
          cli: "claude",
          lines,
        });
      }

      const all = await getSessionLogsByTaskId(task.id);
      expect(all.map((l) => l.content)).toEqual(written);
      expect(all.map((l) => l.lineNumber)).toEqual(written.map((_, i) => i));

      const tail = await getSessionLogsByTaskId(task.id, 5);
      expect(tail.map((l) => l.content)).toEqual(written.slice(-5));

      const bySession = await getSessionLogsBySession("multi-flush-session", 1);
      expect(bySession.map((l) => l.content)).toEqual(written);
    });

    test("sets reasoning columns at insert and classifies a Claude update across POSTs", async () => {
      const claude = (id: string, block: Record<string, unknown>) =>
        JSON.stringify({ type: "assistant", message: { id, role: "assistant", content: [block] } });
      const thinking = (text: string) => ({ type: "thinking", thinking: text, signature: "S" });
      const toolUse = { type: "tool_use", id: "tu", name: "Read", input: {} };
      const lines = [
        '{"type":"system","subtype":"init"}',
        // Sample shape (every post-deploy message): one thinking block, then tool_use.
        claude("msg_1", thinking("plan")),
        claude("msg_1", toolUse),
        // Omitted thinking keeps chars 0, not NULL.
        claude("msg_2", thinking("")),
        claude("msg_2", { type: "text", text: "ok" }),
        // Two thinking blocks before tool_use, split across two POSTs.
        claude("msg_3", thinking("first")),
        claude("msg_3", thinking("update")),
      ];
      await createSessionLogs({
        sessionId: "reasoning-session",
        iteration: 1,
        cli: "claude",
        lines,
      });
      await createSessionLogs({
        sessionId: "reasoning-session",
        iteration: 1,
        cli: "claude",
        lines: [claude("msg_3", toolUse)],
      });
      await createSessionLogs({
        sessionId: "reasoning-codex",
        iteration: 1,
        cli: "codex",
        lines: [
          JSON.stringify({ type: "item.completed", item: { type: "reasoning", summary: ["a"] } }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x" } }),
        ],
      });

      const rows = await getDbClient().query<{
        lineNumber: number;
        reasoningChars: number | null;
        reasoningKind: string | null;
      }>(
        `SELECT lineNumber, reasoningChars, reasoningKind FROM session_logs
         WHERE sessionId IN ('reasoning-session', 'reasoning-codex') ORDER BY rowid`,
      );
      expect(rows.map((r) => [r.lineNumber, r.reasoningChars, r.reasoningKind])).toEqual([
        [0, null, null],
        [1, 4, "reasoning"],
        [2, null, null],
        [3, 0, "reasoning"],
        [4, null, null],
        [5, 5, "reasoning"],
        [6, 6, "update"],
        [7, null, null],
        [0, 1, "reasoning"],
        [1, null, null],
      ]);
    });

    test("reasoning queries use the partial index", async () => {
      const plan = async (sql: string, params: string[]) =>
        (await getDbClient().query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)).map(
          (r) => r.detail,
        );
      const stats = await plan(
        `SELECT cli, reasoningKind, count(*), sum(reasoningChars > 0), sum(reasoningChars)
         FROM session_logs
         WHERE reasoningChars IS NOT NULL AND createdAt >= ? AND createdAt < ?
         GROUP BY cli, reasoningKind`,
        ["2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z"],
      );
      expect(stats.join("\n")).toContain("USING COVERING INDEX idx_session_logs_reasoning");
      const lookup = await plan(
        `SELECT id, lineNumber, json_extract(content, '$.message.id') AS messageId
         FROM session_logs INDEXED BY idx_session_logs_reasoning
         WHERE reasoningChars IS NOT NULL AND createdAt >= ? AND cli = 'claude' AND sessionId = ?`,
        ["2026-11-08T00:00:00.000Z", "s"],
      );
      expect(lookup.join("\n")).toContain("USING INDEX idx_session_logs_reasoning");
    });

    test("reads rows stored with per-flush lineNumbers in write order", async () => {
      const task = await createTaskExtended("Task with legacy session log rows");
      // Rows written before the fix: lineNumber restarts per POST, and
      // createdAt ties inside one POST.
      const legacy = [
        ["a0", 0],
        ["a1", 1],
        ["a2", 2],
        ["b0", 0],
        ["b1", 1],
        ["c0", 0],
      ] as const;
      await getDbClient().transaction(async (tx) => {
        for (const [content, lineNumber] of legacy) {
          await tx.run(
            `INSERT INTO session_logs (id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt)
             VALUES (?, ?, 'legacy-session', 1, 'claude', ?, ?, '2026-10-01T00:00:00.000Z')`,
            [crypto.randomUUID(), task.id, content, lineNumber],
          );
        }
      });
      // A flush after deploy lands behind the legacy rows.
      await createSessionLogs({
        taskId: task.id,
        sessionId: "legacy-session",
        iteration: 1,
        cli: "claude",
        lines: ["d0", "d1"],
      });

      const written = ["a0", "a1", "a2", "b0", "b1", "c0", "d0", "d1"];
      const all = await getSessionLogsByTaskId(task.id);
      expect(all.map((l) => l.content)).toEqual(written);

      const tail = await getSessionLogsByTaskId(task.id, 4);
      expect(tail.map((l) => l.content)).toEqual(["b1", "c0", "d0", "d1"]);

      const bySession = await getSessionLogsBySession("legacy-session", 1);
      expect(bySession.map((l) => l.content)).toEqual(written);
    });
  });
});
