import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getDbClient,
  getResolvableDeferralOutcomes,
  getSlackTreeMessages,
  initDb,
  moveTaskFromBacklog,
  recordSlackMessage,
  updateSlackMessageRecord,
} from "../be/db";
import {
  closeSlackTreeIfSettled,
  getSlackProcessingThreads,
  SLACK_RECONCILE_PAGE_SIZE,
} from "../be/db/slack-trees";
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

  test("the tree sweep tests thread tasks in the covering index, not task rows", async () => {
    const sql = await capturedSql(() => getSlackTreeMessages());
    const detail = plan(sql);
    const uses = "SEARCH task USING COVERING INDEX idx_agent_tasks_slack_thread_cover";
    expect(detail.split(uses).length - 1).toBe(3);
    // Control: without migration 264 the same tests read the task rows.
    const copy = Database.deserialize(getDb().serialize());
    try {
      copy.run("DROP INDEX idx_agent_tasks_slack_thread_cover");
      const reverted = copy
        .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => row.detail)
        .join("\n");
      expect(reverted).not.toContain(uses);
    } finally {
      copy.close();
    }
  });

  test("recovery pages old active work fairly, excludes backlog, and survives reopening the DB", async () => {
    const insert = getDb().query(`INSERT INTO agent_tasks
      (id, task, status, source, slackChannelId, slackThreadTs, createdAt, lastUpdatedAt)
      VALUES (?, 'old ask', ?, 'slack', 'C_PAGED', ?, '2001-01-01', '2001-01-01')`);
    getDb()
      .transaction(() => {
        for (let i = 0; i < 1001; i++) {
          insert.run(`active-${String(i).padStart(4, "0")}`, "in_progress", `active-${i}`);
          insert.run(`backlog-${i}`, "backlog", `backlog-${i}`);
          insert.run(`unassigned-${i}`, "unassigned", `unassigned-${i}`);
        }
      })
      .immediate();
    const seen = new Set<string>();
    for (let tick = 0; tick < 21; tick++) {
      const rows = await getSlackProcessingThreads(false);
      expect(rows.length).toBeLessThanOrEqual(SLACK_RECONCILE_PAGE_SIZE);
      for (const row of rows) {
        expect(row.threadTs.startsWith("active-")).toBe(true);
        expect(seen.has(row.threadTs)).toBe(false);
        seen.add(row.threadTs);
      }
      if (tick === 0) {
        const globals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
        const original = globals.__testMigrationTemplate;
        globals.__testMigrationTemplate = getDb().serialize();
        closeDb();
        try {
          initDb(":memory:");
        } finally {
          globals.__testMigrationTemplate = original;
        }
      }
    }
    expect(seen.size).toBe(1001);
    expect((await getSlackProcessingThreads(false))[0]?.threadTs).toBe("active-0");
  });

  test("each recovery source seeks its keyset before filtering a bounded page", async () => {
    const client = getDbClient();
    const original = client.query.bind(client);
    const seen: { sql: string; params: unknown[] }[] = [];
    const spy = spyOn(client, "query").mockImplementation(((sql: string, params?: unknown[]) => {
      seen.push({ sql, params: params ?? [] });
      return original(sql, params);
    }) as typeof client.query);
    try {
      await getSlackProcessingThreads(true, true);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(4);
    for (const { sql, params } of seen) {
      expect(sql).toContain("ORDER BY id LIMIT ?");
      expect(params[1]).toBe(SLACK_RECONCILE_PAGE_SIZE);
      expect(plan(sql, params)).toMatch(/SEARCH .* USING INDEX idx_slack_reconcile_.* \(id>\?\)/);
    }
  });

  test("settled terminal history advances the cursor without starving pending outcomes", async () => {
    const lead = await createAgent({ name: "history lead", isLead: true, status: "idle" });
    const old = await settledThread("SETTLED_PAGE", lead.id);
    // Clone finalized tasks; an existing shared settled card makes each ineligible.
    for (let i = 0; i < 105; i++) {
      const id = `history-${String(i).padStart(4, "0")}`;
      getDb().run(
        `INSERT INTO agent_tasks (id,task,status,source,slackChannelId,slackThreadTs,createdAt,lastUpdatedAt)
        VALUES (?, 'finished', 'completed', 'slack', 'C_HISTORY', ?, '2001-01-01', '2001-01-01')`,
        [id, id],
      );
      await recordSlackMessage({
        contextKey: `slack:C_HISTORY:${id}`,
        channelId: "C_HISTORY",
        threadTs: id,
        ts: id,
        kind: "outcome",
        taskId: id,
        finalized: true,
      });
    }
    getDb().run(`INSERT INTO agent_tasks (id,task,status,source,slackChannelId,slackThreadTs,createdAt,lastUpdatedAt)
      VALUES ('zz-pending', 'pending outcome', 'completed', 'slack', 'C_PENDING', 'pending', '2001-01-01', '2001-01-01')`);
    const found = [];
    for (let tick = 0; tick < 3; tick++) found.push(...(await getSlackProcessingThreads(false)));
    expect(found).toContainEqual({ channelId: "C_PENDING", threadTs: "pending" });
    expect(found.some((row) => row.channelId === "C_HISTORY")).toBe(false);
    expect(found.some((row) => row.threadTs === old.threadTs)).toBe(false);
  });

  test("deferral resolution drives from the chain, not from every task", async () => {
    const sql = await capturedSql(() => getResolvableDeferralOutcomes());
    const detail = plan(sql, [50]);
    // Any parentTaskId-led index is a seek on the chain's children.
    expect(detail).toMatch(
      /SEARCH wake USING INDEX idx_agent_tasks_parentTaskId(_source|_id)? \(parentTaskId=\?\)/,
    );
    expect(detail).not.toContain("idx_agent_tasks_taskType");
    // The NOT EXISTS seeks the wake's children, not every deferred-type task.
    expect(detail).toMatch(/SEARCH child USING (COVERING )?INDEX idx_agent_tasks_parentTaskId/);
    expect(detail).not.toContain("idx_agent_tasks_list_filter");
    // The anchor reads only tasks that ever deferred, then seeks their card.
    expect(detail).toContain("SCAN deferred USING INDEX idx_agent_tasks_deferred");
    expect(detail).toContain("SEARCH card USING INDEX idx_slack_messages_outcome_task (task_id=?)");
    expect(detail).not.toMatch(/SCAN card\b/);
    expect(detail).not.toContain("idx_agent_tasks_status_last_updated");
  });

  test("missing-tree scan reads only recently updated Slack tasks", async () => {
    const sql = await capturedSql(() => getSlackTasksMissingTree());
    const detail = plan(sql);
    expect(detail).toContain(
      "SEARCH task USING INDEX idx_agent_tasks_slack_last_updated (lastUpdatedAt>?)",
    );
    // The index order serves the ORDER BY too.
    expect(detail).not.toContain("USE TEMP B-TREE");
    expect(detail).not.toContain("idx_agent_tasks_last_updated ");
  });

  test("thread-scoped missing-tree query seeks the thread", async () => {
    const sql = await capturedSql(() =>
      getSlackTasksMissingTree({ thread: { channelId: "C_X", threadTs: "X.0" } }),
    );
    const detail = plan(sql, ["C_X", "X.0"]);
    expect(detail).toContain(
      "SEARCH task USING INDEX idx_agent_tasks_slack_thread_cover (slackChannelId=? AND slackThreadTs=?",
    );
    expect(detail).not.toContain("idx_agent_tasks_slack_last_updated");
  });

  test("missing-tree scan is bounded to the last 24 hours of updates", async () => {
    const lead = await createAgent({ name: "Window Lead", isLead: true, status: "idle" });
    const make = async (label: string, ageMs: number) => {
      const task = await createTaskExtended(`ask ${label}`, {
        agentId: lead.id,
        source: "slack",
        slackChannelId: `C_${label}`,
        slackThreadTs: `${label}.0`,
      });
      const at = new Date(Date.now() - ageMs).toISOString();
      getDb().run("UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?", [
        at,
        at,
        task.id,
      ]);
      return task;
    };
    const recent = await make("RECENT", 60 * 60 * 1000);
    const old = await make("OLD", 25 * 60 * 60 * 1000);

    const ids = (await getSlackTasksMissingTree()).map((task) => task.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);

    // The window is relative to `now`: two days later neither is in it.
    const later = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(await getSlackTasksMissingTree({ now: later })).toEqual([]);

    // Thread scope narrows to one thread and has no window.
    const scoped = await getSlackTasksMissingTree({
      thread: { channelId: "C_RECENT", threadTs: "RECENT.0" },
    });
    expect(scoped.map((task) => task.id)).toEqual([recent.id]);
    const oldScoped = await getSlackTasksMissingTree({
      thread: { channelId: "C_OLD", threadTs: "OLD.0" },
    });
    expect(oldScoped.map((task) => task.id)).toEqual([old.id]);
  });

  test("a Slack task assigned after 24 h in backlog still gets a tree", async () => {
    const lead = await createAgent({ name: "Backlog Lead", isLead: true, status: "idle" });
    const task = await createTaskExtended("ask BACKLOG", {
      source: "slack",
      slackChannelId: "C_BACKLOG",
      slackThreadTs: "BACKLOG.0",
    });
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    getDb().run(
      "UPDATE agent_tasks SET status = 'backlog', agentId = NULL, createdAt = ?, lastUpdatedAt = ? WHERE id = ?",
      [threeDaysAgo, threeDaysAgo, task.id],
    );
    // In backlog: no tree yet, by design.
    expect((await getSlackTasksMissingTree()).map((t) => t.id)).not.toContain(task.id);

    // Released and claimed: the status change bumps lastUpdatedAt.
    expect(await moveTaskFromBacklog(task.id)).not.toBeNull();
    expect(await claimTask(task.id, lead.id)).not.toBeNull();

    expect((await getSlackTasksMissingTree()).map((t) => t.id)).toContain(task.id);
    const scoped = await getSlackTasksMissingTree({
      thread: { channelId: "C_BACKLOG", threadTs: "BACKLOG.0" },
    });
    expect(scoped.map((t) => t.id)).toEqual([task.id]);
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

async function settledThread(label: string, leadId: string) {
  const channelId = `C_${label}`;
  const threadTs = `${label}.0`;
  const ask = await createTaskExtended(`ask ${label}`, {
    agentId: leadId,
    source: "slack",
    slackChannelId: channelId,
    slackThreadTs: threadTs,
  });
  await startTask(ask.id);
  await completeTask(ask.id, "done");
  const card = await recordSlackMessage({
    contextKey: `slack:${channelId}:${threadTs}`,
    channelId,
    threadTs,
    ts: `${label}.2`,
    kind: "outcome",
    taskId: ask.id,
    finalized: true,
  });
  await Bun.sleep(2);
  const tree = await recordSlackMessage({
    contextKey: `slack:${channelId}:${threadTs}`,
    channelId,
    threadTs,
    ts: `${label}.1`,
    kind: "tree",
  });
  return { ask, card, tree, channelId, threadTs };
}

function closedAt(id: string): string | null {
  return (
    getDb()
      .query<{ closed_at: string | null }, [string]>(
        "SELECT closed_at FROM slack_messages WHERE id = ?",
      )
      .get(id)?.closed_at ?? null
  );
}

/** Tree ids in the sweep's candidate set (idx_slack_messages_open_trees). */
function openTreeIds(): string[] {
  return getDb()
    .query<{ id: string }, []>(
      "SELECT id FROM slack_messages WHERE kind = 'tree' AND closed_at IS NULL",
    )
    .all()
    .map((row) => row.id);
}

describe("slack render-v2 tree closed_at", () => {
  let leadId: string;

  beforeEach(async () => {
    initDb(":memory:");
    getDb().run(
      "INSERT OR IGNORE INTO slack_render_v2_state (id, activated_at) VALUES (1, '2000-01-01T00:00:00.000Z')",
    );
    leadId = (await createAgent({ name: "Close Lead", isLead: true, status: "idle" })).id;
  });

  afterEach(() => {
    closeDb();
  });

  test("the sweep reads only open trees through the partial index", async () => {
    const sql = await capturedSql(() => getSlackTreeMessages());
    expect(plan(sql)).toContain("SCAN tree USING INDEX idx_slack_messages_open_trees");
  });

  test("a settled thread closes and drops out of the sweep", async () => {
    const { tree } = await settledThread("SETTLED", leadId);
    // Before close: the tree is open, so the sweep's partial index still
    // visits it. The sweep returns nothing only because the needs-render
    // predicate finds no work in a settled thread.
    expect(openTreeIds()).toContain(tree.id);
    expect(await getSlackTreeMessages()).toEqual([]);
    expect(await closeSlackTreeIfSettled(tree.id)).toBe(true);
    // After close: the tree leaves the open-tree index the sweep scans.
    expect(closedAt(tree.id)).not.toBeNull();
    expect(openTreeIds()).not.toContain(tree.id);
    expect(await getSlackTreeMessages()).toEqual([]);
    // Closing twice is a no-op.
    expect(await closeSlackTreeIfSettled(tree.id)).toBe(false);
  });

  test("a thread with a running task does not close", async () => {
    const { tree, channelId, threadTs } = await settledThread("RUNNING", leadId);
    const follow = await createTaskExtended("follow-up", {
      agentId: leadId,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
    });
    await startTask(follow.id);
    expect(await closeSlackTreeIfSettled(tree.id)).toBe(false);
    expect(closedAt(tree.id)).toBeNull();
    expect((await getSlackTreeMessages()).map((row) => row.id)).toEqual([tree.id]);
  });

  test("a new task in a closed thread reopens it", async () => {
    const { tree, channelId, threadTs } = await settledThread("REOPEN", leadId);
    expect(await closeSlackTreeIfSettled(tree.id)).toBe(true);

    await createTaskExtended("new ask in the same thread", {
      agentId: leadId,
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
    });
    expect(closedAt(tree.id)).toBeNull();
    expect((await getSlackTreeMessages()).map((row) => row.id)).toEqual([tree.id]);
    expect(
      (await getSlackTreeMessages({ thread: { channelId, threadTs } })).map((row) => row.id),
    ).toEqual([tree.id]);
  });

  test("a status change in a closed thread reopens it", async () => {
    const { ask, tree } = await settledThread("STATUS", leadId);
    expect(await closeSlackTreeIfSettled(tree.id)).toBe(true);
    getDb().run("UPDATE agent_tasks SET status = 'failed' WHERE id = ?", [ask.id]);
    expect(closedAt(tree.id)).toBeNull();
  });

  test("an outcome card write in a closed thread reopens it", async () => {
    const { card, tree } = await settledThread("CARD", leadId);
    expect(await closeSlackTreeIfSettled(tree.id)).toBe(true);
    await Bun.sleep(2);
    await updateSlackMessageRecord(card.id, { touchUpdatedAt: true });
    expect(closedAt(tree.id)).toBeNull();
    // The touched card is newer than the tree, so the sweep picks it up again.
    expect((await getSlackTreeMessages()).map((row) => row.id)).toEqual([tree.id]);
  });

  test("a task write in another thread leaves a closed tree closed", async () => {
    const { tree } = await settledThread("QUIET", leadId);
    expect(await closeSlackTreeIfSettled(tree.id)).toBe(true);
    await settledThread("OTHER", leadId);
    expect(closedAt(tree.id)).not.toBeNull();
  });

  test("migration 278 backfill closes settled trees and keeps open ones open", async () => {
    const settled = await settledThread("BF_SETTLED", leadId);
    const open = await settledThread("BF_OPEN", leadId);
    const running = await createTaskExtended("running", {
      agentId: leadId,
      source: "slack",
      slackChannelId: open.channelId,
      slackThreadTs: open.threadTs,
    });
    await startTask(running.id);

    const migration = await Bun.file(
      join(import.meta.dir, "../be/migrations/278_slack_render_v2_reconcile.sql"),
    ).text();
    const backfill = migration.slice(
      migration.indexOf("UPDATE slack_messages AS tree"),
      migration.indexOf(";", migration.indexOf("UPDATE slack_messages AS tree")),
    );
    getDb().run(backfill);

    expect(closedAt(settled.tree.id)).not.toBeNull();
    expect(closedAt(open.tree.id)).toBeNull();
  });
});
