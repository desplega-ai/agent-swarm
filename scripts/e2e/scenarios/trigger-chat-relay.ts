// Trigger group: Slack and chat relay obligations, Slack thread-tree reopen.
// Covers:
//   enqueue_chat_relay_after_terminal_update (a chat-sdk task that ends owes its thread a reply),
//   drop_chat_relay_on_defer (a deferred chat-sdk task owes nothing until its wake-up ends),
//   enqueue_slack_relay_after_terminal_update (a Slack task that ends owes its thread a reply),
//   reopen_slack_tree_after_task_insert (a new task in a closed thread reopens its tree).
// Unreachable:
//   enqueue_chat_relay_after_terminal_insert, enqueue_slack_relay_after_terminal_insert: no API
//     inserts a task that is already terminal.
//   reopen_slack_tree_after_task_update: a closed tree's tasks are all terminal, and no API
//     writes a terminal task's status or lastUpdatedAt again.
//   reopen_slack_tree_after_outcome_insert, reopen_slack_tree_after_outcome_update: an outcome
//     card is written only for a task in the thread, whose insert has already reopened the tree.
import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

const TERMINAL = ["completed", "failed", "cancelled", "superseded", "skipped"];

function chatObligation(ctx: ScenarioContext, taskId: string) {
  return ctx.db.get<{ task_id: string }>(
    sql`SELECT task_id FROM chat_relay_obligations WHERE task_id = ${taskId}`,
  );
}

function slackObligation(ctx: ScenarioContext, taskId: string) {
  return ctx.db.get<{ task_id: string }>(
    sql`SELECT task_id FROM slack_relay_obligations WHERE task_id = ${taskId}`,
  );
}

function tree(ctx: ScenarioContext, threadTs: string) {
  return ctx.db.get<{ id: string; closed_at: string | null }>(
    sql`SELECT id, closed_at FROM slack_messages WHERE kind = 'tree' AND thread_ts = ${threadTs}`,
  );
}

async function registerAgent(
  ctx: ScenarioContext,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await ctx.api("POST", "/api/agents", {
    body: { name, role: "worker", status: "online", ...extra },
  });
  expectStatus(response, [201], `register ${name}`);
  return asString(asRecord(response.json).id, `${name} id`);
}

async function claimNext(ctx: ScenarioContext, agentId: string, taskId: string): Promise<void> {
  const claimed = await pollUntil(async () => {
    await ctx.api("GET", "/api/poll", { agentId });
    const read = await ctx.api("GET", `/api/tasks/${taskId}`);
    return asRecord(read.json).status === "in_progress";
  }, 15_000);
  expect(claimed, `${agentId} never claimed ${taskId}`);
}

async function finish(ctx: ScenarioContext, agentId: string, taskId: string, output: string) {
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/finish`, {
      agentId,
      body: { status: "completed", output },
    }),
    [200],
    `finish ${taskId}`,
  );
}

/** Chat SDK obligations, created from the task API with a chat-sdk context key. */
async function chatRelay(ctx: ScenarioContext): Promise<void> {
  const workerId = await registerAgent(ctx, `trg-relay-chat-${ctx.nonce}`);
  const create = async (label: string, extra: Record<string, unknown>) => {
    const response = await ctx.api("POST", "/api/tasks", {
      body: {
        task: `chat relay ${label} ${ctx.nonce}`,
        agentId: workerId,
        routingReason: "human_pinned",
        ...extra,
      },
    });
    expectStatus(response, [201], `create the ${label} task`);
    return asString(asRecord(response.json).id, `${label} id`);
  };
  const contextKey = (label: string) => `task:chat-sdk:telegram:trg-${label}-${ctx.nonce}`;
  try {
    // A chat task that completes owes a relay; an api task with the same key, or a chat task
    // with another key shape, does not.
    const cases = [
      ["chat", { source: "chat", contextKey: contextKey("chat") }, true],
      ["api", { source: "api", contextKey: contextKey("api") }, false],
      ["other-key", { source: "chat", contextKey: `task:other:trg-${ctx.nonce}` }, false],
    ] as const;
    for (const [label, extra, owed] of cases) {
      const taskId = await create(label, extra);
      expect(!chatObligation(ctx, taskId), `an open ${label} task owes no relay`);
      await claimNext(ctx, workerId, taskId);
      await finish(ctx, workerId, taskId, `chat relay output ${label} ${ctx.nonce}`);
      expect(
        Boolean(chatObligation(ctx, taskId)) === owed,
        `a completed ${label} task ${owed ? "owes" : "does not owe"} a chat relay`,
      );
    }

    // Deferring ends the task but owes nothing: the wake-up task carries the reply.
    const deferredId = await create("deferred", {
      source: "chat",
      contextKey: contextKey("defer"),
    });
    await claimNext(ctx, workerId, deferredId);
    const conn = await ctx.connectMcp(workerId);
    try {
      const result = asRecord(
        await conn.callTool("defer-task", {
          taskId: deferredId,
          delayMs: 3_600_000,
          summary: `waiting an hour ${ctx.nonce}`,
          note: "Check the thread again after the wait.",
        }),
      );
      expect(result.isError !== true, `defer-task failed: ${JSON.stringify(result.content)}`);
    } finally {
      await conn.close();
    }
    const deferred = ctx.db.get<{ status: string; deferredAt: string | null }>(
      sql`SELECT status, "deferredAt" FROM agent_tasks WHERE id = ${deferredId}`,
    );
    expect(
      deferred !== null && TERMINAL.includes(deferred.status) && deferred.deferredAt !== null,
      `the deferred task ended with a deferral mark: ${JSON.stringify(deferred)}`,
    );
    expect(!chatObligation(ctx, deferredId), "a deferred chat task owes no relay");
  } finally {
    await ctx.api("POST", "/close", { agentId: workerId, body: {} });
  }
}

/** SLACK_RENDER_V2 keeps one thread-tree row per Slack thread; set it the operator's way. */
async function ensureRenderV2(ctx: ScenarioContext): Promise<void> {
  const response = await ctx.api("GET", "/api/config?scope=global");
  expectStatus(response, [200], "list global config");
  const on = asRecords(response.json, "configs").some(
    (config) => config.key === "SLACK_RENDER_V2" && config.value === "true",
  );
  if (!on) {
    expectStatus(
      await ctx.api("PUT", "/api/config", {
        body: { scope: "global", scopeId: null, key: "SLACK_RENDER_V2", value: "true" },
      }),
      [200],
      "turn on SLACK_RENDER_V2",
    );
    await ctx.restartSut();
  }
  await ctx.slack.waitForConnection(60_000);
}

async function findSlackTask(ctx: ScenarioContext, ts: string, exclude: string[] = []) {
  let found: Record<string, unknown> | undefined;
  const ok = await pollUntil(async () => {
    const response = await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=50");
    expectStatus(response, [200], "list Slack tasks");
    found = asRecords(response.json, "tasks").find(
      (row) =>
        (row.slackTriggerMessageTs === ts || row.slackThreadTs === ts) &&
        !exclude.includes(String(row.id)),
    );
    return found !== undefined;
  }, 30_000);
  expect(ok && found, `no Slack task for ts ${ts}`);
  return found;
}

/** Slack obligations and the thread tree, through the Slack mock. */
async function slackRelay(ctx: ScenarioContext): Promise<void> {
  await ensureRenderV2(ctx);
  // The mention routes to the first lead by name that is not offline. Earlier scenarios
  // leave idle "00-core-lead-*" leads with backlog behind, so this lead must sort before
  // them and register as idle, or the mention lands on a lead that cannot claim it.
  const leadResponse = await ctx.api("POST", "/api/agents", {
    body: { name: `00-00-trg-relay-lead-${ctx.nonce}`, isLead: true, status: "idle" },
  });
  expectStatus(leadResponse, [201], "register a lead");
  const leadId = asString(asRecord(leadResponse.json).id, "lead id");
  try {
    const message = await ctx.slack.postMessage({
      channel: "general",
      user: "alice",
      text: `<@${ctx.slack.bot.userId}> trigger relay ${ctx.nonce}`,
    });
    const first = await findSlackTask(ctx, message.ts);
    const firstId = String(first.id);
    const owner = typeof first.agentId === "string" ? first.agentId : leadId;
    expect(
      owner === leadId,
      `the mention routed to lead ${owner}, not this scenario's lead ${leadId}`,
    );
    expect(!slackObligation(ctx, firstId), "an open Slack task owes no relay");
    await claimNext(ctx, owner, firstId);
    await finish(ctx, owner, firstId, `slack relay output ${ctx.nonce}`);
    expect(slackObligation(ctx, firstId), "a completed Slack task owes its thread a relay");

    const closed = await pollUntil(() => {
      const row = tree(ctx, message.ts);
      return row !== null && row.closed_at !== null;
    }, 60_000);
    expect(closed, `the thread tree never closed: ${JSON.stringify(tree(ctx, message.ts))}`);
    const treeId = tree(ctx, message.ts)?.id;

    await ctx.slack.postMessage({
      channel: "general",
      user: "alice",
      thread_ts: message.ts,
      text: `<@${ctx.slack.bot.userId}> one more thing ${ctx.nonce}`,
    });
    const second = await findSlackTask(ctx, message.ts, [firstId]);
    const secondId = String(second.id);
    const reopened = tree(ctx, message.ts);
    expect(
      reopened !== null && reopened.id === treeId && reopened.closed_at === null,
      `a new task in the thread reopens the same tree: ${JSON.stringify(reopened)}`,
    );
    await ctx.api("POST", `/api/tasks/${secondId}/cancel`, { body: { reason: "trigger cleanup" } });
  } finally {
    await ctx.api("POST", "/close", { agentId: leadId, body: {} });
  }
}

export const triggerChatRelay: Scenario = {
  name: "trigger-chat-relay",
  order: 9_350,
  async run(ctx) {
    await chatRelay(ctx);
    await slackRelay(ctx);
  },
};
