import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createUser,
  getDbClient,
  initDb,
  listInboxState,
  upsertInboxState,
} from "../be/db";
import { handleInboxState } from "../http/inbox-state";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-inbox-state.sqlite";
const earlier = "2026-01-01T00:00:00.000Z";
const later = "2026-02-01T00:00:00.000Z";
let userId: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  userId = (await createUser({ name: "Inbox User", email: "inbox-state@example.com" })).id;
  server = createServer(async (req, res) => {
    const url = req.url ?? "";
    if (await handleInboxState(req, res, getPathSegments(url), parseQueryParams(url))) return;
    res.writeHead(404).end();
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = Bun.file(`${TEST_DB_PATH}${suffix}`);
    if (await file.exists()) await file.delete();
  }
});

async function patch(path: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/inbox-state${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, ...body }),
  });
}

describe("inbox read cursor", () => {
  test("sets, preserves, moves back, and clears the cursor independently of sticky readAt", async () => {
    const item = {
      userId,
      itemType: "to_read" as const,
      itemId: "cursor",
      status: "open" as const,
    };
    const initial = await upsertInboxState(item);
    expect(initial.lastReadAt).toBeUndefined();
    const set = await upsertInboxState({ ...item, readAt: earlier, lastReadAt: later });
    expect(set.lastReadAt).toBe(later);
    expect((await upsertInboxState({ ...item, readAt: later })).lastReadAt).toBe(later);
    const movedBack = await upsertInboxState({ ...item, readAt: later, lastReadAt: earlier });
    expect(movedBack.lastReadAt).toBe(earlier);
    expect(movedBack.readAt).toBe(earlier);
    const cleared = await upsertInboxState({ ...item, status: "done", lastReadAt: null });
    expect(cleared.lastReadAt).toBeUndefined();
    expect(cleared.readAt).toBe(earlier);
    expect(cleared.status).toBe("done");
    expect(
      (await listInboxState({ userId })).find((row) => row.id === set.id)?.lastReadAt,
    ).toBeUndefined();
  });

  test("single PATCH accepts a timestamp and null", async () => {
    const item = { itemType: "to_read", itemId: "http-cursor", status: "open" };
    const set = await patch("", { ...item, readAt: earlier, lastReadAt: later });
    expect(set.status).toBe(200);
    expect((await set.json()).item.lastReadAt).toBe(later);
    const cleared = await patch("", { ...item, lastReadAt: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).item).toMatchObject({ readAt: earlier });
    expect(
      (await listInboxState({ userId })).find((row) => row.itemId === item.itemId)?.lastReadAt,
    ).toBeUndefined();
  });
});

describe("bulk inbox state", () => {
  test("returns rows in request order and applies single-item cursor semantics", async () => {
    const item = { itemType: "to_read", itemId: "bulk-cursor", status: "open" };
    const response = await patch("/bulk", {
      items: [
        { ...item, readAt: earlier, lastReadAt: later },
        { ...item, readAt: later },
        { ...item, lastReadAt: earlier },
        { ...item, lastReadAt: null },
        { ...item, itemId: "bulk-other", status: "dismissed" },
      ],
    });
    expect(response.status).toBe(200);
    const { items } = await response.json();
    expect(items.map((row: { itemId: string }) => row.itemId)).toEqual([
      "bulk-cursor",
      "bulk-cursor",
      "bulk-cursor",
      "bulk-cursor",
      "bulk-other",
    ]);
    expect(items.map((row: { lastReadAt?: string }) => row.lastReadAt)).toEqual([
      later,
      later,
      earlier,
      undefined,
      undefined,
    ]);
    expect(items.slice(0, 4).every((row: { readAt: string }) => row.readAt === earlier)).toBe(true);
  });

  test("rejects an invalid item before writing anything", async () => {
    const response = await patch("/bulk", {
      items: [
        { itemType: "to_read", itemId: "must-not-write", status: "open" },
        { itemType: "to_read", itemId: "invalid-cursor", status: "open", lastReadAt: "invalid" },
      ],
    });
    expect(response.status).toBe(400);
    expect((await listInboxState({ userId })).some((row) => row.itemId === "must-not-write")).toBe(
      false,
    );
  });

  test("rejects empty batches and more than 200 items", async () => {
    for (const count of [0, 201]) {
      const response = await patch("/bulk", {
        items: Array.from({ length: count }, (_, i) => ({
          itemType: "to_read",
          itemId: `limit-${i}`,
          status: "open",
        })),
      });
      expect(response.status).toBe(400);
    }
    expect((await listInboxState({ userId })).some((row) => row.itemId.startsWith("limit-"))).toBe(
      false,
    );
  });

  test("rolls back earlier writes when a later upsert fails", async () => {
    await getDbClient().run(`CREATE TRIGGER reject_inbox_state_test BEFORE INSERT ON inbox_item_state
      WHEN NEW.itemId = 'reject-write' BEGIN SELECT RAISE(ABORT, 'test write failure'); END`);
    try {
      const response = await patch("/bulk", {
        items: [
          { itemType: "to_read", itemId: "rolled-back", status: "open" },
          { itemType: "to_read", itemId: "reject-write", status: "open" },
        ],
      });
      expect(response.status).toBe(500);
      expect((await listInboxState({ userId })).some((row) => row.itemId === "rolled-back")).toBe(
        false,
      );
    } finally {
      await getDbClient().run("DROP TRIGGER reject_inbox_state_test");
    }
  });
});
