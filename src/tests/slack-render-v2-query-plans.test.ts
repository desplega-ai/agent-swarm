import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getDbClient,
  getResolvableDeferralOutcomes,
  initDb,
  recordSlackMessage,
} from "../be/db";
import { getSlackTasksMissingTree } from "../be/db/tasks/read";
import { completeTask, startTask } from "../be/db/tasks/write";

// Both queries run on every Slack watcher tick. The DB has no sqlite_stat1, so
// the planner works from heuristics; these pin the plans that keep each tick
// proportional to Slack rows instead of every task.

async function capturedSql(run: () => Promise<unknown>): Promise<string> {
  const client = getDbClient();
  const seen: string[] = [];
  const original = client.query.bind(client);
  const spy = spyOn(client, "query").mockImplementation(((sql: string, params?: unknown[]) => {
    seen.push(sql);
    return original(sql, params);
  }) as typeof client.query);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

function plan(sql: string, params: unknown[] = []): string {
  return getDb()
    .query<{ detail: string }, any[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join("\n");
}

async function deferredAsk(label: string, leadId: string) {
  const ask = await createTaskExtended(`ask ${label}`, {
    agentId: leadId,
    source: "slack",
    slackChannelId: `C_${label}`,
    slackThreadTs: `${label}.0`,
  });
  await startTask(ask.id);
  await completeTask(ask.id, "Checking back later", {
    addTags: ["deferred"],
    deferredAt: new Date().toISOString(),
  });
  const card = await recordSlackMessage({
    contextKey: `slack:C_${label}:${label}.0`,
    channelId: `C_${label}`,
    threadTs: `${label}.0`,
    ts: `${label}.1`,
    kind: "outcome",
    taskId: ask.id,
    finalized: true,
  });
  return { ask, card };
}

async function wake(parentTaskId: string, leadId: string, opts: { deferAgain?: boolean } = {}) {
  await Bun.sleep(2);
  const task = await createTaskExtended("wake", {
    agentId: leadId,
    parentTaskId,
    taskType: "deferred",
  });
  await startTask(task.id);
  await completeTask(
    task.id,
    "done",
    opts.deferAgain ? { deferredAt: new Date().toISOString() } : {},
  );
  return task;
}

describe("slack render-v2 watcher queries", () => {
  beforeEach(() => {
    initDb(":memory:");
    getDb().run(
      "INSERT OR IGNORE INTO slack_render_v2_state (id, activated_at) VALUES (1, '2000-01-01T00:00:00.000Z')",
    );
  });

  afterEach(() => {
    closeDb();
  });

  test("deferral resolution drives from the chain, not from every task", async () => {
    const sql = await capturedSql(() => getResolvableDeferralOutcomes());
    const detail = plan(sql, [50]);
    // Either parentTaskId-led index is a seek on the chain's children.
    expect(detail).toMatch(
      /SEARCH wake USING INDEX idx_agent_tasks_parentTaskId(_source)? \(parentTaskId=\?\)/,
    );
    expect(detail).not.toContain("idx_agent_tasks_taskType");
    expect(detail).not.toContain("idx_agent_tasks_status_last_updated");
  });

  test("missing-tree scan reads only Slack tasks", async () => {
    const sql = await capturedSql(() => getSlackTasksMissingTree());
    const detail = plan(sql);
    expect(detail).toContain("SCAN task USING INDEX idx_agent_tasks_slack_last_updated");
    expect(detail).not.toContain("idx_agent_tasks_last_updated");
  });

  test("deferral resolution returns the latest terminal wake of each open chain", async () => {
    const lead = await createAgent({ name: "Plan Lead", isLead: true, status: "idle" });

    const single = await deferredAsk("SINGLE", lead.id);
    const singleWake = await wake(single.ask.id, lead.id);

    const chained = await deferredAsk("CHAIN", lead.id);
    const firstWake = await wake(chained.ask.id, lead.id, { deferAgain: true });
    const lastWake = await wake(firstWake.id, lead.id);

    const pending = await deferredAsk("PENDING", lead.id);
    const running = await createTaskExtended("still running", {
      agentId: lead.id,
      parentTaskId: pending.ask.id,
      taskType: "deferred",
    });
    await startTask(running.id);

    const plainChild = await deferredAsk("PLAIN", lead.id);
    const notDeferred = await createTaskExtended("ordinary child", {
      agentId: lead.id,
      parentTaskId: plainChild.ask.id,
    });
    await startTask(notDeferred.id);
    await completeTask(notDeferred.id, "done");

    const rows = await getResolvableDeferralOutcomes();
    expect(rows.map((row) => [row.card.id, row.deferredTaskId, row.wakeTaskId]).sort()).toEqual(
      [
        [single.card.id, single.ask.id, singleWake.id],
        [chained.card.id, chained.ask.id, lastWake.id],
      ].sort(),
    );
  });
});
