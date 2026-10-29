import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  ask,
  claim,
  enableSlackRenderV2Only,
  findSlackTask,
  registerLead,
  waitForBotReply,
  waitForEyes,
  waitForReaction,
} from "./slack-helpers";

const skippedKey = "SLACK_REACTION_SKIPPED";

async function setSkippedReaction(ctx: ScenarioContext, value: string): Promise<string> {
  const upsert = await ctx.api("PUT", "/api/config", {
    body: { scope: "global", scopeId: null, key: skippedKey, value, isSecret: false },
  });
  expectStatus(upsert, [200], `configure ${skippedKey}`);
  const configId = asRecord(upsert.json).id;
  expect(typeof configId === "string", `Config upsert for ${skippedKey} has no id`);
  await waitForSkippedKeyPresence(ctx, true);
  return configId;
}

/**
 * A global config write reloads process.env on a ~250ms debounce. Wait until
 * the override is live (or gone again) before driving a message through it.
 */
async function waitForSkippedKeyPresence(ctx: ScenarioContext, present: boolean): Promise<void> {
  const settled = await pollUntil(async () => {
    const response = await ctx.api("GET", `/api/config/env-presence?keys=${skippedKey}`);
    expectStatus(response, [200], `check ${skippedKey} presence`);
    const presence = asRecord(response.json).presence as Record<string, boolean> | undefined;
    return presence?.[skippedKey] === present;
  }, 10_000);
  expect(
    settled,
    `${skippedKey} presence in process.env never became ${present} within 10 seconds`,
  );
}

type Renderer = "legacy" | "v2";

function threadReplies(ctx: ScenarioContext, threadTs: string) {
  return ctx.slack
    .messages("general")
    .filter((message) => message.thread_ts === threadTs && message.ts !== threadTs);
}

/** The v2 thread-tree status message: the bot reply whose text opens with 🧵. */
function treeOf(ctx: ScenarioContext, threadTs: string) {
  return threadReplies(ctx, threadTs).find((reply) => String(reply.text ?? "").startsWith("🧵"));
}

/**
 * One ask ended by MCP `store-progress status: "skipped"`. The trigger message
 * keeps exactly one reaction, the skip one; the thread gets no new message;
 * under render v2 the existing tree row is edited to the skip glyph + reason.
 * `renderer` is the caller's expectation, never inferred from the thread, so a
 * v2 run that silently falls back to legacy fails instead of skipping checks.
 */
async function skipOneAsk(
  ctx: ScenarioContext,
  renderer: Renderer,
  label: string,
  skipReaction: string,
  checkSilence: boolean,
): Promise<void> {
  await registerLead(ctx, `e2e-lead-skipped-${renderer}-${label}-${ctx.nonce}`);
  const message = await ask(ctx, `ping the ${label} channel owners ${ctx.nonce}`);
  ctx.markThread(`skipped-${renderer}-${label}`, "C0GENERAL0", message.ts);
  await waitForEyes(ctx, message.ts);
  // Legacy posts an assignment reply on acceptance; v2 posts the tree.
  await waitForBotReply(ctx, message.ts);
  let treeTs: string | undefined;
  if (renderer === "v2") {
    const posted = await pollUntil(() => treeOf(ctx, message.ts) !== undefined, 30_000);
    treeTs = treeOf(ctx, message.ts)?.ts;
    expect(posted && treeTs, `v2 never posted a 🧵 tree in C0GENERAL0 thread ${message.ts}`);
  }

  const task = await findSlackTask(ctx, message.ts);
  const taskId = String(task.id);
  const leadId = String(task.agentId);
  await claim(ctx, leadId, taskId);

  const repliesBefore = new Set(threadReplies(ctx, message.ts).map((reply) => reply.ts));
  const reason = `Addressed to the ${label} owners, not to me.`;
  const mcp = await ctx.connectMcp(leadId);
  try {
    const result = await mcp.callTool("store-progress", {
      taskId,
      status: "skipped",
      failureReason: reason,
    });
    expect(!result.isError, `store-progress skipped (${label}): ${JSON.stringify(result)}`);
  } finally {
    await mcp.close();
  }

  const row = ctx.db.get<{ status: string; failureReason: string | null; output: string | null }>(
    "SELECT status, failureReason, output FROM agent_tasks WHERE id = ?",
    [taskId],
  );
  expect(row?.status === "skipped", `${label} task ${taskId} is ${row?.status}, not skipped`);
  expect(
    row.failureReason === reason,
    `${label} task ${taskId} failureReason is ${JSON.stringify(row.failureReason)}`,
  );
  expect(!row.output, `${label} task ${taskId} stored output ${JSON.stringify(row.output)}`);

  await waitForReaction(ctx, message.ts, skipReaction);
  // Acceptance (eyes or its override) is removed and no completed/failed
  // reaction is added: the skip reaction is the only one left.
  const onlySkip = await pollUntil(() => {
    const names = (
      ctx.slack.messages("general").find((candidate) => candidate.ts === message.ts)?.reactions ??
      []
    ).map((reaction) => reaction.name);
    return names.length === 1 && names[0] === skipReaction;
  }, 30_000);
  const finalNames = (
    ctx.slack.messages("general").find((candidate) => candidate.ts === message.ts)?.reactions ?? []
  ).map((reaction) => reaction.name);
  expect(
    onlySkip,
    `${label} trigger ${message.ts} should carry only ${skipReaction}, got: ${finalNames.join(", ")}`,
  );

  if (renderer === "v2") {
    // The tree is edited in place (silent) to show the skip and its reason.
    const edited = await pollUntil(() => {
      const tree = JSON.stringify(
        ctx.slack.messages("general").find((candidate) => candidate.ts === treeTs),
      );
      return tree.includes(`:${skipReaction}:`) && tree.includes(reason);
    }, 30_000);
    expect(edited, `v2 tree ${treeTs} never showed :${skipReaction}: with "${reason}"`);
  } else {
    const tree = treeOf(ctx, message.ts);
    expect(!tree, `legacy run posted a v2 🧵 tree ${tree?.ts} in thread ${message.ts}`);
  }

  if (!checkSilence) return;
  // Calibrated like waitForOutcomeAbsence: 30s covers both an immediate
  // legacy relay and the v2 watcher's tick, so absence is a real assertion.
  const posted = await pollUntil(
    () => threadReplies(ctx, message.ts).some((reply) => !repliesBefore.has(reply.ts)),
    30_000,
  );
  const extra = threadReplies(ctx, message.ts).filter((reply) => !repliesBefore.has(reply.ts));
  expect(
    !posted,
    `Skipped ${label} task posted into thread ${message.ts}: ${JSON.stringify(extra.map((reply) => reply.text))}`,
  );
}

async function skipAndCheckSlack(ctx: ScenarioContext, renderer: Renderer): Promise<void> {
  await skipOneAsk(ctx, renderer, "default", "mute", true);

  const configured = "see_no_evil";
  const configId = await setSkippedReaction(ctx, configured);
  try {
    await skipOneAsk(ctx, renderer, "override", configured, false);
  } finally {
    expectStatus(
      await ctx.api("DELETE", `/api/config/${configId}`),
      [200],
      `delete config ${configId}`,
    );
    // Later scenarios expect the code-default reaction names.
    await waitForSkippedKeyPresence(ctx, false);
  }
}

// registry.ts discovers both exports. Legacy must precede the scenarios that enable v2;
// v2 must precede the scenarios that enable delegation globally.
export const slackSkippedTaskLegacy: Scenario = {
  name: "slack-skipped-task-legacy",
  order: 115,
  groups: ["visuals-legacy"],
  run: (ctx) => skipAndCheckSlack(ctx, "legacy"),
};

export const slackSkippedTaskV2: Scenario = {
  name: "slack-skipped-task-v2",
  order: 139,
  groups: ["visuals-v2"],
  async run(ctx) {
    await enableSlackRenderV2Only(ctx);
    await skipAndCheckSlack(ctx, "v2");
  },
};
