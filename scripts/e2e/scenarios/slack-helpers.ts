import type { SlackMessage } from "@desplega.ai/slack-mock";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { ScenarioContext } from "../run";

export async function registerLead(ctx: ScenarioContext, name: string): Promise<string> {
  const response = await ctx.api("POST", "/api/agents", {
    body: { name, isLead: true },
  });
  expectStatus(response, [201], `register ${name}`);
  const leadId = asRecord(response.json).id;
  expect(typeof leadId === "string", `Registered agent ${name} has no id`);
  return leadId;
}

export async function ask(
  ctx: ScenarioContext,
  text: string,
  threadTs?: string,
): Promise<SlackMessage> {
  return ctx.slack.postMessage({
    channel: "general",
    user: "alice",
    text: `<@${ctx.slack.bot.userId}> ${text}`,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

export async function waitForReaction(
  ctx: ScenarioContext,
  ts: string,
  name: string,
  timeoutMs = 30_000,
): Promise<void> {
  const found = await pollUntil(
    () =>
      ctx.slack
        .messages("general")
        .find((message) => message.ts === ts)
        ?.reactions?.some((reaction) => reaction.name === name) === true,
    timeoutMs,
  );
  expect(found, `Message ${ts} in general never got a ${name} reaction within ${timeoutMs}ms`);
}

export async function waitForEyes(ctx: ScenarioContext, ts: string): Promise<void> {
  const reaction = await ctx.slack
    .waitForApiCall("reactions.add", {
      timeoutMs: 30_000,
      where: (call) => call.args.name === "eyes" && call.args.timestamp === ts,
    })
    .catch((error) => {
      throw new Error(
        `eyes reaction on general ts ${ts}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  expect(
    reaction.ok === true,
    `reactions.add in general on ts ${ts} failed: ${reaction.error ?? "no error reported"}`,
  );
}

export async function waitForBotReply(
  ctx: ScenarioContext,
  threadTs: string,
): Promise<SlackMessage> {
  try {
    return await ctx.slack.waitForMessage(
      { channel: "general", thread_ts: threadTs, from: "bot" },
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    throw new Error(
      `bot reply in C0GENERAL0 thread ${threadTs}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function findSlackTask(
  ctx: ScenarioContext,
  triggerTs: string,
): Promise<Record<string, unknown>> {
  let task: Record<string, unknown> | undefined;
  const found = await pollUntil(async () => {
    const response = await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=50");
    expectStatus(response, [200], `list slack tasks for general ts ${triggerTs}`);
    const tasks = asRecord(response.json).tasks;
    expect(Array.isArray(tasks), `Task list for general ts ${triggerTs} has no tasks array`);
    const records = tasks.map(asRecord);
    task =
      records.find((row) => row.slackTriggerMessageTs === triggerTs) ??
      records.find((row) => row.slackThreadTs === triggerTs);
    return task !== undefined;
  }, 30_000);
  expect(found && task, `No Slack task for general ts ${triggerTs} within 30 seconds`);
  return task;
}

export async function claim(ctx: ScenarioContext, leadId: string, taskId: string): Promise<void> {
  expectStatus(
    await ctx.api("GET", "/api/poll", { agentId: leadId }),
    [200],
    `agent ${leadId} claims Slack task ${taskId}`,
  );
  const claimed = await pollUntil(async () => {
    const response = await ctx.api("GET", `/api/tasks/${taskId}`);
    expectStatus(response, [200], `read claimed Slack task ${taskId}`);
    return asRecord(response.json).status === "in_progress";
  }, 15_000);
  expect(claimed, `Slack task ${taskId} did not reach in_progress within 15 seconds`);
}

export async function finish(
  ctx: ScenarioContext,
  leadId: string,
  taskId: string,
  body: {
    status: "completed" | "failed";
    output?: string;
    failureReason?: string;
    force?: boolean;
  },
): Promise<void> {
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/finish`, { agentId: leadId, body }),
    [200],
    `finish Slack task ${taskId}`,
  );
}

export async function waitForOutcome(
  ctx: ScenarioContext,
  threadTs: string,
  needle: string,
): Promise<SlackMessage> {
  try {
    return await ctx.slack.waitForMessage(
      (message) =>
        message.channel === "C0GENERAL0" &&
        message.thread_ts === threadTs &&
        JSON.stringify(message).includes(needle),
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    throw new Error(
      `task outcome in C0GENERAL0 thread ${threadTs}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
