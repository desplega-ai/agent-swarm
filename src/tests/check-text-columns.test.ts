import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkTextColumns,
  listTextColumns,
  TEXT_COLUMNS_PATH,
  type TextColumnClassification,
} from "../../scripts/check-text-columns";
import { runMigrations } from "../be/migrations/runner";
import { type ScrubbedText, scrubSecrets } from "../utils/secret-scrubber";

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

  test("ScrubbedText is a plain string at runtime and only scrubSecrets produces it", () => {
    const writer = (value: ScrubbedText): string => value;
    const secret = `ghp_${"Z".repeat(36)}`;
    const scrubbed = scrubSecrets(`token ${secret}`);

    expect(typeof scrubbed).toBe("string");
    expect(writer(scrubbed)).not.toContain(secret);
    expect(writer(scrubbed)).toContain("[REDACTED:");
    // @ts-expect-error a raw string must not satisfy a ScrubbedText parameter
    expect(writer(`token ${secret}`)).toContain(secret);
  });
});
