import { Database } from "bun:sqlite";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { runMigrations } from "../be/migrations/runner";
import { backfillScriptRunSources } from "../be/migrations/script-run-sources";

let schema: string;
let migration: string;
let db: Database;

beforeAll(async () => {
  const dir = `${import.meta.dir}/../be/migrations`;
  schema = await Bun.file(`${dir}/083_script_workflows.sql`).text();
  migration = await Bun.file(`${dir}/342_script_run_sources.sql`).text();
});

afterEach(() => {
  db.close();
});

function legacyDatabase(): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE users (id TEXT PRIMARY KEY)");
  database.exec(schema);
  return database;
}

function insertRun(id: string, source: string): void {
  db.run("INSERT INTO script_runs (id, agentId, source) VALUES (?, 'agent', ?)", [id, source]);
}

function hash(source: string): string {
  return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

function count(sql: string): number {
  return db.prepare<{ n: number }, []>(sql).get()?.n ?? 0;
}

test("fresh migrations install the source schema and resume backfill on later boots", () => {
  db = new Database(":memory:");
  runMigrations(db);
  expect(db.prepare("PRAGMA table_info(script_run_sources)").all()).toMatchObject([
    { name: "hash", pk: 1 },
    { name: "source", notnull: 1 },
  ]);
  expect(db.prepare("PRAGMA foreign_key_list(script_runs)").all()).toContainEqual(
    expect.objectContaining({ table: "script_run_sources", from: "sourceHash", to: "hash" }),
  );
  expect(db.prepare("PRAGMA index_list(script_runs)").all()).toContainEqual(
    expect.objectContaining({ name: "idx_script_runs_sourceHash", partial: 0 }),
  );

  insertRun("legacy", "export default 1");
  // The SQL migration is already recorded; boot must still finish the backfill.
  runMigrations(db);
  expect(
    db.prepare("SELECT source, sourceHash FROM script_runs WHERE id = 'legacy'").get(),
  ).toEqual({
    source: "",
    sourceHash: hash("export default 1"),
  });
  expect(count("SELECT count(*) AS n FROM _migrations WHERE version = 342")).toBe(1);
});

test("existing runs keep their table and journal while exact UTF-8 sources deduplicate", () => {
  db = legacyDatabase();
  const sources = ["same", "same", "", "你好 🌍\n", "é", "e\u0301", "same\n"];
  sources.forEach((source, i) => {
    insertRun(`run-${i}`, source);
  });
  db.run(
    "INSERT INTO script_run_journal (id, runId, stepKey, stepType, status) VALUES ('journal', 'run-0', 'step', 'script', 'completed')",
  );
  const before = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'script_runs'").get();
  const rowids = db.prepare("SELECT rowid, id FROM script_runs ORDER BY rowid").all();

  db.exec(migration);
  backfillScriptRunSources(db);

  expect(db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'script_runs'").get()).toEqual(
    before,
  );
  expect(db.prepare("SELECT rowid, id FROM script_runs ORDER BY rowid").all()).toEqual(rowids);
  expect(count("SELECT count(*) AS n FROM script_run_journal")).toBe(1);
  expect(count("SELECT count(*) AS n FROM script_run_sources")).toBe(6);
  sources.forEach((source, i) => {
    expect(
      db.prepare("SELECT source, sourceHash FROM script_runs WHERE id = ?").get(`run-${i}`),
    ).toEqual({
      source: "",
      sourceHash: hash(source),
    });
    expect(
      db.prepare("SELECT source FROM script_run_sources WHERE hash = ?").get(hash(source)),
    ).toEqual({
      source,
    });
  });
  // Neither whitespace nor Unicode normalization may alter content identity.
  expect(hash("é")).not.toBe(hash("e\u0301"));
});

test("backfill commits bounded batches and rolls an interrupted batch back before restart", () => {
  db = new Database(":memory:");
  runMigrations(db);
  for (let i = 0; i < 60; i++) insertRun(`run-${i.toString().padStart(3, "0")}`, `source ${i}`);
  db.exec(`CREATE TRIGGER interrupt_source_backfill BEFORE UPDATE OF sourceHash ON script_runs
    WHEN NEW.id = 'run-026'
    BEGIN SELECT RAISE(ABORT, 'interrupted backfill'); END`);

  expect(() => runMigrations(db)).toThrow("interrupted backfill");
  expect(count("SELECT count(*) AS n FROM script_runs WHERE sourceHash IS NOT NULL")).toBe(25);
  expect(count("SELECT count(*) AS n FROM script_run_sources")).toBe(25);
  expect(
    db.prepare("SELECT source, sourceHash FROM script_runs WHERE id = 'run-025'").get(),
  ).toEqual({
    source: "source 25",
    sourceHash: null,
  });
  expect(
    db.prepare("SELECT source FROM script_run_sources WHERE hash = ?").get(hash("source 25")),
  ).toBeNull();

  // Reopen the committed database state, as after process termination.
  const snapshot = db.serialize();
  db.close();
  db = Database.deserialize(snapshot);
  db.exec("PRAGMA foreign_keys = ON; DROP TRIGGER interrupt_source_backfill");
  runMigrations(db);
  expect(count("SELECT count(*) AS n FROM script_runs WHERE sourceHash IS NOT NULL")).toBe(60);
  expect(count("SELECT count(*) AS n FROM script_run_sources")).toBe(60);
  expect(count("SELECT count(*) AS n FROM script_runs WHERE source <> ''")).toBe(0);

  const changes = db.prepare("SELECT total_changes() AS n").get();
  backfillScriptRunSources(db);
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("partial upgrades retain already-pinned sources and reuse their content", () => {
  db = legacyDatabase();
  insertRun("pinned", "same");
  insertRun("pending", "same");
  insertRun("unique", "another");
  db.exec(migration);
  db.run("INSERT INTO script_run_sources (hash, source) VALUES (?, 'same')", [hash("same")]);
  db.run("UPDATE script_runs SET sourceHash = ?, source = '' WHERE id = 'pinned'", [hash("same")]);

  backfillScriptRunSources(db);
  expect(count("SELECT count(*) AS n FROM script_run_sources")).toBe(2);
  expect(count("SELECT count(*) AS n FROM script_runs WHERE sourceHash IS NULL")).toBe(0);
  expect(
    db
      .prepare<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM script_runs WHERE sourceHash = ?",
      )
      .get(hash("same"))?.n,
  ).toBe(2);
});

test("foreign keys reject missing sources and retention drops only the final reference", () => {
  db = legacyDatabase();
  insertRun("shared-1", "same");
  insertRun("shared-2", "same");
  insertRun("unique", "unique");
  db.exec(migration);
  backfillScriptRunSources(db);
  db.run(
    "INSERT INTO script_run_journal (id, runId, stepKey, stepType, status) VALUES ('journal', 'shared-2', 'step', 'script', 'completed')",
  );
  expect(() =>
    db.run(
      "INSERT INTO script_runs (id, agentId, source, sourceHash) VALUES ('invalid', 'agent', '', 'missing')",
    ),
  ).toThrow("FOREIGN KEY constraint failed");
  expect(() => db.run("UPDATE script_runs SET sourceHash = 'missing' WHERE id = 'unique'")).toThrow(
    "FOREIGN KEY constraint failed",
  );
  expect(() => db.run("DELETE FROM script_run_sources WHERE hash = ?", [hash("same")])).toThrow(
    "FOREIGN KEY constraint failed",
  );

  db.run("DELETE FROM script_runs WHERE id = 'shared-1'");
  expect(
    db.prepare("SELECT source FROM script_run_sources WHERE hash = ?").get(hash("same")),
  ).toEqual({ source: "same" });
  db.run("DELETE FROM script_runs WHERE id = 'shared-2'");
  expect(
    db.prepare("SELECT source FROM script_run_sources WHERE hash = ?").get(hash("same")),
  ).toBeNull();
  expect(count("SELECT count(*) AS n FROM script_run_journal")).toBe(0);
  expect(count("SELECT count(*) AS n FROM script_run_sources")).toBe(1);
  db.run("DELETE FROM script_runs");
  expect(count("SELECT count(*) AS n FROM script_run_sources")).toBe(0);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
