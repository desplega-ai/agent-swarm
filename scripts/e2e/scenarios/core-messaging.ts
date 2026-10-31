import { asRecord, asRecords, expect, pollUntil } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario, ScenarioContext } from "../run";
import {
  callTool,
  expectToolError,
  expectToolOk,
  registerLead,
  registerWorker,
  retireAgent,
  UUID,
  withMcp,
} from "./core-helpers";

const GENERAL_ID = "00000000-0000-4000-8000-000000000001";

type ChannelRow = { id: string; type: string; createdBy: string; participants: string };

function channelRow(ctx: ScenarioContext, name: string): ChannelRow | null {
  return ctx.db.get<ChannelRow>(
    "SELECT id, type, createdBy, participants FROM channels WHERE name = ?",
    [name],
  );
}

function messageCount(ctx: ScenarioContext, channelId: string): number {
  return ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM channel_messages WHERE channelId = ?",
    [channelId],
  )?.n as number;
}

/** Channel lifecycle and the posting tools. */
async function channels(
  ctx: ScenarioContext,
  poster: McpConnection,
  posterId: string,
  readerId: string,
): Promise<{ name: string; channelId: string; firstMessageId: string }> {
  const name = `core-chan-${ctx.nonce}`;
  const created = await expectToolOk(poster, "create-channel", {
    name,
    description: `core messaging ${ctx.nonce}`,
  });
  expect(
    created.message === `Created channel "${name}".`,
    `create-channel message ${created.message}`,
  );
  const row = channelRow(ctx, name);
  expect(row !== null, "create-channel never inserted the channel");
  const returned = asRecord(created.data.channel);
  expect(
    returned.id === row?.id && returned.name === name,
    `create-channel returned the wrong channel: ${JSON.stringify(created.data.channel)}`,
  );
  const channelId = String(row?.id);
  expect(
    UUID.test(channelId) && row?.type === "public" && row.createdBy === posterId,
    `channels row is wrong: ${JSON.stringify(row)}`,
  );
  await expectToolError(poster, "create-channel", { name }, "already exists");
  expect((await callTool(poster, "create-channel", { name: "" })).isError, "empty channel name");

  const dmName = `core-dm-${ctx.nonce}`;
  const dm = await expectToolOk(poster, "create-channel", {
    name: dmName,
    type: "dm",
    participants: [posterId, readerId],
  });
  expect(dm.message === `Created channel "${dmName}".`, `dm create message ${dm.message}`);
  expect(channelRow(ctx, dmName) !== null, "The dm channel was never inserted");
  expect(channelRow(ctx, dmName)?.type === "dm", "create-channel ignored the dm type");
  expect(
    JSON.parse(channelRow(ctx, dmName)?.participants ?? "[]").includes(readerId),
    "dm participants not stored",
  );

  const listed = await expectToolOk(poster, "list-channels");
  const names = asRecords(listed.data, "channels").map((entry) => entry.name);
  expect(
    names.includes("general") && names.includes(name) && names.includes(dmName),
    `list-channels lacks channels: ${names.join(",")}`,
  );
  expect(listed.message.includes(name), "list-channels message omits the new channel");
  expect(listed.text.includes(channelId), "list-channels text omits the channel id");

  // post-message
  const first = await expectToolOk(poster, "post-message", {
    channel: name,
    content: `first post ${ctx.nonce}`,
    mentions: [readerId],
  });
  const posted = asRecord(first.data.posted);
  const firstMessageId = String(posted.id);
  expect(
    posted.channelId === channelId &&
      posted.agentId === posterId &&
      posted.content === `first post ${ctx.nonce}` &&
      JSON.stringify(posted.mentions) === JSON.stringify([readerId]),
    `post-message returned ${JSON.stringify(posted)}`,
  );
  expect(first.message === `Posted message to #${name}.`, `post-message message: ${first.message}`);
  const reply = await expectToolOk(poster, "post-message", {
    channel: channelId,
    content: `reply by id ${ctx.nonce}`,
    replyTo: firstMessageId,
  });
  expect(asRecord(reply.data.posted).replyToId === firstMessageId, "replyTo not stored");
  expect(messageCount(ctx, channelId) === 2, "channel_messages does not hold both posts");
  await expectToolError(
    poster,
    "post-message",
    { channel: `no-such-${ctx.nonce}`, content: "x" },
    "not found",
  );
  expect(
    (await callTool(poster, "post-message", { channel: name, content: "z".repeat(4001) })).isError,
    "post-message accepted a 4001-character message",
  );
  expect((await callTool(poster, "post-message", { channel: name, content: "" })).isError, "empty");
  return { name, channelId, firstMessageId };
}

/** An @mention wakes the idle agent through the poll loop. */
async function mentionTrigger(ctx: ScenarioContext, readerId: string, channelId: string) {
  const sim = await ctx.startAgent({ agentId: readerId });
  try {
    const woke = await pollUntil(
      () => sim.triggers.some((trigger) => trigger.type === "unread_mentions"),
      20_000,
      100,
    );
    expect(woke, "The mentioned agent never received an unread_mentions trigger");
    const trigger = asRecord(sim.triggers.find((entry) => entry.type === "unread_mentions"));
    expect(
      Array.isArray(trigger.claimedChannels) && trigger.claimedChannels.includes(channelId),
      `unread_mentions trigger lacks the claimed channel: ${JSON.stringify(trigger)}`,
    );
    expect(
      typeof trigger.mentionsCount === "number" && trigger.mentionsCount >= 1,
      `unread_mentions reports no mentions for a claimed channel: ${JSON.stringify(trigger)}`,
    );
    // The claim holds the mentions: a second poll must not repeat the trigger.
    const count = sim.triggers.filter((entry) => entry.type === "unread_mentions").length;
    await sim.pollOnce();
    expect(
      sim.triggers.filter((entry) => entry.type === "unread_mentions").length === count,
      "A claimed mention was handed out twice",
    );
  } finally {
    await sim.stop();
  }
}

/** Reading: filters, read state, the all-channels digest. */
async function reading(
  ctx: ScenarioContext,
  reader: McpConnection,
  poster: McpConnection,
  readerId: string,
  name: string,
  channelId: string,
) {
  // The poster's own messages never count as unread for the poster.
  let outcome = await expectToolOk(poster, "read-messages", { channel: name, unreadOnly: true });
  expect(
    asRecords(outcome.data, "messages").length === 0,
    "A poster sees their own posts as unread",
  );

  outcome = await expectToolOk(reader, "read-messages", {
    channel: name,
    unreadOnly: true,
    markAsRead: false,
  });
  expect(
    asRecords(outcome.data, "messages").length === 2,
    "The reader should have 2 unread messages",
  );
  expect(outcome.data.unreadCount === 2 && outcome.data.channelName === name, "unread bookkeeping");
  outcome = await expectToolOk(reader, "read-messages", { channel: name, mentionsOnly: true });
  const mentions = asRecords(outcome.data, "messages");
  expect(
    mentions.length === 1 && String(mentions[0]?.content).startsWith("first post"),
    "mentionsOnly should return the one mention",
  );
  outcome = await expectToolOk(reader, "read-messages", { channel: name, limit: 1 });
  expect(asRecords(outcome.data, "messages").length === 1, "limit:1 returned several messages");
  outcome = await expectToolOk(reader, "read-messages", {
    channel: name,
    since: "2099-01-01T00:00:00.000Z",
  });
  expect(asRecords(outcome.data, "messages").length === 0, "A future since matched messages");
  // The read above marked the channel read.
  outcome = await expectToolOk(reader, "read-messages", { channel: name, unreadOnly: true });
  expect(asRecords(outcome.data, "messages").length === 0, "Reading did not mark the channel read");
  expect(
    ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM channel_read_state WHERE agentId = ? AND channelId = ?",
      [readerId, channelId],
    )?.n === 1,
    "channel_read_state lacks the reader",
  );

  // Without a channel: the unread digest across channels, with the channel in the author label.
  await expectToolOk(poster, "post-message", { channel: name, content: `late news ${ctx.nonce}` });
  outcome = await expectToolOk(reader, "read-messages", { markAsRead: false });
  const digest = asRecords(outcome.data, "messages");
  expect(
    digest.some(
      (message) =>
        String(message.content).includes(`late news ${ctx.nonce}`) &&
        String(message.agentName).endsWith(`in #${name}`),
    ),
    "The all-channels digest omits the new message",
  );
  expect(Number(outcome.data.totalUnreadCount) >= 1, "totalUnreadCount");
  outcome = await expectToolOk(reader, "read-messages", {});
  expect(asRecords(outcome.data, "messages").length >= 1, "markAsRead:false consumed the digest");
  outcome = await expectToolOk(reader, "read-messages", {});
  expect(
    !asRecords(outcome.data, "messages").some((message) =>
      String(message.content).includes("late news"),
    ),
    "A digest read did not mark the messages read",
  );
  await expectToolError(reader, "read-messages", { channel: `no-such-${ctx.nonce}` }, "not found");
  expect(
    (await callTool(reader, "read-messages", { channel: name, since: "yesterday" })).isError,
    "A malformed since was accepted",
  );
}

/** delete-channel is lead only and protects #general. */
async function deletion(
  ctx: ScenarioContext,
  worker: McpConnection,
  lead: McpConnection,
  name: string,
  channelId: string,
) {
  await expectToolError(worker, "delete-channel", { name }, "Only the lead agent");
  await expectToolError(lead, "delete-channel", {}, "Either channelId or name");
  await expectToolError(lead, "delete-channel", { channelId: GENERAL_ID }, "cannot be deleted");
  await expectToolError(lead, "delete-channel", { name: `no-such-${ctx.nonce}` }, "not found");
  expect(messageCount(ctx, channelId) === 3, "The channel should hold 3 messages before deletion");

  const byName = await expectToolOk(lead, "delete-channel", { name });
  expect(
    byName.message === `Deleted channel "${name}".`,
    `delete-channel message ${byName.message}`,
  );
  expect(channelRow(ctx, name) === null, "The channel row survived");
  expect(messageCount(ctx, channelId) === 0, "Deleting a channel left its messages behind");
  await expectToolError(lead, "delete-channel", { name }, "not found");

  const dmName = `core-dm-${ctx.nonce}`;
  const dmId = channelRow(ctx, dmName)?.id;
  expect(dmId !== undefined, "The dm channel disappeared");
  await expectToolOk(lead, "delete-channel", { channelId: dmId });
  expect(channelRow(ctx, dmName) === null, "Delete by id left the dm channel");
}

export const coreMessaging: Scenario = {
  name: "core-messaging",
  order: 270,
  async run(ctx) {
    const posterId = await registerWorker(ctx, "poster");
    const readerId = await registerWorker(ctx, "reader");
    const leadId = await registerLead(ctx, "messaging");
    try {
      await withMcp(ctx, posterId, async (poster) => {
        await withMcp(ctx, readerId, async (reader) => {
          await withMcp(ctx, leadId, async (lead) => {
            const { name, channelId } = await channels(ctx, poster, posterId, readerId);
            await mentionTrigger(ctx, readerId, channelId);
            await reading(ctx, reader, poster, readerId, name, channelId);
            await deletion(ctx, reader, lead, name, channelId);
          });
        });
      });
    } finally {
      await retireAgent(ctx, leadId);
    }
  },
};
