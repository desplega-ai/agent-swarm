import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { unlinkSync } from "node:fs";
import type { WebClient } from "@slack/web-api";
import { closeDb, getDbClient, getKv, initDb, upsertKv } from "../be/db";
import {
  EXTERNAL_ALERT_KV_NAMESPACE,
  getChannelBlockReason,
  getChannelExternality,
  invalidateChannelExternality,
  leaveExternalChannel,
  resetExternalChannelStateForTesting,
  scanExternalChannelsOnBoot,
  shouldBlockChannel,
} from "../slack/external-channel";

const originalFlag = process.env.SLACK_BLOCK_EXTERNAL_CHANNELS;
const originalAlerts = process.env.SLACK_ALERTS_CHANNEL;
const TEST_DB_PATH = "./test-slack-external-channel.sqlite";

function removeDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
}

beforeAll(() => {
  removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  removeDbFiles();
});

function makePlatformError(code: string, extra: Record<string, unknown> = {}): Error {
  const err = new Error(`An API error occurred: ${code}`);
  (err as unknown as { data: Record<string, unknown> }).data = { ok: false, error: code, ...extra };
  return err;
}

function makeClient(opts: {
  channel?: Record<string, unknown>;
  info?: () => Promise<unknown>;
  leave?: () => Promise<unknown>;
  channels?: Array<Record<string, unknown>>;
}) {
  const info = mock(opts.info ?? (() => Promise.resolve({ channel: opts.channel ?? {} })));
  const leave = mock(opts.leave ?? (() => Promise.resolve({ ok: true })));
  const postMessage = mock(() => Promise.resolve({ ok: true }));
  const usersConversations = mock(() =>
    Promise.resolve({ channels: opts.channels ?? [], response_metadata: { next_cursor: "" } }),
  );
  const client = {
    conversations: { info, leave },
    chat: { postMessage },
    users: { conversations: usersConversations },
  } as unknown as WebClient;
  return { client, info, leave, postMessage, usersConversations };
}

function postedText(postMessage: ReturnType<typeof mock>): string {
  return (postMessage.mock.calls[0]?.[0] as { text: string }).text;
}

beforeEach(async () => {
  resetExternalChannelStateForTesting();
  await getDbClient().run("DELETE FROM kv_entries WHERE namespace = ?", [
    EXTERNAL_ALERT_KV_NAMESPACE,
  ]);
  process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
  process.env.SLACK_ALERTS_CHANNEL = "C_ALERTS";
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.SLACK_BLOCK_EXTERNAL_CHANNELS;
  else process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = originalFlag;
  if (originalAlerts === undefined) delete process.env.SLACK_ALERTS_CHANNEL;
  else process.env.SLACK_ALERTS_CHANNEL = originalAlerts;
});

describe("getChannelExternality", () => {
  test("is_ext_shared is external", async () => {
    const { client } = makeClient({ channel: { is_ext_shared: true } });
    expect(await getChannelExternality(client, "C1")).toBe("external");
  });

  test("is_ext_shared with a foreign conversation_host_id is external", async () => {
    const { client } = makeClient({
      channel: { is_ext_shared: true, conversation_host_id: "T0FOREIGN1" },
    });
    expect(await getChannelExternality(client, "C1")).toBe("external");
  });

  test("is_pending_ext_shared is external", async () => {
    const { client } = makeClient({ channel: { is_pending_ext_shared: true } });
    expect(await getChannelExternality(client, "C1")).toBe("external");
  });

  test("is_org_shared with both ext flags false is internal", async () => {
    const { client } = makeClient({
      channel: {
        is_shared: true,
        is_org_shared: true,
        is_ext_shared: false,
        is_pending_ext_shared: false,
      },
    });
    expect(await getChannelExternality(client, "C1")).toBe("internal");
  });

  test("conversations.info error is unknown and not cached", async () => {
    const { client, info } = makeClient({ info: () => Promise.reject(new Error("boom")) });
    expect(await getChannelExternality(client, "C1")).toBe("unknown");
    expect(await getChannelExternality(client, "C1")).toBe("unknown");
    expect(info).toHaveBeenCalledTimes(2);
  });

  test("2 lookups inside the TTL make 1 API call; invalidate forces a fresh call", async () => {
    const { client, info } = makeClient({ channel: { is_ext_shared: false } });
    await getChannelExternality(client, "C1");
    await getChannelExternality(client, "C1");
    expect(info).toHaveBeenCalledTimes(1);
    invalidateChannelExternality("C1");
    await getChannelExternality(client, "C1");
    expect(info).toHaveBeenCalledTimes(2);
  });
});

describe("shouldBlockChannel", () => {
  test("flag off never blocks and makes no API call", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "false";
    const { client, info } = makeClient({ channel: { is_ext_shared: true } });
    expect(await shouldBlockChannel(client, "C1", true)).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  test("envelope flag blocks without an API call", async () => {
    const { client, info } = makeClient({});
    expect(await shouldBlockChannel(client, "C1", true)).toBe(true);
    expect(info).not.toHaveBeenCalled();
  });

  test("unknown blocks as unverified (fail closed)", async () => {
    const { client } = makeClient({ info: () => Promise.reject(new Error("boom")) });
    expect(await shouldBlockChannel(client, "C1")).toBe(true);
    expect(await getChannelBlockReason(client, "C1")).toBe("unverified");
  });

  test("a verified internal channel is not blocked", async () => {
    const { client } = makeClient({ channel: { is_ext_shared: false } });
    expect(await getChannelBlockReason(client, "C1")).toBeNull();
  });

  test("envelope evidence replaces a cached internal value", async () => {
    let channel: Record<string, unknown> = { is_ext_shared: false };
    const { client, info } = makeClient({ info: () => Promise.resolve({ channel }) });
    expect(await getChannelExternality(client, "C1")).toBe("internal");
    channel = { is_ext_shared: true };
    expect(await shouldBlockChannel(client, "C1", true)).toBe(true);
    // Reviewer repro: the next outbound check without an envelope must block too.
    expect(await shouldBlockChannel(client, "C1")).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
  });

  test("an in-flight internal lookup does not overwrite envelope evidence", async () => {
    let resolveInfo: (value: unknown) => void = () => {};
    const { client } = makeClient({
      info: () =>
        new Promise((resolve) => {
          resolveInfo = resolve;
        }),
    });
    const inFlight = getChannelExternality(client, "C1");
    expect(await shouldBlockChannel(client, "C1", true)).toBe(true);
    resolveInfo({ channel: { is_ext_shared: false } });
    expect(await inFlight).toBe("external");
    expect(await shouldBlockChannel(client, "C1")).toBe(true);
  });

  test("an in-flight lookup after invalidation is not cached", async () => {
    let resolveInfo: (value: unknown) => void = () => {};
    const { client, info } = makeClient({
      info: () =>
        new Promise((resolve) => {
          resolveInfo = resolve;
        }),
    });
    const inFlight = getChannelExternality(client, "C1");
    invalidateChannelExternality("C1");
    resolveInfo({ channel: { is_ext_shared: false } });
    expect(await inFlight).toBe("unknown");
    const next = getChannelExternality(client, "C1");
    resolveInfo({ channel: { is_ext_shared: false } });
    expect(await next).toBe("internal");
    expect(info).toHaveBeenCalledTimes(2);
  });
});

describe("leaveExternalChannel", () => {
  test("success: 1 leave and 1 alert with Leave: left", async () => {
    const { client, leave, postMessage } = makeClient({});
    await leaveExternalChannel(client, "C1", "joined");
    expect(leave).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect((postMessage.mock.calls[0]?.[0] as { channel: string }).channel).toBe("C_ALERTS");
    expect(postedText(postMessage)).toContain("Trigger: joined");
    expect(postedText(postMessage)).toContain("Leave: left");
  });

  test("missing_scope: failed line and scope hint", async () => {
    const { client, postMessage } = makeClient({
      leave: () =>
        Promise.reject(makePlatformError("missing_scope", { needed: "channels:manage" })),
    });
    await leaveExternalChannel(client, "C1", "joined");
    expect(postedText(postMessage)).toContain("Leave: failed (missing_scope)");
    expect(postedText(postMessage)).toContain("Slack requires the `channels:manage` scope");
  });

  test.each([
    "cant_leave_general",
    "last_member",
    "method_not_supported_for_channel_type",
  ])("%s maps to failed (<code>)", async (code) => {
    const { client, postMessage } = makeClient({
      leave: () => Promise.reject(makePlatformError(code)),
    });
    await leaveExternalChannel(client, "C1", "shared");
    expect(postedText(postMessage)).toContain(`Leave: failed (${code})`);
  });

  test("not_in_channel response counts as left", async () => {
    const { client, postMessage } = makeClient({
      leave: () => Promise.reject(makePlatformError("not_in_channel", { not_in_channel: true })),
    });
    await leaveExternalChannel(client, "C1", "joined");
    expect(postedText(postMessage)).toContain("Leave: left");
  });

  test("second call within 1 hour posts no second alert", async () => {
    const { client, leave, postMessage } = makeClient({});
    await leaveExternalChannel(client, "C1", "joined");
    await leaveExternalChannel(client, "C1", "joined");
    expect(leave).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  test("alert dedupe survives a restart", async () => {
    const first = makeClient({});
    await leaveExternalChannel(first.client, "C1", "joined");
    expect(first.postMessage).toHaveBeenCalledTimes(1);

    // Restart: all process memory is gone; only kv_entries survives. (The test
    // DB restores from an in-memory template, so it cannot be reopened here.)
    resetExternalChannelStateForTesting();

    const second = makeClient({});
    await leaveExternalChannel(second.client, "C1", "joined");
    expect(second.postMessage).not.toHaveBeenCalled();
    const entry = await getKv(EXTERNAL_ALERT_KV_NAMESPACE, "C1:joined");
    expect(entry?.value).toBe("sent");
    expect(entry?.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
  });

  test("a failed alert post releases the key so the next attempt sends", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client, postMessage } = makeClient({});
      postMessage.mockImplementationOnce(() => Promise.reject(new Error("slack down")));
      await leaveExternalChannel(client, "C1", "joined");
      expect(await getKv(EXTERNAL_ALERT_KV_NAMESPACE, "C1:joined")).toBeNull();
      await leaveExternalChannel(client, "C1", "joined");
      expect(postMessage).toHaveBeenCalledTimes(2);
      await leaveExternalChannel(client, "C1", "joined");
      expect(postMessage).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

  test("a stale sending reservation (crash mid-post) does not suppress the alert", async () => {
    await upsertKv({
      namespace: EXTERNAL_ALERT_KV_NAMESPACE,
      key: "C1:joined",
      value: "sending",
      valueType: "string",
      expiresAt: Date.now() - 1,
    });
    const { client, postMessage } = makeClient({});
    await leaveExternalChannel(client, "C1", "joined");
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  test("an in-flight sending reservation suppresses a concurrent duplicate", async () => {
    const { client, postMessage } = makeClient({});
    await Promise.all([
      leaveExternalChannel(client, "C1", "joined"),
      leaveExternalChannel(client, "C1", "joined"),
    ]);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  test("unset SLACK_ALERTS_CHANNEL: 0 posts and 1 warning", async () => {
    delete process.env.SLACK_ALERTS_CHANNEL;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { client, postMessage } = makeClient({});
      await leaveExternalChannel(client, "C1", "joined");
      expect(postMessage).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("scanExternalChannelsOnBoot", () => {
  test("boot scan sweeps expired alert keys", async () => {
    await upsertKv({
      namespace: EXTERNAL_ALERT_KV_NAMESPACE,
      key: "C_OLD:boot-scan",
      value: "sent",
      valueType: "string",
      expiresAt: Date.now() - 1,
    });
    const { client } = makeClient({});
    await scanExternalChannelsOnBoot(client);
    const rows = await getDbClient().query<{ key: string }>(
      "SELECT key FROM kv_entries WHERE namespace = ?",
      [EXTERNAL_ALERT_KV_NAMESPACE],
    );
    expect(rows).toEqual([]);
  });

  test("1 external + 1 internal: 1 report-only alert, 0 leaves", async () => {
    const { client, leave, postMessage } = makeClient({
      channels: [
        { id: "C_EXT", is_ext_shared: true },
        { id: "C_INT", is_ext_shared: false, is_pending_ext_shared: false },
      ],
    });
    await scanExternalChannelsOnBoot(client);
    expect(leave).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postedText(postMessage)).toContain("C_EXT");
    expect(postedText(postMessage)).toContain("Leave: not attempted (report only)");
  });

  test("flag off: no Slack calls", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "false";
    const { client, usersConversations } = makeClient({});
    await scanExternalChannelsOnBoot(client);
    expect(usersConversations).not.toHaveBeenCalled();
  });
});
