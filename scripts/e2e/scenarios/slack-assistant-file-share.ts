import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { claim, findSlackTask, finish, registerLead } from "./slack-helpers";

// A few bytes that are recognisably a PNG; the content is never decoded.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

async function shareImageInAssistantDm(
  ctx: ScenarioContext,
  text: string,
): Promise<Record<string, unknown>> {
  const { channel, thread_ts } = await ctx.slack.startAssistantThread({ user: "alice" });
  const message = await ctx.slack.postMessage({
    channel,
    thread_ts,
    user: "alice",
    text,
    files: [{ name: "screenshot.png", content: PNG, mimetype: "image/png" }],
  });
  ctx.markThread(text ? "image-with-caption" : "image-only", channel, thread_ts);
  expect(
    message.subtype === "file_share",
    `mock posted ${String(message.subtype)}, not file_share`,
  );

  const task = await findSlackTask(ctx, message.ts);
  const taskId = String(task.id);
  // The task is born `draft` and promoted once its attachments are stored.
  const promoted = await pollUntil(async () => {
    const response = await ctx.api("GET", `/api/tasks/${taskId}`);
    expectStatus(response, [200], `read Slack file task ${taskId}`);
    return asRecord(response.json).status !== "draft";
  }, 15_000);
  expect(promoted, `Slack file task ${taskId} was still draft after 15 seconds`);
  return task;
}

async function expectStoredScreenshot(ctx: ScenarioContext, taskId: string): Promise<string> {
  const list = await ctx.api("GET", `/api/fs/tasks/${taskId}/files`);
  expectStatus(list, [200], `list attachments of ${taskId}`);
  const attachments = asRecord(list.json).attachments;
  expect(
    Array.isArray(attachments) && attachments.length === 1,
    `Task ${taskId} has ${JSON.stringify(attachments)} instead of one attachment`,
  );
  const attachment = asRecord(attachments[0]);
  expect(attachment.name === "screenshot.png", `Attachment is named ${String(attachment.name)}`);
  expect(attachment.mimeType === "image/png", `Attachment type is ${String(attachment.mimeType)}`);

  const raw = await fetch(`${ctx.baseUrl}/api/fs/tasks/${taskId}/files/${attachment.id}/raw`, {
    headers: { Authorization: `Bearer ${ctx.apiKey}` },
  });
  expect(raw.ok, `raw download of ${taskId}'s attachment answered ${raw.status}`);
  const bytes = new Uint8Array(await raw.arrayBuffer());
  expect(
    bytes.length === PNG.length && bytes.every((byte, i) => byte === PNG[i]),
    `Stored attachment of ${taskId} does not match the bytes shared on Slack`,
  );
  return String(attachment.id);
}

/**
 * MaximilianoAdaro/agent-swarm#1: an image sent to the Assistant with no
 * caption used to crash task creation, and with a caption the image was
 * silently dropped. Both now land as a stored task attachment the worker
 * receives on poll.
 */
export const slackAssistantFileShare: Scenario = {
  name: "slack-assistant-file-share",
  order: 105,
  async run(ctx) {
    await registerLead(ctx, `e2e-lead-files-${ctx.nonce}`);

    const imageOnly = await shareImageInAssistantDm(ctx, "");
    const imageOnlyId = String(imageOnly.id);
    // Earlier scenarios register leads too; poll as whichever one got the task.
    const assignee = String(imageOnly.agentId);
    expect(
      String(imageOnly.task).includes("[File: screenshot.png (image/png"),
      `Image-only task text is ${JSON.stringify(imageOnly.task)}`,
    );
    const attachmentId = await expectStoredScreenshot(ctx, imageOnlyId);

    const poll = await ctx.api("GET", "/api/poll", { agentId: assignee });
    expectStatus(poll, [200], "lead polls for the image-only task");
    const trigger = asRecord(asRecord(poll.json).trigger);
    const polledTask = asRecord(trigger.task);
    expect(
      polledTask.id === imageOnlyId,
      `Lead polled ${String(polledTask.id)}, not ${imageOnlyId}`,
    );
    expect(
      JSON.stringify(polledTask.attachments).includes(attachmentId),
      `Poll trigger carries attachments ${JSON.stringify(polledTask.attachments)}`,
    );
    await finish(ctx, assignee, imageOnlyId, { status: "completed", output: "Saw the image." });

    const captioned = await shareImageInAssistantDm(ctx, "aaa");
    const captionedId = String(captioned.id);
    expect(
      String(captioned.task).startsWith("aaa") &&
        String(captioned.task).includes("[File: screenshot.png"),
      `Captioned task text is ${JSON.stringify(captioned.task)}`,
    );
    await expectStoredScreenshot(ctx, captionedId);
    // Leave nothing pending for the scenarios that poll after this one.
    await claim(ctx, String(captioned.agentId), captionedId);
    await finish(ctx, String(captioned.agentId), captionedId, {
      status: "completed",
      output: "Saw the image and the caption.",
    });
  },
};
