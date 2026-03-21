import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";

// Migrations + mock.module + @slack/bolt resolution can take >5s on cold start
setDefaultTimeout(30_000);

// ─── Mock Slack client (must be before channel-activity import) ─────────────

// Mutable mock implementation — changed per test via reassignment
let historyImpl: (args: Record<string, unknown>) => Promise<{
  messages?: Array<Record<string, unknown>>;
}> = () => Promise.resolve({ messages: [] });

mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: {
      auth: { test: () => Promise.resolve({ user_id: "UBOT123" }) },
      conversations: {
        history: (args: Record<string, unknown>) => historyImpl(args),
        list: () =>
          Promise.resolve({
            channels: [
              { id: "C001", name: "general", is_member: true },
              { id: "C002", name: "random", is_member: true },
              { id: "C003", name: "archived", is_member: false },
            ],
            response_metadata: {},
          }),
      },
    },
  }),
}));

import {
  closeDb,
  getAllChannelActivityCursors,
  getChannelActivityCursor,
  initDb,
  upsertChannelActivityCursor,
} from "../be/db";
import { fetchChannelActivity } from "../slack/channel-activity";

const TEST_DB_PATH = `./test-channel-activity-${process.pid}.sqlite`;

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
});

// ─── DB Functions ──────────────────────────────────────────────────────────────

describe("Channel Activity Cursors — DB functions", () => {
  test("getChannelActivityCursor returns null for non-existent channel", () => {
    const cursor = getChannelActivityCursor("C_NONEXISTENT");
    expect(cursor).toBeNull();
  });

  test("getAllChannelActivityCursors returns an array", () => {
    const cursors = getAllChannelActivityCursors();
    expect(Array.isArray(cursors)).toBe(true);
  });

  test("upsertChannelActivityCursor inserts a new cursor", () => {
    upsertChannelActivityCursor("C_INSERT_TEST", "1711111111.000001");
    const cursor = getChannelActivityCursor("C_INSERT_TEST");
    expect(cursor).not.toBeNull();
    expect(cursor!.channelId).toBe("C_INSERT_TEST");
    expect(cursor!.lastSeenTs).toBe("1711111111.000001");
    expect(cursor!.updatedAt).toBeTruthy();
  });

  test("upsertChannelActivityCursor updates existing cursor", () => {
    upsertChannelActivityCursor("C_UPDATE_TEST", "1711111111.000001");
    upsertChannelActivityCursor("C_UPDATE_TEST", "1711111111.000099");
    const after = getChannelActivityCursor("C_UPDATE_TEST");
    expect(after!.lastSeenTs).toBe("1711111111.000099");
  });

  test("getAllChannelActivityCursors returns all inserted cursors", () => {
    upsertChannelActivityCursor("C_ALL_1", "1711111111.000001");
    upsertChannelActivityCursor("C_ALL_2", "1711111111.000002");
    const ids = getAllChannelActivityCursors().map((c) => c.channelId);
    expect(ids).toContain("C_ALL_1");
    expect(ids).toContain("C_ALL_2");
  });

  test("channelId is primary key — no duplicates", () => {
    upsertChannelActivityCursor("C_PK_TEST", "1711111111.000001");
    upsertChannelActivityCursor("C_PK_TEST", "1711111111.000002");
    upsertChannelActivityCursor("C_PK_TEST", "1711111111.000003");
    const cursors = getAllChannelActivityCursors().filter((c) => c.channelId === "C_PK_TEST");
    expect(cursors.length).toBe(1);
    expect(cursors[0].lastSeenTs).toBe("1711111111.000003");
  });
});

// ─── Cursor Commit Endpoint ─────────────────────────────────────────────────

describe("Channel Activity — cursor commit endpoint", () => {
  let server: Server;
  const TEST_PORT = 13099;

  beforeAll(async () => {
    server = createHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/channel-activity/commit-cursors") {
        const body = await new Promise<string>((resolve) => {
          let data = "";
          req.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          req.on("end", () => resolve(data));
        });

        try {
          const parsed = JSON.parse(body) as {
            cursorUpdates?: Array<{ channelId: string; ts: string }>;
          };

          if (!parsed.cursorUpdates || !Array.isArray(parsed.cursorUpdates)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing cursorUpdates array" }));
            return;
          }

          for (const { channelId, ts } of parsed.cursorUpdates) {
            if (channelId && ts) {
              upsertChannelActivityCursor(channelId, ts);
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, committed: parsed.cursorUpdates.length }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Invalid request: ${err}` }));
        }
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });
  });

  afterAll(() => {
    server.close();
  });

  test("commits cursor updates successfully", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel-activity/commit-cursors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cursorUpdates: [
          { channelId: "C_COMMIT_1", ts: "1711222222.000001" },
          { channelId: "C_COMMIT_2", ts: "1711222222.000002" },
        ],
      }),
    });

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { success: boolean; committed: number };
    expect(data.success).toBe(true);
    expect(data.committed).toBe(2);

    expect(getChannelActivityCursor("C_COMMIT_1")!.lastSeenTs).toBe("1711222222.000001");
    expect(getChannelActivityCursor("C_COMMIT_2")!.lastSeenTs).toBe("1711222222.000002");
  });

  test("rejects request without cursorUpdates array", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel-activity/commit-cursors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });
    expect(resp.status).toBe(400);
  });

  test("rejects invalid JSON body", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel-activity/commit-cursors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(resp.status).toBe(400);
  });

  test("skips entries with missing channelId or ts", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel-activity/commit-cursors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cursorUpdates: [
          { channelId: "C_VALID", ts: "1711333333.000001" },
          { channelId: "", ts: "1711333333.000002" },
          { channelId: "C_NO_TS", ts: "" },
        ],
      }),
    });

    expect(resp.status).toBe(200);
    expect(getChannelActivityCursor("C_VALID")!.lastSeenTs).toBe("1711333333.000001");
    expect(getChannelActivityCursor("C_NO_TS")).toBeNull();
  });
});

// ─── fetchChannelActivity (mocked Slack) ─────────────────────────────────────

describe("Channel Activity — fetchChannelActivity", () => {
  test("cold-start: channels without cursor get seed cursors, no messages", async () => {
    historyImpl = () =>
      Promise.resolve({
        messages: [{ ts: "1711000000.000100", user: "U123", text: "Latest" }],
      });

    const result = await fetchChannelActivity(new Map());

    // Cold start should NOT return messages (prevents flood)
    expect(result.messages).toHaveLength(0);
    // Should have seed cursors for bot-member channels (C001 and C002; C003 is_member=false)
    expect(result.seedCursors.size).toBe(2);
    expect(result.seedCursors.get("C001")).toBe("1711000000.000100");
    expect(result.seedCursors.get("C002")).toBe("1711000000.000100");
  });

  test("incremental: returns messages newer than cursor, sorted oldest-first", async () => {
    historyImpl = () =>
      Promise.resolve({
        messages: [
          { ts: "1711000000.000050", user: "U123", text: "At cursor" },
          { ts: "1711000000.000060", user: "U456", text: "Newer 2" },
          { ts: "1711000000.000055", user: "U789", text: "Newer 1" },
        ],
      });

    const cursors = new Map([
      ["C001", "1711000000.000050"],
      ["C002", "1711000000.000050"],
    ]);
    const result = await fetchChannelActivity(cursors);

    // Cursor message skipped, 2 newer per channel × 2 channels = 4
    const c001msgs = result.messages.filter((m) => m.channelId === "C001");
    expect(c001msgs).toHaveLength(2);
    // Sorted oldest-first
    expect(Number.parseFloat(result.messages[0].ts)).toBeLessThanOrEqual(
      Number.parseFloat(result.messages[result.messages.length - 1].ts),
    );
  });

  test("filters bot messages, thread replies, empty text, own bot user", async () => {
    historyImpl = () =>
      Promise.resolve({
        messages: [
          { ts: "1711000000.000051", user: "U123", text: "Valid message" },
          { ts: "1711000000.000052", user: "U456", text: "Bot msg", bot_id: "B001" },
          { ts: "1711000000.000053", user: "U789", text: "Bot subtype", subtype: "bot_message" },
          { ts: "1711000000.000054", user: "UBOT123", text: "Own bot msg" },
          { ts: "1711000000.000055", user: "U111", text: "" },
          {
            ts: "1711000000.000056",
            user: "U222",
            text: "Thread reply",
            thread_ts: "1711000000.000001",
          },
          {
            ts: "1711000000.000057",
            user: "U333",
            text: "Thread parent",
            thread_ts: "1711000000.000057",
          },
          { ts: "1711000000.000058", user: undefined, text: "No user" },
        ],
      });

    const cursors = new Map([["C001", "1711000000.000050"]]);
    const result = await fetchChannelActivity(cursors, ["C001"]);

    const texts = result.messages.map((m) => m.text);
    expect(texts).toContain("Valid message");
    expect(texts).toContain("Thread parent");
    expect(texts).not.toContain("Bot msg");
    expect(texts).not.toContain("Bot subtype");
    expect(texts).not.toContain("Own bot msg");
    expect(texts).not.toContain("Thread reply");
    expect(texts).not.toContain("No user");
  });

  test("allowedChannelIds restricts which channels are processed", async () => {
    historyImpl = () =>
      Promise.resolve({
        messages: [{ ts: "1711000000.000100", user: "U123", text: "Hello" }],
      });

    const cursors = new Map([
      ["C001", "1711000000.000050"],
      ["C002", "1711000000.000050"],
    ]);
    const result = await fetchChannelActivity(cursors, ["C001"]);

    const channelIds = new Set(result.messages.map((m) => m.channelId));
    expect(channelIds.has("C001")).toBe(true);
    expect(channelIds.has("C002")).toBe(false);
  });

  test("gracefully handles errors from conversations.history", async () => {
    historyImpl = () => Promise.reject(new Error("channel_not_found"));

    const cursors = new Map([["C001", "1711000000.000050"]]);
    const result = await fetchChannelActivity(cursors, ["C001"]);

    // Should not throw — errors are caught and logged
    expect(result.messages).toHaveLength(0);
  });

  test("includes channelName in returned messages", async () => {
    historyImpl = () =>
      Promise.resolve({
        messages: [{ ts: "1711000000.000051", user: "U123", text: "Hi" }],
      });

    const cursors = new Map([["C001", "1711000000.000050"]]);
    const result = await fetchChannelActivity(cursors, ["C001"]);

    expect(result.messages[0].channelName).toBe("general");
    expect(result.messages[0].channelId).toBe("C001");
  });
});

// ─── Migration ──────────────────────────────────────────────────────────────

describe("Channel Activity — migration 015", () => {
  test("channel_activity_cursors table exists and has correct schema", () => {
    upsertChannelActivityCursor("C_SCHEMA_TEST", "1711999999.000001");
    const cursor = getChannelActivityCursor("C_SCHEMA_TEST");
    expect(cursor).not.toBeNull();
    expect(cursor!.channelId).toBe("C_SCHEMA_TEST");
    expect(cursor!.lastSeenTs).toBe("1711999999.000001");
    expect(cursor!.updatedAt).toBeTruthy();
  });

  test("channelId is PRIMARY KEY — duplicate insert updates instead of failing", () => {
    upsertChannelActivityCursor("C_PK_MIG", "1711000000.000001");
    upsertChannelActivityCursor("C_PK_MIG", "1711000000.000999");
    const cursor = getChannelActivityCursor("C_PK_MIG");
    expect(cursor!.lastSeenTs).toBe("1711000000.000999");
  });
});
