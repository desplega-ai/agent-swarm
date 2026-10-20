import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("migration 232 preserves every token kind and adds agent-only tokens", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(await Bun.file("src/be/migrations/149_session_tokens.sql").text());
    db.exec(await Bun.file("src/be/migrations/207_runtime_session_tokens.sql").text());
    const seed = db.query(
      `INSERT INTO session_tokens
       (id, tokenHash, tokenPreview, agentId, taskId, runtimeId, parentRuntimeId, controllerId,
        expiresAt, revokedAt, createdAt, lastUsedAt)
       VALUES (?, ?, 'view', 'agent', ?, ?, ?, ?, '2030-01-01', NULL, '2025-01-01', '2025-12-01')`,
    );
    seed.run("acp", "acp", "task", null, null, null);
    seed.run("runtime", "runtime", null, "runtime", null, null);
    seed.run("child", "child", "task", null, "runtime", null);
    seed.run("controller", "controller", null, null, null, "ctrl");
    const before = db.query("SELECT * FROM session_tokens ORDER BY id").all();

    db.exec(await Bun.file("src/be/migrations/232_agent_session_tokens.sql").text());

    // prepare, not query: query() caches the statement and its pre-migration column list.
    expect(db.prepare("SELECT * FROM session_tokens ORDER BY id").all()).toEqual(
      before.map((row) => ({ ...(row as object), parentTokenId: null })),
    );
    const insert = db.query(
      `INSERT INTO session_tokens
       (id, tokenHash, tokenPreview, agentId, taskId, runtimeId, parentRuntimeId, controllerId,
        parentTokenId, expiresAt)
       VALUES (?, ?, 'view', 'agent', ?, ?, ?, ?, ?, '2030-01-01')`,
    );
    insert.run("worker", "worker", null, null, null, null, null);
    insert.run("worker-child", "worker-child", "task", null, null, null, "worker");
    expect(() => insert.run("mixed", "mixed", "task", "runtime", null, null, null)).toThrow();
    expect(() =>
      insert.run("two-parents", "two-parents", "task", null, "rt", null, "worker"),
    ).toThrow();
    expect(() =>
      insert.run("runtime-parent-token", "runtime-parent-token", null, "rt", null, null, "worker"),
    ).toThrow();
    expect(() =>
      insert.run("controller-parent", "controller-parent", null, null, null, "ctrl", "worker"),
    ).toThrow();
    expect(() =>
      insert.run("agent-parent-runtime", "agent-parent-runtime", null, null, "rt", null, null),
    ).toThrow();
    expect(() =>
      insert.run("agent-with-parent", "agent-with-parent", null, null, null, null, "worker"),
    ).toThrow();
    const indexes = db
      .query<{ name: string }, []>("PRAGMA index_list(session_tokens)")
      .all()
      .map((row) => row.name);
    for (const name of [
      "idx_session_tokens_agentId",
      "idx_session_tokens_runtimeId",
      "idx_session_tokens_parentRuntimeId",
      "idx_session_tokens_parentTokenId",
    ]) {
      expect(indexes).toContain(name);
    }
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
  }
});
