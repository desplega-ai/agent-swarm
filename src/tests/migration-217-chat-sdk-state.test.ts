import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

function setup(): Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE agents (
       id TEXT PRIMARY KEY,
       isLead INTEGER NOT NULL DEFAULT 0
     )`,
  );
  db.exec("INSERT INTO agents (id, isLead) VALUES ('lead', 1), ('worker', 0)");
  db.exec(
    `CREATE TABLE agent_tasks (
       id TEXT PRIMARY KEY,
       status TEXT NOT NULL,
       source TEXT NOT NULL,
       taskType TEXT,
       contextKey TEXT,
       agentId TEXT
     )`,
  );
  return db;
}

function obligations(db: Database): string[] {
  return db
    .query<{ task_id: string }, []>("SELECT task_id FROM chat_relay_obligations ORDER BY task_id")
    .all()
    .map((row) => row.task_id);
}

test("migration 217 creates the chat state tables and the pending index", async () => {
  const db = setup();
  try {
    db.exec(await Bun.file("src/be/migrations/217_chat_sdk_state.sql").text());
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    for (const table of [
      "chat_state_kv",
      "chat_subscriptions",
      "chat_locks",
      "chat_lists",
      "chat_queue",
      "chat_relay_obligations",
    ]) {
      expect(tables).toContain(table);
    }
    const pendingIndex = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE name = 'idx_chat_relay_obligations_pending'",
      )
      .get();
    expect(pendingIndex?.sql).toContain("WHERE delivered_at IS NULL AND given_up_at IS NULL");
    expect(
      db
        .query<{ name: string }, []>("PRAGMA index_list(chat_queue)")
        .all()
        .map((index) => index.name),
    ).toContain("idx_chat_queue_thread");
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
  }
});

test("migration 217 triggers enqueue a relay obligation only for chat-rooted terminal tasks", async () => {
  const db = setup();
  try {
    db.exec(await Bun.file("src/be/migrations/217_chat_sdk_state.sql").text());
    const insert = db.prepare(
      "INSERT INTO agent_tasks (id, status, source, taskType, contextKey, agentId) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const key = "task:chat-sdk:telegram:555";
    insert.run("chat", "in_progress", "chat", "chat-inbound", key, "lead");
    insert.run("slack", "in_progress", "slack", null, "task:slack:C1:1.2", "lead");
    insert.run("followup", "in_progress", "system", "follow-up", key, "lead");
    insert.run("resume-lead", "in_progress", "system", "resume", key, "lead");
    insert.run("resume-worker", "in_progress", "system", "resume", key, "worker");
    insert.run("resume-unassigned", "in_progress", "system", "resume", key, null);
    insert.run("delegated", "in_progress", "system", "delegated", key, "worker");
    insert.run("upper", "in_progress", "chat", null, "TASK:CHAT-SDK:telegram:555", "lead");
    insert.run("done-at-insert", "completed", "chat", null, "task:chat-sdk:telegram:777", "lead");
    insert.run("resume-at-insert", "completed", "system", "resume", key, "lead");

    for (const id of [
      "chat",
      "slack",
      "followup",
      "resume-lead",
      "resume-worker",
      "resume-unassigned",
      "delegated",
      "upper",
    ]) {
      db.run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [id]);
    }
    // A second terminal transition must not add a second row.
    db.run("UPDATE agent_tasks SET status = 'failed' WHERE id = 'chat'");

    expect(obligations(db)).toEqual([
      "chat",
      "done-at-insert",
      "followup",
      "resume-at-insert",
      "resume-lead",
    ]);
  } finally {
    db.close();
  }
});
