import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@desplega/storage";
import { createBunSqliteClient, createSqliteStorage } from "../src";

// app-action-status re-reads an action's run tree every 500 ms for up to 25 s.
// Each level read is LIMITed, but a sort in front of the LIMIT still reads every
// child of a wide level. The plan must walk idx_script_runs_parent_started in
// order (no temp B-tree), so the read stops at the LIMIT. Production never runs
// ANALYZE, so neither does this test.

const MIGRATIONS_DIR = join(import.meta.dir, "../../../src/be/migrations");
const T0 = "2026-11-25T00:00:00.000Z";

let db: Database;
let storage: Storage;
let statements: string[];

beforeEach(() => {
  db = new Database(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  for (const file of files) db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  db.exec(`INSERT INTO agents (id, name, status, createdAt, lastUpdatedAt)
    VALUES ('ag', 'ag', 'idle', '${T0}', '${T0}');
    INSERT INTO script_run_sources (hash, source) VALUES ('h', 'x');`);
  const insert = db.prepare(
    `INSERT INTO script_runs (id, agentId, source, sourceHash, args, startedAt, parentScriptRunId)
     VALUES (?, 'ag', '', 'h', '{}', ?, ?)`,
  );
  db.transaction(() => {
    insert.run("root", T0, null);
    // 10,000 direct children of one root.
    for (let i = 0; i < 10_000; i++) {
      const startedAt = new Date(Date.UTC(2026, 10, 25, 0, 0, i)).toISOString();
      insert.run(`c${String(i).padStart(5, "0")}`, startedAt, "root");
    }
    // A second tree whose second level has a frontier of two parents.
    insert.run("m", T0, null);
    for (const child of ["m-a", "m-b"]) {
      insert.run(child, T0, "m");
      for (let i = 0; i < 2; i++) insert.run(`${child}-${i}`, T0, child);
    }
  })();
  statements = [];
  storage = createSqliteStorage(
    createBunSqliteClient(() => db, undefined, { onStatement: (sql) => statements.push(sql) }),
    { vectorSearch: false },
  );
});

afterEach(() => db.close());

/** Plans of the level reads (children of a frontier) of the last tree read. */
function levelPlans(): string[] {
  return statements
    .filter((sql) => sql.includes(`"parentScriptRunId" IN (`))
    .map((sql) => {
      // The plan does not depend on the bound values.
      const params = (sql.match(/\?/g) ?? []).map(() => 1);
      return db
        .query<{ detail: string }, number[]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((row) => row.detail)
        .join("\n");
    });
}

test("a wide level is read in index order up to the LIMIT, with no sort", async () => {
  const probe = await storage.repos.scripts.listScriptRunTree("root", { maxRows: 1, maxDepth: 0 });
  expect(probe).toMatchObject({ rows: [{ id: "root" }], truncated: true });
  const capped = await storage.repos.scripts.listScriptRunTree("root", {
    maxRows: 3,
    maxDepth: 5,
  });
  expect(capped.rows.map((r) => r.id)).toEqual(["root", "c00000", "c00001"]);
  expect(capped.truncated).toBe(true);
  const plans = levelPlans();
  expect(plans.length).toBe(2);
  for (const plan of plans) {
    expect(plan).toBe(
      "SEARCH script_runs USING INDEX idx_script_runs_parent_started (parentScriptRunId=?)",
    );
  }
});

test("a frontier of several parents reads in index order too, with no sort", async () => {
  const tree = await storage.repos.scripts.listScriptRunTree("m", { maxRows: 6, maxDepth: 5 });
  expect(tree.rows.map((r) => r.id)).toEqual(["m", "m-a", "m-b", "m-a-0", "m-a-1", "m-b-0"]);
  expect(tree.truncated).toBe(true);
  const plans = levelPlans();
  expect(plans.length).toBe(2);
  expect(statements.some((sql) => /"parentScriptRunId" IN \(\?\s*,\s*\?\)/.test(sql))).toBe(true);
  for (const plan of plans) {
    expect(plan).toBe(
      "SEARCH script_runs USING INDEX idx_script_runs_parent_started (parentScriptRunId=?)",
    );
  }
});
