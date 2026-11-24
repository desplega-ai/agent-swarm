import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteCopySource } from "../src/copy-source";

/**
 * The SQLite side of db-copy on a file as a deployment leaves it: tables that a
 * backup tool added, and rows that lost their parent while foreign keys were off.
 */

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "copy-source-"));
  path = join(dir, "source.sqlite");
  const db = new Database(path);
  db.run("CREATE TABLE parents (id TEXT PRIMARY KEY)");
  db.run(
    `CREATE TABLE children (
       id TEXT PRIMARY KEY,
       parent TEXT REFERENCES parents (id) ON DELETE CASCADE,
       a TEXT, b TEXT,
       FOREIGN KEY (a, b) REFERENCES pairs (a, b)
     )`,
  );
  db.run("CREATE TABLE pairs (a TEXT, b TEXT, PRIMARY KEY (a, b))");
  db.run("INSERT INTO parents VALUES ('p1')");
  db.run("INSERT INTO pairs VALUES ('x', 'y')");
  db.run("INSERT INTO children VALUES ('kept', 'p1', 'x', 'y')");
  db.run("INSERT INTO children VALUES ('lost parent', 'gone', NULL, NULL)");
  db.run("INSERT INTO children VALUES ('lost pair', NULL, 'x', 'z')");
  // Litestream creates these two in every database it replicates.
  db.run("CREATE TABLE _litestream_seq (id INTEGER PRIMARY KEY, seq INTEGER)");
  db.run("CREATE TABLE _litestream_lock (id INTEGER)");
  db.run("INSERT INTO _litestream_seq VALUES (1, 42)");
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openSqliteCopySource", () => {
  test("skips the Litestream bookkeeping tables and names the reason", () => {
    const source = openSqliteCopySource(path);
    try {
      expect(source.tables().map((t) => t.name)).toEqual(["children", "pairs", "parents"]);
      expect(source.skippedTables()).toEqual([
        {
          name: "_litestream_lock",
          reason: "Litestream replication bookkeeping: not application data",
        },
        {
          name: "_litestream_seq",
          reason: "Litestream replication bookkeeping: not application data",
        },
      ]);
    } finally {
      source.close();
    }
  });

  test("lists each orphan row with its parent table, key columns and delete action", () => {
    const source = openSqliteCopySource(path);
    try {
      const orphans = source.foreignKeyViolations?.() ?? [];
      expect(orphans.sort((x, y) => x.row.localeCompare(y.row))).toEqual([
        {
          table: "children",
          row: "rowid 2",
          parent: "parents",
          columns: ["parent"],
          onDelete: "CASCADE",
        },
        {
          table: "children",
          row: "rowid 3",
          parent: "pairs",
          columns: ["a", "b"],
          onDelete: "NO ACTION",
        },
      ]);
    } finally {
      source.close();
    }
  });

  test("ends a batch at the byte limit, and a larger row goes alone", () => {
    const db = new Database(path);
    db.run("CREATE TABLE blobs (id INTEGER PRIMARY KEY, body TEXT)");
    const insert = db.prepare("INSERT INTO blobs (body) VALUES (?)");
    for (const size of [10, 10, 10, 5000, 10, 10]) insert.run("x".repeat(size));
    db.close();
    const source = openSqliteCopySource(path);
    try {
      const table = source.tables().find((t) => t.name === "blobs");
      if (!table) throw new Error("no blobs table");
      const sizes = (batchBytes?: number) =>
        [...source.rows(table, 4, batchBytes)].map((batch) => batch.length);
      // Rows only: 4 + 2. With a 25-byte limit: 3 small rows, the large row alone, 2 small rows.
      expect(sizes()).toEqual([4, 2]);
      expect(sizes(25)).toEqual([3, 1, 2]);
    } finally {
      source.close();
    }
  });

  test("a source with no orphan row lists none", () => {
    const db = new Database(path);
    db.run("DELETE FROM children WHERE id <> 'kept'");
    db.close();
    const source = openSqliteCopySource(path);
    try {
      expect(source.foreignKeyViolations?.()).toEqual([]);
    } finally {
      source.close();
    }
  });
});
