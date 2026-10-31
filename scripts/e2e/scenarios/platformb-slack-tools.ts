import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlackMessage } from "@desplega.ai/slack-mock";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario } from "../run";
import {
  Cleanup,
  callTool,
  expectToolError,
  expectToolOk,
  registerLead,
  registerWorker,
  retireAgent,
} from "./platformb-helpers";
import { ask, findSlackTask } from "./slack-helpers";

const LEAD_ONLY = {
  post: "Posting to Slack channels requires lead privileges.",
  update: "Editing Slack messages requires lead privileges.",
  delete: "Deleting Slack messages requires lead privileges.",
  channels: "Managing Slack channels requires lead privileges.",
  direct: "Direct channel access requires lead privileges.",
};

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}

/**
 * The thirteen slack-* tools against the Slack mock's Web API journal. A lead drives the
 * channel, message and file tools in a channel the scenario creates; a worker proves each
 * lead-only gate; a Slack-originated task (a mention in #general) proves the task-scoped paths
 * of slack-read, slack-reply, slack-upload-file, slack-download-file and slack-leave-thread.
 */
export const platformbSlackTools: Scenario = {
  name: "platformb-slack-tools",
  order: 680,
  async run(ctx) {
    const cleanup = new Cleanup();
    const channelIds: string[] = [];
    let leadId: string | undefined;
    let workerConn: McpConnection | undefined;
    let leadConn: McpConnection | undefined;
    let taskConn: McpConnection | undefined;
    let scratchDir: string | undefined;
    let openTaskId: string | undefined;
    cleanup.add("close MCP", async () => {
      await workerConn?.close();
      await leadConn?.close();
      await taskConn?.close();
    });
    cleanup.add("retire lead", () => retireAgent(ctx, leadId));
    cleanup.add("remove scratch files", async () => {
      if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
    });
    cleanup.add("archive channels", async () => {
      if (!leadConn) return;
      for (const channelId of channelIds) {
        await callTool(leadConn, "slack-archive-channel", { channelId });
      }
    });
    cleanup.add("cancel the Slack task", async () => {
      if (openTaskId) await ctx.api("POST", `/api/tasks/${openTaskId}/cancel`, { body: {} });
    });

    await cleanup.around(async () => {
      const marker = `tools-${ctx.nonce}`;
      const workerId = await registerWorker(ctx, `e2e-platformb-slack-worker-${ctx.nonce}`);
      leadId = await registerLead(ctx, `e2e-platformb-slack-lead-${ctx.nonce}`);
      workerConn = await ctx.connectMcp(workerId);
      leadConn = await ctx.connectMcp(leadId);
      scratchDir = await mkdtemp(join(tmpdir(), "e2e-platformb-slack-"));
      const botMessages = (channel: string): SlackMessage[] =>
        ctx.slack.messages(channel).filter((message) => message.bot_id === ctx.slack.bot.botId);

      // ===== slack-list-channels (any agent) =====
      let outcome = expectToolOk(
        await callTool(workerConn, "slack-list-channels", {}),
        "slack-list-channels",
      );
      const channels = asRecords(outcome.data, "channels");
      const general = channels.find((channel) => channel.id === "C0GENERAL0");
      expect(
        general?.name === "general" && general.type === "public" && general.isMember === true,
        `#general is listed as ${JSON.stringify(general)}`,
      );
      expect(outcome.text.includes("general [public] - ID: C0GENERAL0"), "Channel text is wrong");
      outcome = expectToolOk(
        await callTool(workerConn, "slack-list-channels", { types: ["private"] }),
        "slack-list-channels private only",
      );
      expect(
        asRecords(outcome.data, "channels").every((channel) => channel.type === "private"),
        "The private filter returned a public channel",
      );
      expect(
        ctx.slack.apiCalls("conversations.list").at(-1)?.args.types === "private_channel",
        "The type filter did not reach conversations.list",
      );
      outcome = expectToolOk(
        await callTool(workerConn, "slack-list-channels", { limit: 1 }),
        "slack-list-channels limit 1",
      );
      expect(asRecords(outcome.data, "channels").length <= 1, "limit 1 returned two channels");
      expect(
        (await callTool(workerConn, "slack-list-channels", { limit: 201 })).isError,
        "slack-list-channels accepted limit 201",
      );

      // ===== slack-create-channel / slack-invite-to-channel / slack-archive-channel =====
      const channelName = `e2e-tools-${ctx.nonce}`;
      outcome = expectToolOk(
        await callTool(leadConn, "slack-create-channel", { name: `E2E Tools ${ctx.nonce}!!` }),
        "slack-create-channel",
      );
      const channelId = asString(outcome.data.channelId, "created channel id");
      channelIds.push(channelId);
      expect(
        outcome.data.name === channelName && outcome.data.isPrivate === false,
        `Created channel is ${JSON.stringify(outcome.data)}`,
      );
      const created = ctx.slack.channel(channelId);
      expect(
        created.name === channelName && created.is_private === false && !created.is_archived,
        "The mock channel does not match the tool result",
      );
      const privateName = `e2e-private-${ctx.nonce}`;
      outcome = expectToolOk(
        await callTool(leadConn, "slack-create-channel", { name: privateName, isPrivate: true }),
        "slack-create-channel private",
      );
      const privateId = asString(outcome.data.channelId, "private channel id");
      channelIds.push(privateId);
      expect(ctx.slack.channel(privateId).is_private === true, "The private channel is public");
      expectToolError(
        await callTool(leadConn, "slack-create-channel", { name: channelName }),
        "is already taken",
        "create a channel with a taken name",
      );
      expectToolError(
        await callTool(leadConn, "slack-create-channel", { name: "!!!" }),
        "Failed to create Slack channel",
        "create a channel with no usable characters",
      );
      expectToolError(
        await callTool(workerConn, "slack-create-channel", { name: `e2e-worker-${ctx.nonce}` }),
        LEAD_ONLY.channels,
        "worker slack-create-channel",
      );

      outcome = expectToolOk(
        await callTool(leadConn, "slack-invite-to-channel", {
          channelId,
          userIds: ["U0ALICE000", "U0BOB00000"],
        }),
        "slack-invite-to-channel",
      );
      expect(
        outcome.data.alreadyInChannel === false &&
          outcome.message === "Users invited to the Slack channel successfully.",
        `Invite result is ${JSON.stringify(outcome.data)}`,
      );
      const members = ctx.slack.channel(channelId).members;
      expect(
        members.includes("U0ALICE000") && members.includes("U0BOB00000"),
        "The invited users are not channel members",
      );
      outcome = expectToolOk(
        await callTool(leadConn, "slack-invite-to-channel", {
          channelId,
          userIds: ["U0ALICE000"],
        }),
        "slack-invite-to-channel again",
      );
      expect(
        outcome.data.alreadyInChannel === true &&
          outcome.message === "Users are already in the Slack channel.",
        `Second invite result is ${JSON.stringify(outcome.data)}`,
      );
      expectToolError(
        await callTool(leadConn, "slack-invite-to-channel", {
          channelId,
          userIds: ["U0NOSUCHUSR"],
        }),
        "Failed to invite users to Slack channel",
        "invite an unknown user",
      );
      expectToolError(
        await callTool(workerConn, "slack-invite-to-channel", {
          channelId,
          userIds: ["U0BOB00000"],
        }),
        LEAD_ONLY.channels,
        "worker slack-invite-to-channel",
      );
      expect(
        (await callTool(leadConn, "slack-invite-to-channel", { channelId, userIds: [] })).isError,
        "slack-invite-to-channel accepted an empty user list",
      );

      // ===== slack-post / slack-start-thread =====
      const postText = `**post** ${marker}`;
      outcome = expectToolOk(
        await callTool(leadConn, "slack-post", { channelId, message: postText }),
        "slack-post",
      );
      const postTs = asString(outcome.data.messageTs, "posted message ts");
      const posted = ctx.slack.messages(channelId).find((message) => message.ts === postTs);
      expect(
        posted?.bot_id === ctx.slack.bot.botId && posted.text.includes(marker),
        `The mock message is ${JSON.stringify(posted)}`,
      );
      expect(!posted.text.includes("**"), "Markdown bold was not converted to Slack mrkdwn");
      expect(
        ctx.slack
          .apiCalls("chat.postMessage")
          .some((call) => call.ok && call.args.channel === channelId),
        "chat.postMessage was not journaled for the channel",
      );
      const blocksText = `custom block ${marker}`;
      outcome = expectToolOk(
        await callTool(leadConn, "slack-post", {
          channelId,
          message: "fallback text",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: blocksText } }],
        }),
        "slack-post with blocks",
      );
      const withBlocks = ctx.slack
        .messages(channelId)
        .find((message) => message.ts === outcome.data.messageTs);
      expect(
        JSON.stringify(withBlocks?.blocks).includes(blocksText),
        "The Block Kit payload did not reach Slack",
      );
      expectToolError(
        await callTool(workerConn, "slack-post", { channelId, message: "denied" }),
        LEAD_ONLY.post,
        "worker slack-post",
      );
      expect(
        (await callTool(leadConn, "slack-post", { channelId, message: "x".repeat(4001) })).isError,
        "slack-post accepted a message over 4000 characters",
      );
      expectToolError(
        await callTool(leadConn, "slack-post", {
          channelId: "C0NOSUCHCH",
          message: `lost ${marker}`,
        }),
        "Failed to post message",
        "post to a channel that does not exist",
      );
      // A user id posts in the bot's DM with that user.
      outcome = expectToolOk(
        await callTool(leadConn, "slack-post", {
          channelId: "U0ALICE000",
          message: `dm ${marker}`,
        }),
        "slack-post to a user",
      );
      expect(
        ctx.slack.apiCalls("conversations.open").some((call) => call.args.users === "U0ALICE000"),
        "Posting to a user id did not open a DM",
      );
      const dm = ctx.slack.openDm("U0ALICE000");
      expect(
        botMessages(dm.id).some((message) => message.text.includes(`dm ${marker}`)),
        "The DM message is not in alice's DM",
      );

      outcome = expectToolOk(
        await callTool(leadConn, "slack-start-thread", {
          channelId,
          message: `thread root ${marker}`,
        }),
        "slack-start-thread",
      );
      const threadTs = asString(outcome.data.ts, "thread ts");
      expect(
        outcome.data.channelId === channelId && outcome.data.messageTs === threadTs,
        `Thread result is ${JSON.stringify(outcome.data)}`,
      );
      expect(
        ctx.slack.messages(channelId).some((m) => m.ts === threadTs && m.thread_ts === undefined),
        "The thread root is not a top-level message",
      );
      outcome = expectToolOk(
        await callTool(leadConn, "slack-post", {
          channelId,
          threadTs,
          message: `thread reply ${marker}`,
        }),
        "slack-post into a thread",
      );
      const replyTs = asString(outcome.data.messageTs, "thread reply ts");
      expect(
        ctx.slack.thread(channelId, threadTs).some((m) => m.ts === replyTs),
        "The reply is not in the thread",
      );
      expectToolError(
        await callTool(workerConn, "slack-start-thread", { channelId, message: "denied" }),
        LEAD_ONLY.post,
        "worker slack-start-thread",
      );
      expectToolError(
        await callTool(leadConn, "slack-start-thread", {
          channelId: "C0NOSUCHCH",
          message: "lost",
        }),
        "Failed to start thread",
        "start a thread in a channel that does not exist",
      );

      // ===== slack-read =====
      const human = await ctx.slack.postMessage({
        channel: channelId,
        user: "alice",
        text: `human note ${marker}`,
      });
      outcome = expectToolOk(
        await callTool(leadConn, "slack-read", { channelId, limit: 50 }),
        "slack-read a channel",
      );
      let read = asRecords(outcome.data, "messages");
      expect(
        read.some((message) => message.ts === human.ts && message.isBot === false) &&
          read.some((message) => message.ts === postTs && message.isBot === true),
        "slack-read missed a human or bot message",
      );
      expect(
        outcome.text.includes(`[alice]: human note ${marker}`),
        "slack-read text omits the human author",
      );
      outcome = expectToolOk(
        await callTool(leadConn, "slack-read", { channelId, threadTs, limit: 10 }),
        "slack-read a thread",
      );
      read = asRecords(outcome.data, "messages");
      expect(
        read.length === 2 &&
          read.some((message) => message.ts === threadTs) &&
          read.some((message) => message.ts === replyTs),
        `Thread read returned ${read.length} messages`,
      );
      outcome = expectToolOk(
        await callTool(leadConn, "slack-read", { channelId, limit: 1 }),
        "slack-read limit 1",
      );
      expect(asRecords(outcome.data, "messages").length === 1, "limit 1 returned several messages");
      expectToolError(
        await callTool(workerConn, "slack-read", { channelId }),
        LEAD_ONLY.direct,
        "worker slack-read of a channel",
      );
      expectToolError(
        await callTool(leadConn, "slack-read", {}),
        "Must provide inboxMessageId, taskId, or channelId.",
        "slack-read with no context",
      );

      // ===== slack-update / slack-delete =====
      const pForm = `p${postTs.replace(".", "")}`;
      outcome = expectToolOk(
        await callTool(leadConn, "slack-update", {
          channelId,
          messageTs: pForm,
          message: `edited ${marker}`,
        }),
        "slack-update by p-form ts",
      );
      expect(outcome.data.messageTs === postTs, "slack-update answered another ts");
      const edited = ctx.slack.messages(channelId).find((message) => message.ts === postTs);
      expect(
        edited?.text.includes(`edited ${marker}`) && edited.edited !== undefined,
        `The mock message after the edit is ${JSON.stringify(edited)}`,
      );
      // The mock lets a bot touch any message. Slack does not, so the error codes Slack answers with
      // are injected to check how the tool maps each one for the agent.
      for (const [error, needle] of [
        ["cant_update_message", "the bot can only edit messages it authored"],
        ["edit_window_closed", "The edit window for this message has closed."],
        ["channel_not_found", "Channel not found or the bot has no access."],
        ["not_in_channel", "The bot is not in that channel."],
        ["internal_error", "Failed to update message"],
      ] as const) {
        ctx.slack.injectFault({ method: "chat.update", error });
        expectToolError(
          await callTool(leadConn, "slack-update", {
            channelId,
            messageTs: human.ts,
            message: "hijack",
          }),
          needle,
          `slack-update answered with ${error}`,
        );
      }
      expect(
        ctx.slack.messages(channelId).find((message) => message.ts === human.ts)?.text ===
          `human note ${marker}`,
        "A refused edit changed the human's message",
      );
      expectToolError(
        await callTool(leadConn, "slack-update", {
          channelId,
          messageTs: "1700000000.000001",
          message: "ghost",
        }),
        "No message found at that timestamp",
        "edit a message that does not exist",
      );
      expectToolError(
        await callTool(workerConn, "slack-update", { channelId, messageTs: postTs, message: "no" }),
        LEAD_ONLY.update,
        "worker slack-update",
      );

      expectToolError(
        await callTool(workerConn, "slack-delete", { channelId, messageTs: postTs }),
        LEAD_ONLY.delete,
        "worker slack-delete",
      );
      for (const [error, needle] of [
        ["cant_delete_message", "the bot can only delete messages it authored"],
        ["channel_not_found", "Channel not found or the bot has no access."],
        ["not_in_channel", "The bot is not in that channel."],
        ["internal_error", "Failed to delete message"],
      ] as const) {
        ctx.slack.injectFault({ method: "chat.delete", error });
        expectToolError(
          await callTool(leadConn, "slack-delete", { channelId, messageTs: human.ts }),
          needle,
          `slack-delete answered with ${error}`,
        );
      }
      expectToolError(
        await callTool(leadConn, "slack-delete", {
          channelId,
          messageTs: "1700000000.000001",
        }),
        "No message found at that timestamp",
        "delete a message that does not exist",
      );
      expectToolOk(
        await callTool(leadConn, "slack-delete", { channelId, messageTs: postTs }),
        "slack-delete",
      );
      expect(
        !ctx.slack.messages(channelId).some((message) => message.ts === postTs),
        "The deleted message is still in the channel",
      );
      expect(
        ctx.slack.messages(channelId).some((message) => message.ts === human.ts),
        "A refused delete removed the human's message",
      );

      // ===== slack-upload-file / slack-download-file with a channel =====
      const fileBody = `file body ${marker}`;
      const fileName = `e2e-${ctx.nonce}.txt`;
      outcome = expectToolOk(
        await callTool(leadConn, "slack-upload-file", {
          channelId,
          threadTs,
          content: base64(fileBody),
          filename: fileName,
          initialComment: `see attached ${marker}`,
        }),
        "slack-upload-file with content",
      );
      const fileId = asString(outcome.data.fileId, "uploaded file id");
      const completed = ctx.slack
        .apiCalls("files.completeUploadExternal")
        .find((call) => call.ok && call.args.channel_id === channelId);
      expect(
        completed?.args.thread_ts === threadTs &&
          String(completed.args.initial_comment ?? "").includes(`see attached ${marker}`),
        `files.completeUploadExternal was called with ${JSON.stringify(completed?.args)}`,
      );
      expect(
        ctx.slack
          .apiCalls("files.getUploadURLExternal")
          .some(
            (call) =>
              call.args.filename === fileName && Number(call.args.length) === fileBody.length,
          ),
        "files.getUploadURLExternal did not announce the file",
      );
      // A file on the API server's disk uploads by path; the name defaults to the basename.
      const diskPath = join(scratchDir, `disk-${ctx.nonce}.txt`);
      await Bun.write(diskPath, `disk body ${marker}`);
      outcome = expectToolOk(
        await callTool(leadConn, "slack-upload-file", { channelId, filePath: diskPath }),
        "slack-upload-file with filePath",
      );
      expect(
        ctx.slack
          .apiCalls("files.getUploadURLExternal")
          .some((call) => call.args.filename === `disk-${ctx.nonce}.txt`),
        "The path upload did not use the file's basename",
      );
      for (const [args, needle, label] of [
        [{ channelId }, "Must provide either filePath or content (base64).", "no file"],
        [
          { channelId, filePath: diskPath, content: base64("x"), filename: "x.txt" },
          "Cannot provide both filePath and content",
          "both file sources",
        ],
        [{ channelId, content: base64("x") }, "filename is required", "content with no filename"],
        [
          { channelId, filePath: join(scratchDir, "missing.txt") },
          "File not found",
          "a path that does not exist",
        ],
        [
          { content: base64("x"), filename: "x.txt" },
          "Must provide inboxMessageId, taskId, or channelId.",
          "no context",
        ],
      ] as const) {
        expectToolError(
          await callTool(leadConn, "slack-upload-file", args),
          needle,
          `slack-upload-file with ${label}`,
        );
      }
      expectToolError(
        await callTool(workerConn, "slack-upload-file", {
          channelId,
          content: base64("x"),
          filename: "x.txt",
        }),
        LEAD_ONLY.direct,
        "worker slack-upload-file to a channel",
      );

      // Download by id into a directory, then by URL into a named file.
      outcome = expectToolOk(
        await callTool(workerConn, "slack-download-file", { fileId, savePath: `${scratchDir}/` }),
        "slack-download-file by id",
      );
      const savedPath = asString(outcome.data.savedPath, "saved path");
      expect(savedPath === join(scratchDir, fileName), `File saved at ${savedPath}`);
      expect((await Bun.file(savedPath).text()) === fileBody, "The downloaded bytes differ");
      expect(
        asRecord(outcome.data.fileInfo).name === fileName &&
          asRecord(outcome.data.fileInfo).id === fileId,
        "Download result lacks the file info",
      );
      const downloadUrl = ctx.slack.store.file(fileId).url_private_download;
      const byUrlPath = join(scratchDir, `by-url-${ctx.nonce}.txt`);
      expectToolOk(
        await callTool(workerConn, "slack-download-file", {
          url: downloadUrl,
          savePath: byUrlPath,
        }),
        "slack-download-file by url",
      );
      expect((await Bun.file(byUrlPath).text()) === fileBody, "The URL download bytes differ");
      expectToolError(
        await callTool(workerConn, "slack-download-file", {}),
        "Must provide either fileId or url.",
        "slack-download-file with no file",
      );
      expectToolError(
        await callTool(workerConn, "slack-download-file", { fileId: "F0NOSUCHFIL" }),
        "File not found: F0NOSUCHFIL",
        "slack-download-file of an unknown file",
      );

      // ===== a Slack-originated task: task-scoped read, reply, upload, download, leave =====
      const mention = await ask(ctx, `platformb slack tools ${marker}`);
      const task = await findSlackTask(ctx, mention.ts);
      const taskId = asString(task.id, "Slack task id");
      const assignee = asString(task.agentId, "Slack task assignee");
      const slackChannel = asString(task.slackChannelId, "task channel");
      const slackThread = asString(task.slackThreadTs, "task thread");
      openTaskId = taskId;
      taskConn = await ctx.connectMcp(assignee);

      outcome = expectToolOk(
        await callTool(taskConn, "slack-read", { taskId, limit: 50 }),
        "slack-read by task",
      );
      expect(
        outcome.data.channelId === slackChannel &&
          asRecords(outcome.data, "messages").some((message) =>
            String(message.text).includes(`platformb slack tools ${marker}`),
          ),
        "slack-read by task did not return the thread",
      );
      expectToolError(
        await callTool(workerConn, "slack-read", { taskId }),
        "You don't have context for this task.",
        "slack-read of another agent's task",
      );
      expectToolError(
        await callTool(taskConn, "slack-read", { taskId: crypto.randomUUID() }),
        "Task not found.",
        "slack-read of a missing task",
      );

      const replyText = `task reply ${marker}`;
      outcome = expectToolOk(
        await callTool(taskConn, "slack-reply", { taskId, message: replyText }),
        "slack-reply",
      );
      const taskReplyTs = asString(outcome.data.messageTs, "task reply ts");
      const taskReply = ctx.slack
        .thread(slackChannel, slackThread)
        .find((message) => message.ts === taskReplyTs);
      expect(
        taskReply?.bot_id === ctx.slack.bot.botId && taskReply.text.includes(replyText),
        "slack-reply did not post in the task's thread",
      );
      const taskRow = await ctx.api("GET", `/api/tasks/${taskId}`);
      expectStatus(taskRow, [200], "read the Slack task after the reply");
      expect(asRecord(taskRow.json).slackReplySent === true, "slack-reply did not mark the reply");
      for (const [args, conn, needle, label] of [
        [{ message: "x" }, taskConn, "Must provide inboxMessageId or taskId.", "no context"],
        [
          { message: "x", taskId, inboxMessageId: crypto.randomUUID() },
          taskConn,
          "Provide either inboxMessageId or taskId, not both.",
          "both contexts",
        ],
        [
          { message: "x", inboxMessageId: crypto.randomUUID() },
          taskConn,
          "Inbox message not found.",
          "a missing inbox message",
        ],
        [
          { message: "x", taskId: crypto.randomUUID() },
          taskConn,
          "Task not found.",
          "a missing task",
        ],
        [
          { message: "x", taskId },
          workerConn,
          "You don't have context for this task.",
          "another agent's task",
        ],
      ] as const) {
        expectToolError(
          await callTool(conn as McpConnection, "slack-reply", args),
          needle,
          `slack-reply with ${label}`,
        );
      }
      // A task that did not come from Slack has no thread to reply in.
      const plain = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `plain task ${marker}`,
          agentId: assignee,
          routingReason: "human_pinned",
          source: "api",
        },
      });
      expectStatus(plain, [201], "create a task with no Slack context");
      const plainId = asString(asRecord(plain.json).id, "plain task id");
      expectToolError(
        await callTool(taskConn, "slack-reply", { taskId: plainId, message: "x" }),
        "No Slack context available.",
        "slack-reply on a task with no Slack thread",
      );
      expectStatus(
        await ctx.api("POST", `/api/tasks/${plainId}/cancel`, { body: {} }),
        [200],
        "cancel the plain task",
      );

      outcome = expectToolOk(
        await callTool(taskConn, "slack-upload-file", {
          taskId,
          content: base64(`task file ${marker}`),
          filename: `task-${ctx.nonce}.txt`,
        }),
        "slack-upload-file by task",
      );
      const taskUpload = ctx.slack
        .apiCalls("files.completeUploadExternal")
        .filter((call) => call.ok && call.args.channel_id === slackChannel)
        .at(-1);
      expect(
        taskUpload?.args.thread_ts === slackThread,
        `The task upload went to thread ${String(taskUpload?.args.thread_ts)}`,
      );

      // slack-download-file with a task stores the file as that task's attachment.
      outcome = expectToolOk(
        await callTool(taskConn, "slack-download-file", { fileId, taskId }),
        "slack-download-file by task",
      );
      const attachmentId = asString(outcome.data.attachmentId, "attachment id");
      expect(
        outcome.data.taskId === taskId && typeof outcome.data.fetchCommand === "string",
        `Task download result is ${JSON.stringify(outcome.data)}`,
      );
      const attachment = await ctx.api("GET", `/api/fs/tasks/${taskId}/files/${attachmentId}`);
      expectStatus(attachment, [200], "read the attached Slack file");
      expect(
        asRecord(attachment.json).name === fileName &&
          asRecord(attachment.json).sizeBytes === fileBody.length,
        `The attachment is ${JSON.stringify(attachment.json)}`,
      );
      expectToolError(
        await callTool(workerConn, "slack-download-file", { fileId, taskId }),
        "You don't have context for this task.",
        "slack-download-file onto another agent's task",
      );

      // slack-read from a task stores the thread's files as attachments of that task.
      outcome = expectToolOk(
        await callTool(taskConn, "slack-read", { taskId, limit: 50 }),
        "slack-read by task with files",
      );
      const withFile = asRecords(outcome.data, "messages").find(
        (message) => Array.isArray(message.files) && message.files.length > 0,
      );
      expect(withFile, "slack-read by task returned no message with a file");

      // --- slack-leave-thread: by task, by channel and thread, and the gates around both.
      outcome = expectToolOk(
        await callTool(taskConn, "slack-leave-thread", { taskId }),
        "slack-leave-thread by task",
      );
      expect(
        outcome.data.channelId === slackChannel && outcome.data.threadTs === slackThread,
        `Leave result is ${JSON.stringify(outcome.data)}`,
      );
      const leftKey = `${slackChannel}:${slackThread}`;
      const leftRow = ctx.db.get<{ value: string }>(
        "SELECT value FROM kv_entries WHERE namespace = 'slack-left-thread' AND key = ?",
        [leftKey],
      );
      expect(leftRow, "slack-leave-thread stored no left-thread entry");
      expect(
        asRecord(JSON.parse(leftRow.value)).agentId === assignee,
        "The left-thread entry does not name the agent that left",
      );
      expectToolOk(
        await callTool(leadConn, "slack-leave-thread", {
          channelId,
          threadTs: `p${threadTs.replace(".", "")}`,
        }),
        "slack-leave-thread by channel and thread",
      );
      expect(
        ctx.db.get("SELECT 1 FROM kv_entries WHERE namespace = 'slack-left-thread' AND key = ?", [
          `${channelId}:${threadTs}`,
        ]) !== null,
        "slack-leave-thread by channel stored no entry for the p-form ts",
      );
      for (const [args, conn, needle, label] of [
        [
          { taskId, channelId, threadTs },
          leadConn,
          "Provide either taskId or channelId and threadTs, not both.",
          "both forms",
        ],
        [{}, leadConn, "Must provide taskId, or both channelId and threadTs.", "nothing"],
        [
          { channelId, threadTs },
          workerConn,
          "requires lead privileges",
          "a worker leaving by channel and thread",
        ],
        [
          { taskId },
          workerConn,
          "Only a lead or the agent assigned",
          "a worker leaving another task",
        ],
        [{ taskId: crypto.randomUUID() }, leadConn, "Task not found.", "a missing task"],
      ] as const) {
        expectToolError(
          await callTool(conn, "slack-leave-thread", args),
          needle,
          `slack-leave-thread with ${label}`,
        );
      }

      // --- slack-archive-channel last, once nothing needs the channels.
      outcome = expectToolOk(
        await callTool(leadConn, "slack-archive-channel", { channelId }),
        "slack-archive-channel",
      );
      expect(outcome.data.alreadyArchived === false, "A first archive reported already archived");
      expect(ctx.slack.channel(channelId).is_archived === true, "The mock channel is not archived");
      outcome = expectToolOk(
        await callTool(leadConn, "slack-archive-channel", { channelId }),
        "slack-archive-channel again",
      );
      expect(
        outcome.data.alreadyArchived === true &&
          outcome.message === "Slack channel is already archived.",
        `Second archive result is ${JSON.stringify(outcome.data)}`,
      );
      expectToolError(
        await callTool(leadConn, "slack-archive-channel", { channelId: "C0GENERAL0" }),
        "general channel cannot be archived",
        "archive #general",
      );
      expectToolError(
        await callTool(workerConn, "slack-archive-channel", { channelId: privateId }),
        LEAD_ONLY.channels,
        "worker slack-archive-channel",
      );
      expectToolOk(
        await callTool(leadConn, "slack-archive-channel", { channelId: privateId }),
        "archive the private channel",
      );
      channelIds.length = 0;

      // The tools only need the task assigned to the caller, not claimed. Cancelling it settles the
      // thread without polling, which would claim whatever earlier scenarios left pending.
      expectStatus(
        await ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: {} }),
        [200],
        "cancel the Slack task",
      );
      openTaskId = undefined;
    });
  },
};
