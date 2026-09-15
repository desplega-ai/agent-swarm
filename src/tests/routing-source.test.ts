import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";
import { CreateTaskOptionsSchema, RoutingSourceSchema } from "../types";

const migration = await Bun.file(
  new URL("../be/migrations/154_routing_source.sql", import.meta.url),
).text();

describe("routing provenance migration", () => {
  test("preserves historical reasons with unknown provenance and checks new sources", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, routing_reason TEXT);
        INSERT INTO agent_tasks VALUES ('legacy', 'skill');`);
      database.exec(migration);
      expect(database.query("SELECT * FROM agent_tasks").get()).toEqual({
        id: "legacy",
        routing_reason: "skill",
        routing_source: null,
      });
      for (const routingSource of RoutingSourceSchema.options) {
        database.run("INSERT INTO agent_tasks VALUES (?, 'skill', ?)", [
          routingSource,
          routingSource,
        ]);
        expect(CreateTaskOptionsSchema.parse({ routingSource }).routingSource).toBe(routingSource);
      }
      expect(() =>
        database.run("INSERT INTO agent_tasks VALUES ('invalid', 'skill', 'guessed')"),
      ).toThrow();
      expect(CreateTaskOptionsSchema.safeParse({ routingSource: "guessed" }).success).toBe(false);
    } finally {
      database.close();
    }
  });

  test("applies 154 on a fresh database and reruns cleanly", () => {
    const database = new Database(":memory:");
    try {
      runMigrations(database);
      runMigrations(database);
      expect(database.query("SELECT name FROM _migrations WHERE version = 154").all()).toEqual([
        { name: "154_routing_source" },
      ]);
      expect(database.query("PRAGMA table_info(agent_tasks)").all()).toContainEqual(
        expect.objectContaining({ name: "routing_source", notnull: 0, dflt_value: null }),
      );
    } finally {
      database.close();
    }
  });
});
