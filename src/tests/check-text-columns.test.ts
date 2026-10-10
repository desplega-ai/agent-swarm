import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  checkTextColumns,
  listTextColumns,
  TEXT_COLUMNS_PATH,
  type TextColumnClassification,
} from "../../scripts/check-text-columns";
import {
  closeDb,
  createAgent,
  createTask,
  getDbClient,
  initDb,
  updateTaskProgress,
} from "../be/db";
import { runMigrations } from "../be/migrations/runner";
import { type SyntheticSecret, syntheticSecret } from "./synthetic-secret-helpers";

const repoRoot = join(import.meta.dir, "..", "..");

async function loadCommitted(): Promise<TextColumnClassification> {
  return (await Bun.file(join(repoRoot, TEXT_COLUMNS_PATH)).json()) as TextColumnClassification;
}

describe("TEXT-column classification check", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    const originalLog = console.log;
    console.log = () => {};
    try {
      runMigrations(db);
    } finally {
      console.log = originalLog;
    }
  });

  afterAll(() => {
    db.close();
  });

  test("the committed classification covers the migrated schema exactly", async () => {
    const classification = await loadCommitted();
    expect(listTextColumns(db).length).toBeGreaterThan(100);
    expect(checkTextColumns(db, classification)).toEqual([]);
  });

  test("a new TEXT column from a later migration fails until it is classified", async () => {
    const classification = await loadCommitted();
    const scratch = new Database(":memory:");
    try {
      const originalLog = console.log;
      console.log = () => {};
      try {
        runMigrations(scratch);
      } finally {
        console.log = originalLog;
      }
      // Stand-in for a future migration that adds a free-text sink.
      scratch.run("CREATE TABLE canary_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL, n INTEGER)");

      const violations = checkTextColumns(scratch, classification);
      expect(violations).toEqual([
        "canary_notes.id: unclassified TEXT column",
        "canary_notes.body: unclassified TEXT column",
      ]);

      const classified: TextColumnClassification = {
        ...classification,
        canary_notes: { id: { exempt: "identifier" }, body: { pending: "test batch" } },
      };
      expect(checkTextColumns(scratch, classified)).toEqual([]);
    } finally {
      scratch.close();
    }
  });

  test("stale and malformed entries are rejected", async () => {
    const classification = await loadCommitted();
    const firstTable = Object.keys(classification)[0] as string;
    const firstColumn = Object.keys(classification[firstTable] ?? {})[0] as string;
    const bad = {
      ...classification,
      [firstTable]: { ...classification[firstTable], [firstColumn]: { exempt: "" } },
      gone_table: { note: "scrubbed" },
    } as TextColumnClassification;

    const violations = checkTextColumns(db, bad);
    expect(violations).toContain("gone_table.note: stale entry, no such TEXT column");
    expect(
      violations.some((v) => v.startsWith(`${firstTable}.${firstColumn}: invalid entry`)),
    ).toBe(true);
  });
});

describe("ScrubbedText at a production writer", () => {
  const dbPath = "./test-check-text-columns-writer.sqlite";
  let secret: SyntheticSecret;

  async function removeDbFiles(): Promise<void> {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(dbPath + suffix);
      } catch {}
    }
  }

  beforeAll(async () => {
    await removeDbFiles();
    initDb(dbPath);
    secret = syntheticSecret("textcol");
  });

  afterAll(async () => {
    secret.cleanup();
    closeDb();
    await removeDbFiles();
  });

  test("a column classified scrubbed holds no secret after its real writer runs", async () => {
    const committed = await loadCommitted();
    expect(committed.agent_tasks?.progress).toBe("scrubbed");

    const agent = await createAgent({
      name: "text-columns-writer",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTask(agent.id, "classification writer check");
    await updateTaskProgress(task.id, `step 2 of 3 token=${secret.value} done`);

    const row = await getDbClient().get<{ progress: string }>(
      "SELECT progress FROM agent_tasks WHERE id = ?",
      [task.id],
    );
    expect(row?.progress).toContain("step 2 of 3");
    expect(row?.progress).toContain(`[REDACTED:${secret.name}]`);
    expect(row?.progress.includes(secret.value)).toBe(false);
  });
});
