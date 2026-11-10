import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getDbClient,
  getSlackTreeMessageByThread,
  initDb,
} from "../be/db";
import { startTask } from "../be/db/tasks/write";
import { workflowEventBus } from "../workflows/event-bus";

let messageCounter = 0;
const mockApiCall = async (method: string, payload: Record<string, unknown> = {}) => {
  messageCounter++;
  return {
    ok: true,
    ts: `${messageCounter}.000100`,
    channel: payload.channel,
    permalink: `https://slack.example/p${messageCounter}`,
    messages: [],
    method,
  };
};

mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: {
      apiCall: mockApiCall,
      chat: {
        postMessage: (payload: Record<string, unknown>) => mockApiCall("chat.postMessage", payload),
      },
      reactions: {
        add: (payload: Record<string, unknown>) => mockApiCall("reactions.add", payload),
        remove: (payload: Record<string, unknown>) => mockApiCall("reactions.remove", payload),
      },
    },
  }),
}));

const {
  _resetSlackRenderV2ForTests,
  flushSlackRenderV2DirtyThreads,
  processSlackRenderV2,
  startSlackRenderV2Events,
} = await import("../slack/render-v2");
const { DEFAULT_SLACK_TASK_WATCHER_INTERVAL_MS, slackTaskWatcherIntervalMs } = await import(
  "../slack/watcher"
);

type Captured = { sql: string; params: unknown[] };

function captureQueries(): { seen: Captured[]; restore: () => void } {
  const client = getDbClient();
  const seen: Captured[] = [];
  const original = client.query.bind(client);
  const spy = spyOn(client, "query").mockImplementation(((sql: string, params?: unknown[]) => {
    seen.push({ sql, params: params ?? [] });
    return original(sql, params);
  }) as typeof client.query);
  return { seen, restore: () => spy.mockRestore() };
}

const isTreeSweep = (q: Captured) => q.sql.includes("INDEXED BY idx_slack_reconcile_tree");

let leadId: string;

async function runningThread(label: string) {
  const channelId = `C_${label}`;
  const threadTs = `${label}.0`;
  const task = await createTaskExtended(`ask ${label}`, {
    agentId: leadId,
    source: "slack",
    slackChannelId: channelId,
    slackThreadTs: threadTs,
  });
  await startTask(task.id);
  return { task, channelId, threadTs };
}

beforeEach(async () => {
  initDb(":memory:");
  getDb().run(
    "INSERT OR IGNORE INTO slack_render_v2_state (id, activated_at) VALUES (1, '2000-01-01T00:00:00.000Z')",
  );
  process.env.SLACK_RENDER_V2 = "true";
  process.env.SLACK_RENDER_V2_DELEGATION = "false";
  _resetSlackRenderV2ForTests();
  leadId = (await createAgent({ name: "Reconcile Lead", isLead: true, status: "idle" })).id;
});

afterEach(() => {
  _resetSlackRenderV2ForTests();
  closeDb();
});

describe("slack render-v2 reconcile scheduling", () => {
  test("two overlapping reconcile passes run the sweep once", async () => {
    await runningThread("OVERLAP");
    const { seen, restore } = captureQueries();
    try {
      await Promise.all([processSlackRenderV2(), processSlackRenderV2()]);
    } finally {
      restore();
    }
    expect(seen.filter(isTreeSweep)).toHaveLength(1);
  });

  test("a full tick visits bounded pages of old work and preserves queued events outside its page", async () => {
    const prior = process.env.SLACK_RENDER_V2_TASK_TREE_ENABLED;
    process.env.SLACK_RENDER_V2_TASK_TREE_ENABLED = "false";
    try {
      const insert = getDb().query(`INSERT INTO agent_tasks
        (id,task,status,source,slackChannelId,slackThreadTs,createdAt,lastUpdatedAt)
        VALUES (?, 'old work', ?, 'slack', ?, 'thread', '2001-01-01', '2001-01-01')`);
      getDb()
        .transaction(() => {
          for (let i = 0; i < 1001; i++) {
            const id = String(i).padStart(5, "0");
            insert.run(id, "in_progress", `C_BATCH_${id}`);
            insert.run(`backlog-${id}`, "backlog", `C_BACKLOG_${id}`);
          }
        })
        .immediate();
      const target = await runningThread("QUEUED_OUTSIDE_PAGE");
      startSlackRenderV2Events();
      workflowEventBus.emit("task.progress", { taskId: target.task.id, progress: "queued" });
      const full = captureQueries();
      try {
        await processSlackRenderV2();
      } finally {
        full.restore();
      }
      const channels = new Set(
        full.seen.flatMap((q) =>
          q.params.filter((p): p is string => typeof p === "string" && p.startsWith("C_BATCH_")),
        ),
      );
      expect(channels.size).toBe(50);
      expect(full.seen.some((q) => q.params.includes(target.channelId))).toBe(false);
      expect(
        full.seen.some((q) =>
          q.params.some((p) => typeof p === "string" && p.startsWith("C_BACKLOG_")),
        ),
      ).toBe(false);
      const dirty = captureQueries();
      try {
        await flushSlackRenderV2DirtyThreads();
      } finally {
        dirty.restore();
      }
      expect(dirty.seen.some((q) => q.params.includes(target.channelId))).toBe(true);
      const next = captureQueries();
      try {
        await processSlackRenderV2();
      } finally {
        next.restore();
      }
      const nextChannels = new Set(
        next.seen.flatMap((q) =>
          q.params.filter((p): p is string => typeof p === "string" && p.startsWith("C_BATCH_")),
        ),
      );
      expect(nextChannels.size).toBe(50);
      expect([...nextChannels].some((channel) => channels.has(channel))).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.SLACK_RENDER_V2_TASK_TREE_ENABLED;
      else process.env.SLACK_RENDER_V2_TASK_TREE_ENABLED = prior;
    }
  });

  test("a task event renders only that task's thread", async () => {
    const a = await runningThread("EVENT_A");
    const b = await runningThread("EVENT_B");
    await processSlackRenderV2();
    expect(await getSlackTreeMessageByThread(a.channelId, a.threadTs)).not.toBeNull();
    expect(await getSlackTreeMessageByThread(b.channelId, b.threadTs)).not.toBeNull();

    startSlackRenderV2Events();
    const { seen, restore } = captureQueries();
    try {
      workflowEventBus.emit("task.progress", { taskId: a.task.id, progress: "working" });
      // The debounced flush runs on its own, without a watcher tick.
      const deadline = Date.now() + 3_000;
      while (
        !seen.some(
          (q) => q.sql.includes("SELECT * FROM agent_tasks") && q.params.includes(a.threadTs),
        ) &&
        Date.now() < deadline
      )
        await Bun.sleep(20);
      await flushSlackRenderV2DirtyThreads();
    } finally {
      restore();
    }
    const sweeps = seen.filter(isTreeSweep);
    expect(sweeps).toHaveLength(0);
    const reads = seen.filter((q) => q.params.includes(a.channelId));
    expect(reads.length).toBeGreaterThan(0);
    expect(seen.some((q) => q.params.includes(b.channelId))).toBe(false);
  });

  test("a flush with nothing queued reads no thread", async () => {
    await runningThread("IDLE");
    await processSlackRenderV2();
    const { seen, restore } = captureQueries();
    try {
      await flushSlackRenderV2DirtyThreads();
    } finally {
      restore();
    }
    expect(seen.filter(isTreeSweep)).toHaveLength(0);
  });

  test("events for tasks outside Slack threads render nothing", async () => {
    await runningThread("OUTSIDE");
    await processSlackRenderV2();
    const plain = await createTaskExtended("not a Slack task", { agentId: leadId });
    startSlackRenderV2Events();
    const { seen, restore } = captureQueries();
    try {
      workflowEventBus.emit("task.completed", { taskId: plain.id });
      await flushSlackRenderV2DirtyThreads();
    } finally {
      restore();
    }
    expect(seen.filter(isTreeSweep)).toHaveLength(0);
  });

  test("the full reconcile yields to the event loop between trees", async () => {
    const labels = ["YIELD_A", "YIELD_B", "YIELD_C"];
    for (const label of labels) await runningThread(label);
    await processSlackRenderV2();
    // Count event-loop turns during the pass. A setTimeout(0) probe is clamped
    // to ~1 ms and races a fast pass on CI, so tick with setImmediate instead.
    let turns = 0;
    let ticking = true;
    const tick = () => {
      if (!ticking) return;
      turns++;
      setImmediate(tick);
    };
    setImmediate(tick);
    try {
      await processSlackRenderV2();
    } finally {
      ticking = false;
    }
    expect(turns).toBeGreaterThanOrEqual(labels.length);
  });
});

describe("slack task watcher interval", () => {
  const previous = process.env.SLACK_TASK_WATCHER_INTERVAL_MS;
  afterEach(() => {
    if (previous === undefined) delete process.env.SLACK_TASK_WATCHER_INTERVAL_MS;
    else process.env.SLACK_TASK_WATCHER_INTERVAL_MS = previous;
  });

  test("defaults to 10 s and honours a positive integer override", () => {
    delete process.env.SLACK_TASK_WATCHER_INTERVAL_MS;
    expect(DEFAULT_SLACK_TASK_WATCHER_INTERVAL_MS).toBe(10_000);
    expect(slackTaskWatcherIntervalMs()).toBe(10_000);
    process.env.SLACK_TASK_WATCHER_INTERVAL_MS = "5000";
    expect(slackTaskWatcherIntervalMs()).toBe(5_000);
    for (const bad of ["0", "-1", "abc", "1.5", ""]) {
      process.env.SLACK_TASK_WATCHER_INTERVAL_MS = bad;
      expect(slackTaskWatcherIntervalMs()).toBe(10_000);
    }
  });
});
