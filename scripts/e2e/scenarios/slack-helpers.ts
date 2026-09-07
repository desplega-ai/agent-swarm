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

export async function registerWorker(ctx: ScenarioContext, name: string): Promise<string> {
  const response = await ctx.api("POST", "/api/agents", {
    body: { name, role: "worker", status: "online" },
  });
  expectStatus(response, [201], `register ${name}`);
  const workerId = asRecord(response.json).id;
  expect(typeof workerId === "string", `Registered agent ${name} has no id`);
  return workerId;
}

/**
 * Flips the delegated-delivery flags on for the rest of this run (plan
 * section 3.4): `SLACK_RENDER_V2` + `SLACK_RENDER_V2_DELEGATION` via the
 * config API, the same path an operator uses from the dashboard, and a short
 * settle window so a closure's deferred conclusion lands well inside a
 * scenario's poll timeouts. Global config, not per-scenario — call this only
 * from scenarios that run last, after any legacy-renderer coverage.
 */
export async function enableSlackDelegation(ctx: ScenarioContext): Promise<void> {
  for (const [key, value] of [
    ["SLACK_RENDER_V2", "true"],
    ["SLACK_RENDER_V2_DELEGATION", "true"],
    ["SLACK_CONCLUSION_SETTLE_SEC", "2"],
  ] as const) {
    expectStatus(
      await ctx.api("PUT", "/api/config", {
        body: { scope: "global", scopeId: null, key, value, isSecret: false },
      }),
      [200],
      `enable ${key} for delegation e2e`,
    );
  }
  // The config auto-reload that flips process.env is debounced ~250ms;
  // confirm the watcher actually saw it (recorded as delegation_activated_at)
  // before any scenario creates the tasks that depend on it.
  const activated = await pollUntil(() => {
    const row = ctx.db.get<{ delegation_activated_at: string | null }>(
      "SELECT delegation_activated_at FROM slack_render_v2_state WHERE id = 1",
    );
    return row?.delegation_activated_at != null;
  }, 15_000);
  expect(activated, "Slack render v2 delegation never activated within 15 seconds");
}

/**
 * A non-lead agent finishing a task auto-spawns a "worker task follow-up"
 * review task for the lead (`createWorkerTaskFollowUp` in
 * `src/tasks/worker-follow-up.ts`) — unrelated to Slack delegation, it fires
 * for any worker completion. That follow-up inherits the child's Slack
 * thread and is itself a member of the ask's closure (`buildAskClosure` only
 * excludes `source === "slack"` members), so it must also go terminal before
 * the ask's conclusion can settle. Call this after finishing a delegated
 * child so the closure isn't left open forever.
 */
export async function settleWorkerFollowUp(
  ctx: ScenarioContext,
  leadId: string,
  childTaskId: string,
): Promise<void> {
  let followUpId: string | undefined;
  const found = await pollUntil(async () => {
    const response = await ctx.api("GET", `/api/tasks?agentId=${leadId}&fields=full&limit=50`);
    expectStatus(response, [200], `list lead tasks while resolving follow-up for ${childTaskId}`);
    const tasks = asRecord(response.json).tasks;
    expect(Array.isArray(tasks), `Task list for lead ${leadId} has no tasks array`);
    const match = tasks
      .map(asRecord)
      .find((row) => row.parentTaskId === childTaskId && row.taskType === "follow-up");
    if (match) followUpId = String(match.id);
    return followUpId !== undefined;
  }, 15_000);
  expect(
    found && followUpId,
    `No worker-completion follow-up for child ${childTaskId} within 15 seconds`,
  );
  await claim(ctx, leadId, followUpId as string);
  await finish(ctx, leadId, followUpId as string, {
    status: "completed",
    output: "Reviewed the delegated result — looks good.",
  });
}

/** Creates a delegated child task under `parentTaskId`, inheriting the parent's Slack thread. */
export async function createChildTask(
  ctx: ScenarioContext,
  parentTaskId: string,
  workerId: string,
  task: string,
): Promise<string> {
  const response = await ctx.api("POST", "/api/tasks", {
    body: { task, agentId: workerId, parentTaskId, source: "api" },
  });
  expectStatus(response, [201], `create delegated child under ${parentTaskId}`);
  const childId = asRecord(response.json).id;
  expect(typeof childId === "string", `Delegated child under ${parentTaskId} has no id`);
  return String(childId);
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
