// Phase 5: lead-facing budget refusal notification tests.
//
// Exercises `handlePoll` end-to-end with a tripped budget gate to assert:
//   - The first refusal of (task, day) creates exactly one follow-up task
//     owned by the lead, with Slack context inherited from the refused task.
//   - Same-day repeat refusals create ZERO additional follow-ups (dedup).
//   - The dedup row's `follow_up_task_id` is populated with the new task id.
//   - A subsequent refusal on a different UTC day creates a new follow-up
//     (the `(task_id, date)` PK rolls over).
//   - Each refusal — first or repeat — reaches the workflow event bus.
//
// Tests directly invoke `handlePoll` with mocked req/res, identical to the
// pattern used by `budget-claim-gate.test.ts`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createSessionCost,
  createTaskExtended,
  getBudgetRefusalNotification,
  getDb,
  initDb,
} from "../be/db";
import { handlePoll } from "../http/poll";
import { workflowEventBus } from "../workflows/event-bus";

const TEST_DB_PATH = "./test-budget-refusal-notification.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM session_costs").run();
  db.prepare("DELETE FROM budget_refusal_notifications").run();
  db.prepare("DELETE FROM budgets").run();
  db.prepare("DELETE FROM agent_tasks").run();
  db.prepare("DELETE FROM agents").run();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

interface PollResponse {
  status: number;
  body: { trigger: { type: string; [key: string]: unknown } | null } | { error: string };
}

async function callPoll(agentId: string | undefined): Promise<PollResponse> {
  let status = 200;
  let bodyStr = "";
  const headers: Record<string, string> = {};

  const req = {
    method: "GET",
    url: "/api/poll",
    headers: agentId ? { "x-agent-id": agentId } : {},
  } as unknown as Parameters<typeof handlePoll>[0];

  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, h?: Record<string, string>) {
      status = code;
      if (h) {
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
      }
    },
    end(body?: string) {
      bodyStr = body ?? "";
    },
  } as unknown as Parameters<typeof handlePoll>[1];

  const handled = await handlePoll(req, res, ["api", "poll"], new URLSearchParams(), agentId);
  if (!handled) throw new Error("handlePoll did not handle the request");
  return { status, body: bodyStr ? JSON.parse(bodyStr) : null };
}

function insertBudget(scope: "global" | "agent", scopeId: string, dailyBudgetUsd: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO budgets (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?)",
    )
    .run(scope, scopeId, dailyBudgetUsd, now, now);
}

function insertSpend(agentId: string, totalCostUsd: number): void {
  createSessionCost({
    sessionId: `sess-${crypto.randomUUID()}`,
    agentId,
    totalCostUsd,
    durationMs: 1_000,
    numTurns: 1,
    model: "test-model",
  });
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

interface FollowUpRow {
  id: string;
  agentId: string | null;
  parentTaskId: string | null;
  taskType: string | null;
  task: string;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackUserId: string | null;
  source: string;
}

function listFollowUpTasks(parentTaskId: string): FollowUpRow[] {
  return getDb()
    .prepare<FollowUpRow, [string]>(
      `SELECT id, agentId, parentTaskId, taskType, task, slackChannelId, slackThreadTs, slackUserId, source
       FROM agent_tasks
       WHERE parentTaskId = ? AND taskType = 'follow-up'
       ORDER BY createdAt ASC`,
    )
    .all(parentTaskId);
}

// Brief microtask-pump helper. The workflow bus emit goes through a dynamic
// `import().then(...)` in budget-refusal-notify.ts, so we wait one tick for
// the listener to fire before asserting.
async function waitForBusEmit(): Promise<void> {
  // Two macrotask ticks plus a couple of microtask flushes is overkill but
  // makes the test deterministic regardless of import-cache state.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Phase 5 — budget refusal lead notification + dedup", () => {
  test("first refusal creates exactly one lead-owned follow-up task with Slack context", async () => {
    const lead = createAgent({ name: "lead-1", isLead: true, status: "idle", maxTasks: 5 });
    const worker = createAgent({ name: "worker-1", isLead: false, status: "idle", maxTasks: 1 });
    insertBudget("agent", worker.id, 0.01);
    insertSpend(worker.id, 0.05);

    const parentTask = createTaskExtended("over-budget task", {
      agentId: worker.id,
      slackChannelId: "C_TEST_1",
      slackThreadTs: "1700000000.000001",
      slackUserId: "U_REPORTER_1",
    });

    const { body } = await callPoll(worker.id);
    if ("error" in body) throw new Error("unexpected error response");
    expect(body.trigger?.type).toBe("budget_refused");

    const followUps = listFollowUpTasks(parentTask.id);
    expect(followUps).toHaveLength(1);
    const followUp = followUps[0]!;
    expect(followUp.agentId).toBe(lead.id);
    expect(followUp.taskType).toBe("follow-up");
    expect(followUp.parentTaskId).toBe(parentTask.id);
    expect(followUp.source).toBe("system");
    // Slack context inherited from parent.
    expect(followUp.slackChannelId).toBe("C_TEST_1");
    expect(followUp.slackThreadTs).toBe("1700000000.000001");
    expect(followUp.slackUserId).toBe("U_REPORTER_1");
    // Body contains the rendered template variables.
    expect(followUp.task).toContain("Cause: agent");
    expect(followUp.task).toContain("worker-1");
    expect(followUp.task).toContain("over-budget task");
    expect(followUp.task).toContain("$0.05 / $0.01");
    expect(followUp.task).toContain(parentTask.id);
  });

  test("second same-day refusal creates ZERO additional follow-ups (dedup honored)", async () => {
    createAgent({ name: "lead-2", isLead: true, status: "idle", maxTasks: 5 });
    const worker = createAgent({ name: "worker-2", isLead: false, status: "idle", maxTasks: 1 });
    insertBudget("agent", worker.id, 0.01);
    insertSpend(worker.id, 0.5);

    const parentTask = createTaskExtended("dedup target", { agentId: worker.id });

    const r1 = await callPoll(worker.id);
    if ("error" in r1.body) throw new Error("unexpected error response");
    expect(r1.body.trigger?.type).toBe("budget_refused");
    expect(listFollowUpTasks(parentTask.id)).toHaveLength(1);

    // Second poll on the same UTC day — refusal repeats, but no new follow-up.
    const r2 = await callPoll(worker.id);
    if ("error" in r2.body) throw new Error("unexpected error response");
    expect(r2.body.trigger?.type).toBe("budget_refused");
    expect(listFollowUpTasks(parentTask.id)).toHaveLength(1);
  });

  test("dedup row's follow_up_task_id is written back to the new follow-up's id", async () => {
    createAgent({ name: "lead-3", isLead: true, status: "idle", maxTasks: 5 });
    const worker = createAgent({ name: "worker-3", isLead: false, status: "idle", maxTasks: 1 });
    insertBudget("agent", worker.id, 0.01);
    insertSpend(worker.id, 0.05);

    const parentTask = createTaskExtended("audit-trail task", { agentId: worker.id });

    await callPoll(worker.id);

    const followUps = listFollowUpTasks(parentTask.id);
    expect(followUps).toHaveLength(1);
    const followUpId = followUps[0]!.id;

    const dedupRow = getBudgetRefusalNotification(parentTask.id, todayUtc());
    expect(dedupRow).not.toBeNull();
    expect(dedupRow?.followUpTaskId).toBe(followUpId);
  });

  test("refusal on a NEW UTC day creates a new follow-up (PK rolls over)", async () => {
    createAgent({ name: "lead-4", isLead: true, status: "idle", maxTasks: 5 });
    const worker = createAgent({ name: "worker-4", isLead: false, status: "idle", maxTasks: 1 });
    insertBudget("agent", worker.id, 0.01);
    insertSpend(worker.id, 0.05);

    const parentTask = createTaskExtended("rollover task", { agentId: worker.id });

    // First refusal — first follow-up.
    await callPoll(worker.id);
    expect(listFollowUpTasks(parentTask.id)).toHaveLength(1);

    // Simulate "yesterday already had a refusal" by manually inserting a row
    // for a different `(task, date)` PK is the wrong approach — we instead
    // simulate "today rolled over to tomorrow" by overwriting today's dedup
    // row's `date` field to a yesterday placeholder, leaving the test poll
    // to insert a fresh row for the actual current UTC date.
    const yesterday = "1999-01-01"; // arbitrary past date guaranteed not to collide
    getDb()
      .prepare("UPDATE budget_refusal_notifications SET date = ? WHERE task_id = ? AND date = ?")
      .run(yesterday, parentTask.id, todayUtc());

    // Verify we moved the row.
    expect(getBudgetRefusalNotification(parentTask.id, todayUtc())).toBeNull();
    expect(getBudgetRefusalNotification(parentTask.id, yesterday)).not.toBeNull();

    // Second refusal — fresh PK, fresh follow-up.
    await callPoll(worker.id);
    const followUps = listFollowUpTasks(parentTask.id);
    expect(followUps).toHaveLength(2);
    // The newer dedup row exists for today.
    expect(getBudgetRefusalNotification(parentTask.id, todayUtc())).not.toBeNull();
  });

  test("workflow event bus receives task.budget_refused on every refusal (not just first)", async () => {
    createAgent({ name: "lead-5", isLead: true, status: "idle", maxTasks: 5 });
    const worker = createAgent({ name: "worker-5", isLead: false, status: "idle", maxTasks: 1 });
    insertBudget("agent", worker.id, 0.01);
    insertSpend(worker.id, 0.05);

    const parentTask = createTaskExtended("event-bus task", { agentId: worker.id });

    const events: Array<{ taskId: string; agentId: string; cause: string }> = [];
    const handler = (data: unknown) => {
      events.push(data as { taskId: string; agentId: string; cause: string });
    };
    workflowEventBus.on("task.budget_refused", handler);

    try {
      await callPoll(worker.id);
      await waitForBusEmit();
      await callPoll(worker.id);
      await waitForBusEmit();

      // Both refusals must reach the bus, even though only the first creates
      // a follow-up task.
      expect(events.length).toBeGreaterThanOrEqual(2);
      for (const ev of events) {
        expect(ev.taskId).toBe(parentTask.id);
        expect(ev.agentId).toBe(worker.id);
        expect(ev.cause).toBe("agent");
      }
    } finally {
      workflowEventBus.off("task.budget_refused", handler);
    }
  });

  test("no follow-up created when there's no lead agent (refusal still emits + dedup row stays)", async () => {
    // Workers only — no lead.
    const worker = createAgent({
      name: "worker-no-lead",
      isLead: false,
      status: "idle",
      maxTasks: 1,
    });
    insertBudget("agent", worker.id, 0.01);
    insertSpend(worker.id, 0.05);

    const parentTask = createTaskExtended("no-lead task", { agentId: worker.id });

    const { body } = await callPoll(worker.id);
    if ("error" in body) throw new Error("unexpected error response");
    expect(body.trigger?.type).toBe("budget_refused");

    expect(listFollowUpTasks(parentTask.id)).toHaveLength(0);
    // The dedup row is still recorded — write-back is a best-effort step that
    // won't run when there's no follow-up to link, but the row's existence
    // is what serves as the operator's "the lead was already notified
    // (theoretically)" audit signal.
    const dedupRow = getBudgetRefusalNotification(parentTask.id, todayUtc());
    expect(dedupRow).not.toBeNull();
    expect(dedupRow?.followUpTaskId).toBeUndefined();
  });
});
