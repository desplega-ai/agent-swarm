import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";

function verifyColumns(db: Database) {
  for (const table of ["runtime_pools", "runtime_controllers"]) {
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    expect(columns).toContain("created_by");
    expect(columns).toContain("updated_by");
  }
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(runtime_instances)")
    .all()
    .map((row) => row.name);
  for (const column of [
    "pool_id",
    "controller_id",
    "external_handle",
    "provision_attempts",
    "provision_error",
    "provision_requested_at",
    "draining",
    "idle_since",
    "lease_expires_at",
    "task_id",
  ])
    expect(columns).toContain(column);
  const agentColumns = db
    .query<{ name: string }, []>("PRAGMA table_info(agents)")
    .all()
    .map((row) => row.name);
  for (const column of [
    "runtime_pool_id",
    "runtime_provision_attempts",
    "runtime_provision_retry_at",
  ])
    expect(agentColumns).toContain(column);
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(agent_tasks)")
      .all()
      .map((row) => row.name),
  ).toContain("pool_wake_at");
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}
test("migration 206 applies on a fresh database", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    verifyColumns(db);
  } finally {
    db.close();
  }
});
test("migration 206 preserves agents and runtimes in a database at 205", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "PRAGMA foreign_keys = OFF; CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)",
    );
    const files = [...new Bun.Glob("*.sql").scanSync("src/be/migrations")]
      .sort()
      .filter((name) => Number(name.split("_")[0]) <= 205);
    for (const file of files) {
      const sql = await Bun.file(`src/be/migrations/${file}`).text();
      db.transaction(() => {
        db.exec(sql);
        db.run("INSERT INTO _migrations VALUES (?, ?, ?, ?)", [
          Number(file.split("_")[0]),
          file.replace(".sql", ""),
          new Date().toISOString(),
          new Bun.CryptoHasher("sha256").update(sql).digest("hex"),
        ]);
      }).immediate();
    }
    const agentId = crypto.randomUUID();
    const runtimeId = crypto.randomUUID();
    db.run(
      "INSERT INTO agents (id, name, isLead, status, createdAt, lastUpdatedAt) VALUES (?, 'existing-worker', 0, 'idle', ?, ?)",
      [agentId, new Date().toISOString(), new Date().toISOString()],
    );
    db.run("INSERT INTO runtime_instances (id, agent_id, metadata) VALUES (?, ?, ?)", [
      runtimeId,
      agentId,
      JSON.stringify({ existing: true }),
    ]);
    const taskId = crypto.randomUUID();
    db.run(
      "INSERT INTO agent_tasks (id, agentId, task, status, source, routing_reason, routing_note, createdAt, lastUpdatedAt) VALUES (?, ?, 'existing-task', 'pending', 'mcp', 'human_pinned', 'keep-note', ?, ?)",
      [taskId, agentId, new Date().toISOString(), new Date().toISOString()],
    );
    runMigrations(db);
    verifyColumns(db);
    expect(
      db
        .query(
          "SELECT name, runtime_pool_id, runtime_provision_attempts, runtime_provision_retry_at FROM agents WHERE id = ?",
        )
        .get(agentId),
    ).toEqual({
      name: "existing-worker",
      runtime_pool_id: null,
      runtime_provision_attempts: 0,
      runtime_provision_retry_at: null,
    });
    expect(
      db
        .query("SELECT routing_reason, routing_note, pool_wake_at FROM agent_tasks WHERE id = ?")
        .get(taskId),
    ).toEqual({
      routing_reason: "human_pinned",
      routing_note: "keep-note",
      pool_wake_at: null,
    });
    expect(
      db
        .query(
          "SELECT status, provision_attempts, pool_id, draining, metadata FROM runtime_instances WHERE id = ?",
        )
        .get(runtimeId),
    ).toEqual({
      status: "active",
      provision_attempts: 0,
      pool_id: null,
      draining: 0,
      metadata: JSON.stringify({ existing: true }),
    });
  } finally {
    db.close();
  }
});
