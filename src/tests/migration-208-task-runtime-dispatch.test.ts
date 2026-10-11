import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("migration 208 preserves existing task rows and records independent runtime slots", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    db.run("INSERT INTO agent_tasks VALUES ('existing', 'in_progress')");
    db.exec(await Bun.file("src/be/migrations/208_task_runtime_dispatch.sql").text());
    expect(db.query("SELECT * FROM agent_tasks").get()).toEqual({
      id: "existing",
      status: "in_progress",
      runtime_instance_id: null,
    });
    db.run("UPDATE agent_tasks SET runtime_instance_id = 'runtime' WHERE id = 'existing'");
    db.run("INSERT INTO agent_tasks VALUES ('second', 'in_progress', 'runtime')");
    expect(
      db.query("SELECT id FROM agent_tasks WHERE runtime_instance_id = 'runtime'").all(),
    ).toHaveLength(2);
    expect(
      db
        .query<{ name: string }, []>("PRAGMA index_list(agent_tasks)")
        .all()
        .map((index) => index.name),
    ).toContain("idx_agent_tasks_runtime_instance_id");
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    db.close();
  }
});
