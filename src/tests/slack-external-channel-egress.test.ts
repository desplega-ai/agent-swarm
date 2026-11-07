import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { webApi } from "@slack/bolt";
import {
  invalidateChannelExternality,
  recordExternalChannel,
  resetExternalChannelStateForTesting,
} from "../slack/external-channel";
import {
  EXTERNAL_CHANNEL_BLOCKED_CODE,
  EXTERNAL_CHANNEL_UNVERIFIED_CODE,
  installSlackExternalChannelGuard,
} from "../slack/external-channel-egress";
import { callSlackWithRetry, isTerminalSlackError } from "../slack/render-v2";
import { sendWithPersona } from "../slack/responses";

// The guard sits on WebClient.prototype, so these tests drive real clients
// against a local mock Slack API and assert which calls reach the wire.

const originalFlag = process.env.SLACK_BLOCK_EXTERNAL_CHANNELS;
const CHANNEL = "C_EGRESS";

type InfoMode = "internal" | "external" | "error";
let infoMode: InfoMode = "internal";
const wire: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

beforeAll(() => {
  installSlackExternalChannelGuard();
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname.startsWith("/upload/")) {
        wire.push("upload");
        return new Response("OK");
      }
      const method = pathname.replace(/^\/api\//, "");
      wire.push(method);
      if (method === "conversations.info") {
        if (infoMode === "error") return Response.json({ ok: false, error: "missing_scope" });
        return Response.json({
          ok: true,
          channel: { id: CHANNEL, is_ext_shared: infoMode === "external" },
        });
      }
      if (method === "files.getUploadURLExternal") {
        return Response.json({ ok: true, upload_url: `${baseUrl}upload/F1`, file_id: "F1" });
      }
      if (method === "files.completeUploadExternal") {
        return Response.json({ ok: true, files: [{ id: "F1" }] });
      }
      return Response.json({ ok: true, ts: "1.000001", channel: CHANNEL });
    },
  });
  baseUrl = `http://localhost:${server.port}/`;
});

afterAll(() => {
  server.stop(true);
  if (originalFlag === undefined) delete process.env.SLACK_BLOCK_EXTERNAL_CHANNELS;
  else process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = originalFlag;
});

beforeEach(() => {
  resetExternalChannelStateForTesting();
  process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
  infoMode = "internal";
});

afterEach(() => {
  wire.length = 0;
});

function client(): InstanceType<typeof webApi.WebClient> {
  return new webApi.WebClient("xoxb-test", {
    slackApiUrl: `${baseUrl}api/`,
    retryConfig: { retries: 0 },
  });
}

/** Every swarm output path a running task uses, each through a real client. */
const writes: Array<[string, (c: InstanceType<typeof webApi.WebClient>) => Promise<unknown>]> = [
  [
    "persona reply (sendWithPersona)",
    (c) =>
      sendWithPersona(c, {
        channel: CHANNEL,
        thread_ts: "1.0",
        text: "progress",
        username: "Agent",
        icon: { icon_emoji: ":robot_face:" },
      }),
  ],
  [
    "progress edit (chat.update)",
    (c) =>
      c.chat.update({
        channel: CHANNEL,
        ts: "1.000001",
        text: "edit",
        unfurl_links: false,
        unfurl_media: false,
      }),
  ],
  [
    "outcome stream (chat.startStream)",
    (c) => callSlackWithRetry(c, "chat.startStream", { channel: CHANNEL, thread_ts: "1.0" }),
  ],
  [
    "outcome card (chat.postMessage)",
    (c) =>
      callSlackWithRetry(c, "chat.postMessage", {
        channel: CHANNEL,
        text: "outcome",
        unfurl_links: false,
        unfurl_media: false,
      }),
  ],
  [
    "native status (assistant.threads.setStatus)",
    (c) => c.assistant.threads.setStatus({ channel_id: CHANNEL, thread_ts: "1.0", status: "x" }),
  ],
  [
    "file upload (filesUploadV2)",
    (c) => c.filesUploadV2({ channel_id: CHANNEL, content: "report", filename: "r.txt" }),
  ],
];

function sent(): string[] {
  return wire.filter((method) => method !== "conversations.info");
}

describe("WebClient external-channel guard", () => {
  test.each(writes)("%s: flag on + external channel never reaches Slack", async (_, write) => {
    infoMode = "external";
    const error = await write(client()).catch((e: unknown) => e);
    expect((error as { data?: { error?: string } }).data?.error).toBe(
      EXTERNAL_CHANNEL_BLOCKED_CODE,
    );
    expect(isTerminalSlackError(error)).toBe(true);
    expect(sent()).toEqual([]);
  });

  test.each(writes)("%s: flag on + info failure never reaches Slack", async (_, write) => {
    infoMode = "error";
    const error = await write(client()).catch((e: unknown) => e);
    expect((error as { data?: { error?: string } }).data?.error).toBe(
      EXTERNAL_CHANNEL_UNVERIFIED_CODE,
    );
    expect(isTerminalSlackError(error)).toBe(false);
    expect(sent()).toEqual([]);
  });

  test.each(writes)("%s: flag on + internal channel is delivered", async (_, write) => {
    await write(client());
    expect(sent().length).toBeGreaterThan(0);
  });

  test.each(writes)("%s: flag off makes no lookup", async (_, write) => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "false";
    infoMode = "external";
    await write(client());
    expect(wire).not.toContain("conversations.info");
    expect(sent().length).toBeGreaterThan(0);
  });

  test("a task already running in an external channel stops emitting once the flag is on", async () => {
    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "false";
    infoMode = "external";
    const c = client();
    await c.chat.postMessage({
      channel: CHANNEL,
      text: "before",
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(sent()).toEqual(["chat.postMessage"]);
    wire.length = 0;

    process.env.SLACK_BLOCK_EXTERNAL_CHANNELS = "true";
    for (const [, write] of writes) await write(c).catch(() => {});
    expect(sent()).toEqual([]);
  });

  test("a channel shared after a cached internal lookup stops emitting", async () => {
    const c = client();
    await c.chat.postMessage({
      channel: CHANNEL,
      text: "before share",
      unfurl_links: false,
      unfurl_media: false,
    });
    wire.length = 0;

    // Envelope evidence of the share, with no fresh lookup.
    recordExternalChannel(CHANNEL);
    await expect(
      c.chat.postMessage({
        channel: CHANNEL,
        text: "after",
        unfurl_links: false,
        unfurl_media: false,
      }),
    ).rejects.toThrow(EXTERNAL_CHANNEL_BLOCKED_CODE);
    expect(sent()).toEqual([]);

    // channel_shared event: the cache is invalidated and Slack now says external.
    resetExternalChannelStateForTesting();
    await c.chat.postMessage({
      channel: CHANNEL,
      text: "internal again",
      unfurl_links: false,
      unfurl_media: false,
    });
    infoMode = "external";
    invalidateChannelExternality(CHANNEL);
    wire.length = 0;
    await expect(
      c.chat.update({
        channel: CHANNEL,
        ts: "1.0",
        text: "x",
        unfurl_links: false,
        unfurl_media: false,
      }),
    ).rejects.toThrow(EXTERNAL_CHANNEL_BLOCKED_CODE);
    expect(sent()).toEqual([]);
  });

  test("a second install does not double-wrap", () => {
    const proto = webApi.WebClient.prototype;
    const before = proto.apiCall;
    installSlackExternalChannelGuard();
    expect(proto.apiCall).toBe(before);
  });
});
