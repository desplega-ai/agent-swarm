import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { closeDb, createAgent, createTaskExtended, getDbClient, initDb, upsertKv } from "../be/db";
import * as labelsDb from "../be/db/session-labels";
import { getSessionLabels, rememberSessionLabel } from "../be/db/session-labels";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { flushChatThread } from "../integrations/chat-sdk/inbound";
import type { ChatBufferedMessage } from "../integrations/chat-sdk/thread-buffer";
import * as slackApp from "../slack/app";
import { warmSlackChannelLabels } from "../slack/channel-labels";
import { chatSdkContextKey } from "../tasks/context-key";
import { beginRequestAuthScope, setRequestAuth } from "../utils/request-auth-context";
import {
  flushChatBuffers,
  postTelegramUpdate,
  startTelegramHarness,
  telegramUpdate,
} from "./chat-sdk-harness";
import { listenOnFreePort } from "./test-net";

let server: Server;
let baseUrl: string;
const getApp = spyOn(slackApp, "getSlackApp");

beforeAll(async () => {
  initDb(":memory:");
  await createAgent({ id: crypto.randomUUID(), name: "LabelsLead", isLead: true, status: "idle" });
  server = createServer(async (req, res) => {
    try {
      beginRequestAuthScope();
      setRequestAuth(req, { kind: "operator", fingerprint: "session-labels-test" });
      if (
        await handleSessions(
          req,
          res,
          getPathSegments(req.url ?? ""),
          parseQueryParams(req.url ?? ""),
        )
      )
        return;
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

beforeEach(async () => {
  getApp.mockReturnValue(null);
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run("DELETE FROM kv_entries WHERE namespace = 'session-labels'");
});
afterEach(() => {
  getApp.mockReturnValue(null);
});
afterAll(async () => {
  getApp.mockRestore();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Background label lookup did not finish");
}

function fakeSlack(
  apiCall: (method: string, payload: Record<string, unknown>) => Promise<unknown>,
) {
  const call = mock(apiCall);
  getApp.mockReturnValue({ client: { apiCall: call } } as unknown as NonNullable<
    ReturnType<typeof slackApp.getSlackApp>
  >);
  return call;
}

const keyOf = (id: string) => `shared/slack/${id}/`;
async function hasLabel(id: string, label: string) {
  return (await getSessionLabels([keyOf(id)]))[keyOf(id)] === label;
}

test("cache reads one batch, keeps plain strings and skips expired or foreign rows", async () => {
  const now = Date.now();
  await rememberSessionLabel("shared/telegram/-1/", "Life");
  await rememberSessionLabel(keyOf("c1"), "#eng", 86_400_000);
  await rememberSessionLabel(keyOf("expired"), "old", -1);
  await upsertKv({
    namespace: "other",
    key: keyOf("foreign"),
    value: "other",
    valueType: "string",
  });
  const client = getDbClient();
  const query = spyOn(client, "query");
  try {
    expect(await getSessionLabels([])).toEqual({});
    expect(query).not.toHaveBeenCalled();
    expect(
      await getSessionLabels([
        "shared/telegram/-1/",
        keyOf("c1"),
        keyOf("expired"),
        keyOf("foreign"),
      ]),
    ).toEqual({
      "shared/telegram/-1/": "Life",
      [keyOf("c1")]: "#eng",
    });
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    query.mockRestore();
  }
  const row = await client.get<{ value: string; value_type: string; expires_at: number }>(
    "SELECT value, value_type, expires_at FROM kv_entries WHERE namespace = 'session-labels' AND key = ?",
    [keyOf("c1")],
  );
  expect(row).toMatchObject({ value: "#eng", value_type: "string" });
  expect(row!.expires_at).toBeGreaterThanOrEqual(now + 86_400_000);
});

test("Slack resolves a channel with uppercase id, a DM and a group DM with a 24 hour TTL", async () => {
  const now = Date.now();
  const call = fakeSlack(async (method, payload) => {
    if (method === "users.info")
      return { ok: true, user: { profile: { display_name: "Lena" }, real_name: "Elena" } };
    if (payload.channel === "DLABEL") return { ok: true, channel: { is_im: true, user: "ULENA" } };
    if (payload.channel === "GLABEL")
      return { ok: true, channel: { is_mpim: true, name: "private" } };
    return { ok: true, channel: { name: "eng" } };
  });
  warmSlackChannelLabels([keyOf("clabel"), keyOf("dlabel"), keyOf("glabel")]);
  warmSlackChannelLabels([keyOf("clabel"), "shared/slack/", "shared/slack/clabel/thread:1.2/"]);
  await until(() => hasLabel("glabel", "Group DM"));
  expect(await hasLabel("clabel", "#eng")).toBe(true);
  expect(await hasLabel("dlabel", "DM · Lena")).toBe(true);
  expect(call).toHaveBeenCalledTimes(4);
  expect(call).toHaveBeenCalledWith("conversations.info", { channel: "CLABEL" });
  expect(call).toHaveBeenCalledWith("users.info", { user: "ULENA" });
  const row = await getDbClient().get<{ expires_at: number }>(
    "SELECT expires_at FROM kv_entries WHERE namespace = 'session-labels' AND key = ?",
    [keyOf("clabel")],
  );
  expect(row!.expires_at).toBeGreaterThanOrEqual(now + 86_400_000);
});

test("Slack uses the real name when the display name is empty", async () => {
  fakeSlack(async (method) =>
    method === "users.info"
      ? { ok: true, user: { profile: { display_name: "" }, real_name: "Lena" } }
      : { ok: true, channel: { is_im: true, user: "ULENA" } },
  );
  warmSlackChannelLabels([keyOf("dreal")]);
  await until(() => hasLabel("dreal", "DM · Lena"));
});

test("Slack serializes work across calls and retries ratelimited errors", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  const call = fakeSlack(async (_method, payload) => {
    if (payload.channel === "CSERIAL") await gate;
    else if (attempts++ === 0) throw { data: { error: "ratelimited", retry_after: 0 } };
    return { ok: true, channel: { name: "eng" } };
  });
  try {
    warmSlackChannelLabels([keyOf("cserial")]);
    warmSlackChannelLabels([keyOf("cretry")]);
    await until(() => call.mock.calls.length === 1);
    expect(call.mock.calls[0]![1]).toEqual({ channel: "CSERIAL" });
  } finally {
    release();
  }
  await until(() => hasLabel("cretry", "#eng"));
  expect(call).toHaveBeenCalledTimes(3);
});

test("Slack caches a failure in memory for ten minutes without writing KV or logging names", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const call = fakeSlack(async () => {
    throw new Error("secret label text");
  });
  try {
    warmSlackChannelLabels([keyOf("cfail")]);
    await until(() => warn.mock.calls.length === 1);
    warmSlackChannelLabels([keyOf("cfail")]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(await getSessionLabels([keyOf("cfail")])).toEqual({});
    expect(warn.mock.calls.flat().join(" ")).not.toContain("secret label text");
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
    try {
      call.mockImplementation(async () => ({ ok: true, channel: { name: "recovered" } }));
      warmSlackChannelLabels([keyOf("cfail")]);
      await until(() => hasLabel("cfail", "#recovered"));
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  } finally {
    warn.mockRestore();
  }
});

test("a null Slack client performs no work and does not reserve the id", async () => {
  warmSlackChannelLabels([keyOf("cnull")]);
  expect(await getSessionLabels([keyOf("cnull")])).toEqual({});
  const call = fakeSlack(async () => ({ ok: true, channel: { name: "eng" } }));
  warmSlackChannelLabels([keyOf("cnull")]);
  await until(() => hasLabel("cnull", "#eng"));
  expect(call).toHaveBeenCalledTimes(1);
});

test("Slack caps pending and active lookups across calls and accepts skipped ids on a later poll", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = fakeSlack(async () => {
    await gate;
    return { ok: true, channel: { name: "bounded" } };
  });
  const keys = Array.from({ length: 60 }, (_, i) => keyOf(`cqueue${i}`));
  try {
    warmSlackChannelLabels(keys.slice(0, 30));
    await until(() => call.mock.calls.length === 1);
    warmSlackChannelLabels(keys.slice(30));
    expect(call).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await until(() => hasLabel("cqueue49", "#bounded"));
  expect(call).toHaveBeenCalledTimes(50);
  expect(await getSessionLabels(keys.slice(50))).toEqual({});
  warmSlackChannelLabels(keys.slice(50));
  await until(() => hasLabel("cqueue59", "#bounded"));
  expect(call).toHaveBeenCalledTimes(60);
});

test("an explicit Slack key without matching Slack fields starts no lookup", async () => {
  await createTaskExtended("explicit source key", { key: `${keyOf("cfake")}task:fake/` });
  await createTaskExtended("mismatched source key", {
    key: `${keyOf("cfake")}task:mismatch/`,
    slackChannelId: "COTHER",
    slackThreadTs: "123.456",
  });
  const call = fakeSlack(async () => ({ ok: true, channel: { name: "untrusted" } }));
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${baseUrl}/api/session-tree`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.groups.map((group: { key: string }) => group.key)).toEqual([keyOf("cfake")]);
    expect(body.labels).toEqual({});
    expect(body.slackChannels).toBeUndefined();
  }
  expect(call).not.toHaveBeenCalled();
});

test("tree returns cached source labels and starts one background lookup for a Slack miss", async () => {
  for (const channel of ["CTREECACHED", "CTREEMISS"]) {
    await createTaskExtended("label tree", {
      source: "slack",
      slackChannelId: channel,
      slackThreadTs: "123.456",
    });
  }
  await createTaskExtended("ordinary group", { key: "shared/research/" });
  await rememberSessionLabel(keyOf("ctreecached"), "#cached");
  await rememberSessionLabel("shared/research/", "omit ordinary labels");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = fakeSlack(async () => {
    await gate;
    return { ok: true, channel: { name: "found" } };
  });
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${baseUrl}/api/session-tree`);
      expect(response.status).toBe(200);
      expect((await response.json()).labels).toEqual({ [keyOf("ctreecached")]: "#cached" });
    }
    expect(call).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await until(() => hasLabel("ctreemiss", "#found"));
  expect((await (await fetch(`${baseUrl}/api/session-tree`)).json()).labels).toEqual({
    [keyOf("ctreecached")]: "#cached",
    [keyOf("ctreemiss")]: "#found",
  });
});

test("tree returns labels for source groups the filter hides", async () => {
  await createTaskExtended("hidden label tree", {
    source: "slack",
    slackChannelId: "CTREEHIDDEN",
    slackThreadTs: "123.456",
  });
  await rememberSessionLabel(keyOf("ctreehidden"), "#hidden");
  const body = await (await fetch(`${baseUrl}/api/session-tree?showSource=ui`)).json();
  expect(body.groups.some((group: { key: string }) => group.key === keyOf("ctreehidden"))).toBe(
    false,
  );
  expect(body.labels[keyOf("ctreehidden")]).toBe("#hidden");
  expect(body.sourceGroups).toBeUndefined();
  expect(body.slackChannels).toBeUndefined();
});

test("Telegram capture stores a group title and a DM sender under their source group keys without TTL", async () => {
  const harness = await startTelegramHarness();
  try {
    await postTelegramUpdate(
      telegramUpdate({ id: -9911, type: "group" }, "@swarm_test_bot first ask"),
    );
    await flushChatBuffers();
    await postTelegramUpdate(telegramUpdate({ id: 9912, type: "private" }, "first ask"));
    await flushChatBuffers();
    expect(await getSessionLabels(["shared/telegram/-9911/", "shared/telegram/9912/"])).toEqual({
      "shared/telegram/-9911/": "Swarm group",
      "shared/telegram/9912/": "DM · Tester (@tester)",
    });
    const rows = await getDbClient().query<{ expires_at: number | null }>(
      "SELECT expires_at FROM kv_entries WHERE namespace = 'session-labels'",
    );
    expect(rows.every((row) => row.expires_at === null)).toBe(true);
    await postTelegramUpdate(
      telegramUpdate({ id: -9911, type: "group" }, "@swarm_test_bot follow-up", {
        chat: { id: -9911, type: "group", title: "Changed title" },
      }),
    );
    await flushChatBuffers();
    expect((await getSessionLabels(["shared/telegram/-9911/"]))["shared/telegram/-9911/"]).toBe(
      "Changed title",
    );
  } finally {
    await harness.stop();
  }
});

function discordMessage(dm: boolean): ChatBufferedMessage {
  return {
    messageId: crypto.randomUUID(),
    channelId: "discord:guild:channel",
    text: "hello",
    userId: "sender",
    botMentioned: true,
    isDirectMessage: dm,
    addressed: dm ? "dm" : "mention",
    facts: { chatType: dm ? "dm" : undefined, from: "Lena", replyToBot: false },
    attachments: [],
  };
}

test("Discord capture stores a DM label and leaves channel names absent", async () => {
  await flushChatThread("discord:@me:dmchannel", [discordMessage(true)], true);
  await flushChatThread("discord:guild:channel", [discordMessage(false)], true);
  expect(await getSessionLabels(["shared/discord/dmchannel/", "shared/discord/channel/"])).toEqual({
    "shared/discord/dmchannel/": "DM · Lena",
  });
});

test("a label write failure does not fail chat task creation or log the label", async () => {
  const save = spyOn(labelsDb, "rememberSessionLabel").mockRejectedValue(new Error("DM · private"));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await flushChatThread("discord:@me:failedlabel", [discordMessage(true)], true);
    const row = await getDbClient().get<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE contextKey = ?",
      [chatSdkContextKey("discord:@me:failedlabel")],
    );
    expect(row?.id).toBeTruthy();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("DM · private");
    expect(save).toHaveBeenCalledTimes(1);
  } finally {
    save.mockRestore();
    warn.mockRestore();
  }
});

test("a full Slack failure cache skips new ids without evicting live failures and reclaims expired entries", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const call = fakeSlack(async () => {
    throw new Error("lookup failed");
  });
  const keys = Array.from({ length: 500 }, (_, i) => keyOf(`cfull${i}`));
  try {
    for (let offset = 0; offset < keys.length; offset += 50) {
      warmSlackChannelLabels(keys.slice(offset, offset + 50));
      await until(() => warn.mock.calls.length === offset + 50);
    }
    expect(call).toHaveBeenCalledTimes(500);
    warmSlackChannelLabels([keyOf("cfullnew")]);
    await Bun.sleep(0);
    warmSlackChannelLabels(keys);
    await Bun.sleep(0);
    expect(call).toHaveBeenCalledTimes(500);
    expect(await getSessionLabels(keys)).toEqual({});

    clock.mockReturnValue(now + 10 * 60_000 + 1);
    call.mockImplementation(async () => ({ ok: true, channel: { name: "recovered" } }));
    warmSlackChannelLabels([keyOf("cfullnew")]);
    await until(() => hasLabel("cfullnew", "#recovered"));
    expect(call).toHaveBeenCalledTimes(501);
  } finally {
    clock.mockRestore();
    warn.mockRestore();
  }
});
