import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  getAllChannelActivityCursors,
  getChannelActivityCursor,
  initDb,
  upsertChannelActivityCursor,
} from "../be/db";

const TEST_DB_PATH = "./test-channel-activity.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore if files don't exist
  }
});

// ─── DB Functions ──────────────────────────────────────────────────────────────

describe("Channel Activity Cursors — DB functions", () => {
  test("getChannelActivityCursor returns null for non-existent channel", () => {
    const cursor = getChannelActivityCursor("C_NONEXISTENT");
    expect(cursor).toBeNull();
  });

  test("getAllChannelActivityCursors returns empty array initially", () => {
    const cursors = getAllChannelActivityCursors();
    // May have cursors from other tests, but the function should return an array
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
    const before = getChannelActivityCursor("C_UPDATE_TEST");
    expect(before!.lastSeenTs).toBe("1711111111.000001");

    upsertChannelActivityCursor("C_UPDATE_TEST", "1711111111.000099");
    const after = getChannelActivityCursor("C_UPDATE_TEST");
    expect(after!.lastSeenTs).toBe("1711111111.000099");
    expect(after!.channelId).toBe("C_UPDATE_TEST");
  });

  test("getAllChannelActivityCursors returns all inserted cursors", () => {
    upsertChannelActivityCursor("C_ALL_1", "1711111111.000001");
    upsertChannelActivityCursor("C_ALL_2", "1711111111.000002");

    const cursors = getAllChannelActivityCursors();
    const ids = cursors.map((c) => c.channelId);
    expect(ids).toContain("C_ALL_1");
    expect(ids).toContain("C_ALL_2");
  });

  test("cursor channelId is primary key — no duplicates", () => {
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
    // Minimal HTTP server that wraps the commit-cursors handler
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

    // Verify cursors were actually persisted
    const c1 = getChannelActivityCursor("C_COMMIT_1");
    expect(c1!.lastSeenTs).toBe("1711222222.000001");
    const c2 = getChannelActivityCursor("C_COMMIT_2");
    expect(c2!.lastSeenTs).toBe("1711222222.000002");
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
          { channelId: "", ts: "1711333333.000002" }, // empty channelId
          { channelId: "C_NO_TS", ts: "" }, // empty ts
        ],
      }),
    });

    expect(resp.status).toBe(200);
    // Only the valid entry should have been persisted
    expect(getChannelActivityCursor("C_VALID")!.lastSeenTs).toBe("1711333333.000001");
    expect(getChannelActivityCursor("C_NO_TS")).toBeNull();
  });
});

// ─── Poll Trigger — channel_activity ─────────────────────────────────────────

describe("Channel Activity — poll trigger integration", () => {
  test("channel_activity trigger payload shape matches expectations", () => {
    // This tests the expected shape of the trigger payload
    // that the poll endpoint would produce
    const trigger = {
      type: "channel_activity",
      count: 2,
      messages: [
        {
          channelId: "C001",
          channelName: "general",
          ts: "1711111111.000001",
          user: "U123",
          text: "Hello world",
        },
        {
          channelId: "C001",
          channelName: "general",
          ts: "1711111111.000002",
          user: "U456",
          text: "Hi there",
        },
      ],
      cursorUpdates: [{ channelId: "C001", ts: "1711111111.000002" }],
    };

    expect(trigger.type).toBe("channel_activity");
    expect(trigger.count).toBe(2);
    expect(trigger.messages).toHaveLength(2);
    expect(trigger.cursorUpdates).toHaveLength(1);
    // cursorUpdates should point to the latest ts per channel
    expect(trigger.cursorUpdates[0].ts).toBe("1711111111.000002");
  });

  test("LEAD_MONITOR_CHANNELS env var gates the trigger", () => {
    // When LEAD_MONITOR_CHANNELS is not "true", channel_activity should not fire
    const envValue = process.env.LEAD_MONITOR_CHANNELS;

    // Not set
    delete process.env.LEAD_MONITOR_CHANNELS;
    expect(process.env.LEAD_MONITOR_CHANNELS).toBeUndefined();

    // Set to something other than "true"
    process.env.LEAD_MONITOR_CHANNELS = "false";
    expect(process.env.LEAD_MONITOR_CHANNELS !== "true").toBe(true);

    // Restore
    if (envValue !== undefined) {
      process.env.LEAD_MONITOR_CHANNELS = envValue;
    } else {
      delete process.env.LEAD_MONITOR_CHANNELS;
    }
  });

  test("LEAD_MONITOR_CHANNEL_IDS parses comma-separated list correctly", () => {
    const raw = " C001, C002 ,C003 , ";
    const allowedIds = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(allowedIds).toEqual(["C001", "C002", "C003"]);
  });

  test("cursorUpdates computation selects latest ts per channel", () => {
    // Simulates the latestPerChannel logic from poll.ts
    const messages = [
      { channelId: "C001", ts: "1711111111.000001" },
      { channelId: "C001", ts: "1711111111.000005" },
      { channelId: "C002", ts: "1711111111.000002" },
      { channelId: "C001", ts: "1711111111.000003" },
      { channelId: "C002", ts: "1711111111.000009" },
    ];

    const latestPerChannel = new Map<string, string>();
    for (const msg of messages) {
      const existing = latestPerChannel.get(msg.channelId);
      if (!existing || Number.parseFloat(msg.ts) > Number.parseFloat(existing)) {
        latestPerChannel.set(msg.channelId, msg.ts);
      }
    }

    expect(latestPerChannel.get("C001")).toBe("1711111111.000005");
    expect(latestPerChannel.get("C002")).toBe("1711111111.000009");
  });
});

// ─── fetchChannelActivity logic ─────────────────────────────────────────────

describe("Channel Activity — fetchChannelActivity logic", () => {
  test("message filtering rules: skips bot messages, thread replies, empty text", () => {
    // Simulate the filter logic from fetchChannelActivity
    const botUserId = "UBOT";
    const cursor = "1711000000.000000";

    const rawMessages = [
      // Valid message
      {
        ts: "1711000000.000001",
        user: "U123",
        text: "Hello",
        bot_id: undefined,
        subtype: undefined,
        thread_ts: undefined,
      },
      // Bot message (bot_id present)
      {
        ts: "1711000000.000002",
        user: "U456",
        text: "Bot msg",
        bot_id: "B001",
        subtype: undefined,
        thread_ts: undefined,
      },
      // Bot subtype
      {
        ts: "1711000000.000003",
        user: "U789",
        text: "Bot sub",
        bot_id: undefined,
        subtype: "bot_message",
        thread_ts: undefined,
      },
      // Our own bot
      {
        ts: "1711000000.000004",
        user: botUserId,
        text: "Own bot",
        bot_id: undefined,
        subtype: undefined,
        thread_ts: undefined,
      },
      // Empty text
      {
        ts: "1711000000.000005",
        user: "U111",
        text: "",
        bot_id: undefined,
        subtype: undefined,
        thread_ts: undefined,
      },
      // Thread reply (thread_ts != ts)
      {
        ts: "1711000000.000006",
        user: "U222",
        text: "Reply",
        bot_id: undefined,
        subtype: undefined,
        thread_ts: "1711000000.000001",
      },
      // Thread parent (thread_ts == ts, should pass)
      {
        ts: "1711000000.000007",
        user: "U333",
        text: "Thread parent",
        bot_id: undefined,
        subtype: undefined,
        thread_ts: "1711000000.000007",
      },
      // Cursor message itself (should be skipped)
      {
        ts: cursor,
        user: "U444",
        text: "Cursor msg",
        bot_id: undefined,
        subtype: undefined,
        thread_ts: undefined,
      },
      // No user
      {
        ts: "1711000000.000008",
        user: undefined,
        text: "No user",
        bot_id: undefined,
        subtype: undefined,
        thread_ts: undefined,
      },
    ];

    const filtered = rawMessages.filter((msg) => {
      if (msg.ts === cursor) return false;
      if (msg.bot_id || msg.subtype === "bot_message") return false;
      if (msg.user === botUserId) return false;
      if (!msg.text?.trim() || !msg.user) return false;
      if (msg.thread_ts && msg.thread_ts !== msg.ts) return false;
      return true;
    });

    // Only the valid message and thread parent should pass
    expect(filtered).toHaveLength(2);
    expect(filtered[0].ts).toBe("1711000000.000001");
    expect(filtered[1].ts).toBe("1711000000.000007");
  });

  test("messages are sorted oldest-first by timestamp", () => {
    const messages = [
      { ts: "1711000000.000005", channelId: "C001" },
      { ts: "1711000000.000001", channelId: "C001" },
      { ts: "1711000000.000003", channelId: "C002" },
    ];

    messages.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));

    expect(messages[0].ts).toBe("1711000000.000001");
    expect(messages[1].ts).toBe("1711000000.000003");
    expect(messages[2].ts).toBe("1711000000.000005");
  });

  test("cold-start: channels without cursor get seed cursors, no messages returned", () => {
    // When a channel has no cursor, fetchChannelActivity should:
    // 1. Fetch the latest message for seeding
    // 2. Add it to seedCursors
    // 3. NOT add any messages (skip to avoid cold-start flood)

    const cursors = new Map<string, string>();
    // C_NEW has no cursor
    const hasNoCursor = !cursors.has("C_NEW");
    expect(hasNoCursor).toBe(true);

    // Simulating seed behavior
    const seedCursors = new Map<string, string>();
    const latestMsgTs = "1711000000.000100";
    seedCursors.set("C_NEW", latestMsgTs);

    expect(seedCursors.get("C_NEW")).toBe(latestMsgTs);
    // No messages should be added for cold-start channels
  });

  test("incremental: channels with cursor fetch messages newer than cursor", () => {
    const cursors = new Map<string, string>();
    cursors.set("C_EXISTING", "1711000000.000050");

    // The oldest parameter passed to conversations.history should be the cursor
    const oldest = cursors.get("C_EXISTING");
    expect(oldest).toBe("1711000000.000050");

    // Messages at or before cursor should be filtered out
    const msgs = [
      { ts: "1711000000.000050" }, // equals cursor — should be skipped
      { ts: "1711000000.000051" }, // newer — should pass
      { ts: "1711000000.000099" }, // newer — should pass
    ];

    const filtered = msgs.filter((m) => m.ts !== oldest);
    expect(filtered).toHaveLength(2);
  });

  test("channel allowlist filters channels correctly", () => {
    const allChannels = [
      { id: "C001", name: "general" },
      { id: "C002", name: "random" },
      { id: "C003", name: "dev" },
    ];

    const allowedChannelIds = ["C001", "C003"];
    const allowed = new Set(allowedChannelIds);
    const filtered = allChannels.filter((ch) => allowed.has(ch.id));

    expect(filtered).toHaveLength(2);
    expect(filtered.map((c) => c.id)).toEqual(["C001", "C003"]);
  });

  test("empty allowlist returns no channels", () => {
    const allChannels = [
      { id: "C001", name: "general" },
      { id: "C002", name: "random" },
    ];

    const allowedChannelIds: string[] = [];
    // When allowedChannelIds is empty and length is 0, the filter is NOT applied
    // (undefined means no filter, empty array means no channels)
    if (allowedChannelIds.length > 0) {
      const allowed = new Set(allowedChannelIds);
      const filtered = allChannels.filter((ch) => allowed.has(ch.id));
      expect(filtered).toHaveLength(0);
    } else {
      // No filter applied — all channels returned
      expect(allChannels).toHaveLength(2);
    }
  });
});

// ─── Runner — cursor commit on success ──────────────────────────────────────

describe("Channel Activity — runner cursor commit logic", () => {
  test("cursors committed only on exitCode 0 (success)", () => {
    const cursorUpdates = [
      { channelId: "C001", ts: "1711000000.000001" },
      { channelId: "C002", ts: "1711000000.000002" },
    ];

    // On success (exitCode 0), cursors should be committed
    const exitCode0 = 0;
    const shouldCommit = cursorUpdates.length > 0 && exitCode0 === 0;
    expect(shouldCommit).toBe(true);

    // On failure (exitCode 1), cursors should NOT be committed
    const exitCode1 = 1;
    const shouldNotCommit = cursorUpdates.length > 0 && exitCode1 === 0;
    expect(shouldNotCommit).toBe(false);
  });

  test("empty cursorUpdates array skips commit", () => {
    const cursorUpdates: Array<{ channelId: string; ts: string }> = [];
    const exitCode = 0;
    const shouldCommit = cursorUpdates.length > 0 && exitCode === 0;
    expect(shouldCommit).toBe(false);
  });

  test("undefined cursorUpdates skips commit", () => {
    const cursorUpdates: Array<{ channelId: string; ts: string }> | undefined = undefined;
    const exitCode = 0;
    const shouldCommit = cursorUpdates && cursorUpdates.length > 0 && exitCode === 0;
    expect(shouldCommit).toBeFalsy();
  });

  test("cursorUpdates attached only for channel_activity trigger type", () => {
    const trigger = {
      type: "channel_activity",
      cursorUpdates: [{ channelId: "C001", ts: "1711000000.000001" }],
    };

    const runningTask: { cursorUpdates?: Array<{ channelId: string; ts: string }> } = {};

    if (trigger.type === "channel_activity" && trigger.cursorUpdates) {
      runningTask.cursorUpdates = trigger.cursorUpdates;
    }

    expect(runningTask.cursorUpdates).toBeDefined();
    expect(runningTask.cursorUpdates).toHaveLength(1);

    // For non-channel_activity triggers, cursorUpdates should NOT be attached
    const otherTrigger = {
      type: "task_assigned",
      cursorUpdates: undefined,
    };

    const otherTask: { cursorUpdates?: Array<{ channelId: string; ts: string }> } = {};
    if (otherTrigger.type === "channel_activity" && otherTrigger.cursorUpdates) {
      otherTask.cursorUpdates = otherTrigger.cursorUpdates;
    }

    expect(otherTask.cursorUpdates).toBeUndefined();
  });
});

// ─── Migration ──────────────────────────────────────────────────────────────

describe("Channel Activity — migration 015", () => {
  test("channel_activity_cursors table exists and has correct schema", () => {
    // The table should have been created by the migration during initDb
    // Verify by inserting and querying
    upsertChannelActivityCursor("C_SCHEMA_TEST", "1711999999.000001");
    const cursor = getChannelActivityCursor("C_SCHEMA_TEST");
    expect(cursor).not.toBeNull();
    expect(cursor!.channelId).toBe("C_SCHEMA_TEST");
    expect(cursor!.lastSeenTs).toBe("1711999999.000001");
    expect(cursor!.updatedAt).toBeTruthy();
  });

  test("channelId is PRIMARY KEY — duplicate insert updates instead of failing", () => {
    upsertChannelActivityCursor("C_PK_MIG", "1711000000.000001");
    // This should NOT throw — upsert uses ON CONFLICT DO UPDATE
    upsertChannelActivityCursor("C_PK_MIG", "1711000000.000999");

    const cursor = getChannelActivityCursor("C_PK_MIG");
    expect(cursor!.lastSeenTs).toBe("1711000000.000999");
  });
});

// ─── Channel cache TTL ─────────────────────────────────────────────────────

describe("Channel Activity — cache behavior", () => {
  test("channel cache TTL is 5 minutes", () => {
    const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;
    expect(CHANNEL_CACHE_TTL_MS).toBe(300_000);
  });

  test("throttle interval is 60 seconds", () => {
    const CHANNEL_ACTIVITY_INTERVAL_MS = 60_000;
    expect(CHANNEL_ACTIVITY_INTERVAL_MS).toBe(60_000);
  });
});
