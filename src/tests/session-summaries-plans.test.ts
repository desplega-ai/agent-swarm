import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  countSessions,
  createTaskExtended,
  createUser,
  getDbClient,
  initDb,
  listRecentSessions,
} from "../be/db";
import {
  getSessionReadState,
  getSessionTree,
  legacySessionSummaryQuery,
  triageSessionList,
} from "../be/db/session-tree";

const TEST_DB_PATH = "./test-session-summaries-plans.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
}

// Runs the real caller and returns the plans of every statement it sent.
async function plansOf(run: () => Promise<unknown>): Promise<string[]> {
  const client = getDbClient();
  const seen: { sql: string; params: unknown[] }[] = [];
  const methods = ["query", "get", "run"] as const;
  const originals = methods.map((name) => client[name].bind(client));
  const spies = methods.map((name, i) =>
    spyOn(client, name).mockImplementation(((sql: string, params?: unknown[]) => {
      seen.push({ sql, params: params ?? [] });
      return (originals[i] as (sql: string, params?: unknown[]) => unknown)(sql, params);
    }) as never),
  );
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(seen.length).toBeGreaterThan(0);
  const plans: string[] = [];
  for (const { sql, params } of seen) {
    const rows = await client.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${sql}`,
      params as (string | number | null)[],
    );
    plans.push(rows.map((row) => row.detail).join("\n"));
  }
  return plans;
}

let userId = "";

describe("session read plans without sqlite_stat1", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    userId = (await createUser({ name: "plans viewer" })).id;
    const root = await createTaskExtended("plans root", {
      source: "ui",
      requestedByUserId: userId,
    });
    await createTaskExtended("plans child", { parentTaskId: root.id });
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles();
  });

  test("the test DB has no planner statistics, like production", async () => {
    const stat = await getDbClient().get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'",
    );
    expect(stat).toBeNull();
  });

  const viewer = () => ({ userId, scope: "all" as const });
  const now = "2026-10-29T12:00:00.000Z";
  const CASES: [string, () => Promise<unknown>][] = [
    ["list", () => listRecentSessions({ viewer: viewer(), now, slim: true, tree: true })],
    ["list inbox", () => listRecentSessions({ viewer: viewer(), now, triage: "inbox" })],
    ["list done", () => listRecentSessions({ viewer: viewer(), now, triage: "done" })],
    ["list group", () => listRecentSessions({ viewer: viewer(), now, groupKey: "shared/" })],
    ["list status", () => listRecentSessions({ viewer: viewer(), now, status: "needs" })],
    ["list with user", () => listRecentSessions({ viewer: viewer(), now, withUserId: userId })],
    ["count", () => countSessions({ viewer: viewer(), now, tree: true })],
    ["count inbox", () => countSessions({ viewer: viewer(), now, triage: "inbox" })],
    ["count source", () => countSessions({ source: ["slack"] })],
    ["tree", () => getSessionTree({ kind: "user", userId }, now)],
    ["tree mine", () => getSessionTree({ kind: "user", userId }, now, { mine: true })],
    ["read state", () => getSessionReadState(userId, userId, now)],
    ["triage list", () => triageSessionList(userId, { triage: "inbox", now }, "read")],
  ];

  for (const [name, run] of CASES) {
    test(`${name} reads the summaries without a chain walk or task scan`, async () => {
      for (const detail of await plansOf(run)) {
        expect(detail).not.toContain("RECURSIVE");
        expect(detail).not.toMatch(/\bSCAN agent_tasks\b/);
        expect(detail).not.toMatch(/\bSCAN (r|rt|t)\b/);
      }
    });
  }

  test("the chain walk trips the same checks (control)", async () => {
    const query = legacySessionSummaryQuery({ viewer: viewer(), now });
    const [detail] = await plansOf(() => getDbClient().query(query.sql, query.params));
    expect(detail).toMatch(/RECURSIVE|\bSCAN agent_tasks\b|\bSCAN (r|t)\b/);
  });

  test("the list reads agent_tasks only for the page roots", async () => {
    const [detail] = await plansOf(() => listRecentSessions({ viewer: viewer(), now, slim: true }));
    expect(detail).toContain("SEARCH r USING INDEX sqlite_autoindex_agent_tasks_1 (id=?)");
    expect(detail).toContain("SCAN session_summaries USING INDEX idx_session_summaries_activity");
  });
});
