import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("migration 207 preserves ACP rows and enforces exclusive token bindings", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(await Bun.file("src/be/migrations/149_session_tokens.sql").text());
    db.run(
      `INSERT INTO session_tokens
       (id, tokenHash, tokenPreview, agentId, taskId, expiresAt, revokedAt, createdAt, lastUsedAt)
       VALUES ('acp', 'hash', 'view', 'agent', 'task', '2030-01-01', '2026-01-01', '2025-01-01', '2025-12-01')`,
    );
    const old = db.query("SELECT * FROM session_tokens").get();
    db.exec(await Bun.file("src/be/migrations/207_runtime_session_tokens.sql").text());
    expect(db.prepare("SELECT * FROM session_tokens").get()).toEqual({
      ...old!,
      runtimeId: null,
      parentRuntimeId: null,
      controllerId: null,
    });
    const insert = db.query(
      `INSERT INTO session_tokens
       (id, tokenHash, tokenPreview, agentId, taskId, runtimeId, parentRuntimeId, controllerId, expiresAt)
       VALUES (?, ?, 'view', 'agent', ?, ?, ?, ?, '2030-01-01')`,
    );
    expect(() => insert.run("none", "none", null, null, null, null)).toThrow();
    expect(() => insert.run("mixed", "mixed", "task", "runtime", null, null)).toThrow();
    expect(() =>
      insert.run("controller-task", "controller-task", "task", null, null, "ctrl"),
    ).toThrow();
    expect(() =>
      insert.run("parent-runtime", "parent-runtime", null, "runtime", "parent", null),
    ).toThrow();
    insert.run("runtime", "runtime", null, "runtime", null, null);
    insert.run("child", "child", "task", null, "runtime", null);
    insert.run("controller", "controller", null, null, null, "ctrl");
    const indexes = db.query<{ name: string }, []>("PRAGMA index_list(session_tokens)").all();
    expect(indexes.map((row) => row.name)).toContain("idx_session_tokens_agentId");
    expect(indexes.map((row) => row.name)).toContain("idx_session_tokens_runtimeId");
    expect(indexes.map((row) => row.name)).toContain("idx_session_tokens_parentRuntimeId");
    db.exec("PRAGMA integrity_check");
  } finally {
    db.close();
  }
});
