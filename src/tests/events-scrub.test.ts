import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb } from "../be/db";
import { createEvent, createEventsBatch } from "../be/events";
import { randomToken, syntheticSecret } from "./synthetic-secret-helpers";

const TEST_DB_PATH = "./test-events-scrub.sqlite";

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

async function readData(sessionId: string): Promise<string[]> {
  const rows = await getDbClient().query<{ data: string | null }>(
    "SELECT data FROM events WHERE sessionId = ? ORDER BY rowid",
    [sessionId],
  );
  return rows.map((r) => r.data ?? "");
}

describe("events.data scrub at write", () => {
  test("createEvent redacts a secret in the payload and keeps valid JSON", async () => {
    const pat = ["ghp", randomToken(36)].join("_");
    const sessionId = crypto.randomUUID();
    await createEvent({
      category: "session",
      event: "session.start",
      source: "api",
      sessionId,
      data: { note: "cloned repo with token", output: `remote: ${pat} ok`, count: 3 },
    });

    const [raw] = await readData(sessionId);
    expect(raw).toBeDefined();
    expect(raw).not.toContain(pat);
    expect(raw).toContain("[REDACTED:");
    const parsed = JSON.parse(raw as string);
    expect(parsed.note).toBe("cloned repo with token");
    expect(parsed.output).toStartWith("remote: ");
    expect(parsed.output).toEndWith(" ok");
    expect(parsed.count).toBe(3);
  });

  test("createEventsBatch redacts every row and keeps valid JSON", async () => {
    // Registered per test: the preload clears volatile secrets after each one.
    const known = syntheticSecret("evscrub");
    const sessionId = crypto.randomUUID();
    const count = await createEventsBatch([
      {
        category: "tool",
        event: "tool.start",
        source: "worker",
        sessionId,
        data: { tool: "Bash", input: `echo ${known.value}` },
      },
      {
        category: "tool",
        event: "tool.end",
        source: "worker",
        sessionId,
        data: { tool: "Bash", nested: { lines: ["first", `leaked ${known.value} here`] } },
      },
    ]);
    expect(count).toBe(2);

    const rows = await readData(sessionId);
    expect(rows).toHaveLength(2);
    for (const raw of rows) {
      expect(raw).not.toContain(known.value);
      expect(raw).toContain(`[REDACTED:${known.name}]`);
      expect(JSON.parse(raw).tool).toBe("Bash");
    }
    expect(JSON.parse(rows[0] as string).input).toStartWith("echo ");
    expect(JSON.parse(rows[1] as string).nested.lines[0]).toBe("first");
  });
});
