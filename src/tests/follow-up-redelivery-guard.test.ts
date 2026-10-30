import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  cancelTask,
  closeDb,
  completeTask,
  countAgentDispatchesInThread,
  createAgent,
  createTaskExtended,
  failTask,
  findCompletedTasksInThread,
  findRecentCancelledTaskInThread,
  getDbClient,
  initDb,
} from "../be/db";
import {
  FOLLOW_UP_DISPATCH_CAP,
  FOLLOW_UP_DISPATCH_WINDOW_MINUTES,
  FOLLOW_UP_SAME_WORK_PAGE_SIZE,
} from "../tasks/follow-up-redelegation-guard";
import { sendTaskHandler, sendTaskInputSchema } from "../tools/send-task";
import { DEDUP_SCAN_LIMIT, findDuplicateTask } from "../tools/task-dedup";
import { ownerCtx } from "../tools/task-tool-ctx";

const TEST_DB_PATH = "./test-follow-up-redelivery-guard.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore if files don't exist
  }
});

describe("findCompletedTasksInThread", () => {
  test("finds completed tasks in a thread within the time window", async () => {
    const agent = await createAgent({
      name: "dedup-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("test task for thread", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_1",
      slackThreadTs: "1000.0001",
    });

    // Mark as completed
    await completeTask(task.id, "done");

    // Should find the completed task within a 2880-minute (48h) window
    const result = await findCompletedTasksInThread("C_DEDUP_1", "1000.0001", 2880);
    expect(result.map((t) => t.id)).toEqual([task.id]);
    expect(result[0]!.status).toBe("completed");
  });

  test("returns nothing when no completed tasks exist in the thread", async () => {
    const agent = await createAgent({
      name: "dedup-worker-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create a task but don't complete it
    await createTaskExtended("pending task in thread", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_2",
      slackThreadTs: "2000.0001",
    });

    const result = await findCompletedTasksInThread("C_DEDUP_2", "2000.0001", 2880);
    expect(result).toEqual([]);
  });

  test("returns nothing outside the time window", async () => {
    const agent = await createAgent({
      name: "dedup-worker-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("old completed task", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_3",
      slackThreadTs: "3000.0001",
    });

    await completeTask(task.id, "done long ago");

    // Backdate the lastUpdatedAt to 49 hours ago (beyond the 48h window)
    const fortyNineHoursAgo = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      fortyNineHoursAgo,
      task.id,
    ]);

    // Should not find with a 48 hour window
    const result = await findCompletedTasksInThread("C_DEDUP_3", "3000.0001", 2880);
    expect(result).toEqual([]);
  });

  test("returns nothing for a different thread", async () => {
    const agent = await createAgent({
      name: "dedup-worker-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = await createTaskExtended("task in different thread", {
      agentId: agent.id,
      slackChannelId: "C_DEDUP_4",
      slackThreadTs: "4000.0001",
    });

    await completeTask(task.id, "done");

    // Search in a different thread — should not find
    const result = await findCompletedTasksInThread("C_DEDUP_4", "4000.9999", 2880);
    expect(result).toEqual([]);
  });

  test("caps the rows it returns at the limit, newest first", async () => {
    const agent = await createAgent({
      name: "dedup-worker-5",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const task = await createTaskExtended(`capped completion ${i}`, {
        agentId: agent.id,
        slackChannelId: "C_DEDUP_5",
        slackThreadTs: "5000.0001",
      });
      await completeTask(task.id, "done");
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        new Date(Date.now() - (3 - i) * 60 * 1000).toISOString(),
        task.id,
      ]);
      ids.push(task.id);
    }

    const result = await findCompletedTasksInThread("C_DEDUP_5", "5000.0001", 2880, 2);
    expect(result.map((t) => t.id)).toEqual([ids[2], ids[1]]);
  });

  test("the before cursor returns the next page, including rows tied on lastUpdatedAt", async () => {
    const agent = await createAgent({
      name: "dedup-worker-6",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      const task = await createTaskExtended(`paged completion ${i}`, {
        agentId: agent.id,
        slackChannelId: "C_DEDUP_6",
        slackThreadTs: "6000.0001",
      });
      await completeTask(task.id, "done");
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        at,
        task.id,
      ]);
    }

    const seen: string[] = [];
    let before: { lastUpdatedAt: string; id: string } | undefined;
    // Bounded so an ignored cursor fails the test instead of looping forever.
    for (let i = 0; i < 10; i++) {
      const page = await findCompletedTasksInThread("C_DEDUP_6", "6000.0001", 2880, 2, before);
      seen.push(...page.map((t) => t.id));
      const last = page.at(-1);
      if (!last || page.length < 2) break;
      before = { lastUpdatedAt: last.lastUpdatedAt, id: last.id };
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});

describe("findRecentCancelledTaskInThread", () => {
  test("findRecentCancelledTaskInThread finds tasks with status='cancelled'", async () => {
    const agent = await createAgent({
      name: "cancel-thread-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("cancelled work", {
      agentId: agent.id,
      slackChannelId: "C_CANCEL_1",
      slackThreadTs: "9000.0001",
    });
    await cancelTask(task.id, "user cancelled");

    const result = await findRecentCancelledTaskInThread("C_CANCEL_1", "9000.0001", 2880);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(task.id);
    expect(result!.status).toBe("cancelled");
  });

  test("findRecentCancelledTaskInThread finds failed tasks with 'cancelled' failureReason", async () => {
    const agent = await createAgent({
      name: "cancel-thread-worker-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("aborted work", {
      agentId: agent.id,
      slackChannelId: "C_CANCEL_2",
      slackThreadTs: "9000.0002",
    });
    await failTask(task.id, "cancelled");

    const result = await findRecentCancelledTaskInThread("C_CANCEL_2", "9000.0002", 2880);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(task.id);
    expect(result!.failureReason).toBe("cancelled");
  });

  test("findRecentCancelledTaskInThread finds failed tasks with 'exit 130' failureReason", async () => {
    const agent = await createAgent({
      name: "cancel-thread-worker-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("aborted work via SIGINT", {
      agentId: agent.id,
      slackChannelId: "C_CANCEL_3",
      slackThreadTs: "9000.0003",
    });
    await failTask(task.id, "exit 130: aborted by user");

    const result = await findRecentCancelledTaskInThread("C_CANCEL_3", "9000.0003", 2880);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(task.id);
  });

  test("findRecentCancelledTaskInThread ignores plain failed tasks (no cancellation marker)", async () => {
    const agent = await createAgent({
      name: "cancel-thread-worker-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const task = await createTaskExtended("genuinely failed work", {
      agentId: agent.id,
      slackChannelId: "C_CANCEL_4",
      slackThreadTs: "9000.0004",
    });
    await failTask(task.id, "TypeError: cannot read property of undefined");

    const result = await findRecentCancelledTaskInThread("C_CANCEL_4", "9000.0004", 2880);
    expect(result).toBeNull();
  });
});

describe("send-task follow-up re-delegation guard", () => {
  let leadAgent: Awaited<ReturnType<typeof createAgent>>;
  let workerAgent: Awaited<ReturnType<typeof createAgent>>;

  beforeAll(async () => {
    leadAgent = await createAgent({
      name: "guard-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    workerAgent = await createAgent({
      name: "guard-worker",
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 100,
    });
  });

  async function backdate(taskId: string, minutesAgo: number): Promise<void> {
    const at = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    await getDbClient().run(
      "UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?",
      [at, at, taskId],
    );
  }

  /** A worker task in the thread that completed `minutesAgo` minutes ago. */
  async function completedWork(channel: string, thread: string, text: string, minutesAgo = 30) {
    const task = await createTaskExtended(text, {
      agentId: workerAgent.id,
      slackChannelId: channel,
      slackThreadTs: thread,
    });
    await completeTask(task.id, "done");
    await backdate(task.id, minutesAgo);
    return task;
  }

  /** The Lead session store-progress opens after a worker finishes. */
  async function leadSession(channel: string, thread: string, taskType = "follow-up") {
    return createTaskExtended("Worker task completed — review needed.", {
      agentId: leadAgent.id,
      source: "system",
      taskType,
      slackChannelId: channel,
      slackThreadTs: thread,
    });
  }

  function dispatch(sourceTaskId: string, task: string, extra: Record<string, unknown> = {}) {
    return sendTaskHandler(
      ownerCtx({ agentId: leadAgent.id, sourceTaskId }),
      sendTaskInputSchema.parse({
        task,
        agentId: workerAgent.id,
        routingReason: "skill",
        routingNote: "worker owns this repo",
        ...extra,
      }),
    );
  }

  test("a distinct next-step dispatch from a follow-up passes", async () => {
    await completedWork("C_NEXT", "1.1", "implement the billing export endpoint in the api server");
    const followUp = await leadSession("C_NEXT", "1.1");
    await completeTask(followUp.id, "dispatched step 1");
    const session = await leadSession("C_NEXT", "1.1");

    const result = await dispatch(
      session.id,
      "review pull request 42 and post findings as comments",
    );
    expect(result.ok).toBe(true);
    expect(result.data?.task?.slackThreadTs).toBe("1.1");
  });

  test("re-dispatching completed work from a follow-up is blocked by the same-work rule", async () => {
    const done = await completedWork("C_SAME", "2.1", "fix the flaky retry test in the scheduler");
    const session = await leadSession("C_SAME", "2.1");

    const result = await dispatch(session.id, "fix the flaky retry test in the scheduler");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("same-work rule");
    expect(result.message).toContain(done.id.slice(0, 8));
    expect(result.message).toContain("allowRedelegation: true");
  });

  test("allowDuplicate does not bypass the same-work rule", async () => {
    await completedWork("C_DUP", "3.1", "rotate the staging database credentials now");
    const session = await leadSession("C_DUP", "3.1");

    const result = await dispatch(session.id, "rotate the staging database credentials now", {
      allowDuplicate: true,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("same-work rule");
  });

  test("matching completed work stays blocked behind 50 newer unrelated completions", async () => {
    const done = await completedWork(
      "C_DEEP",
      "2.5",
      "migrate the audit log table to the new schema",
      120,
    );
    for (let i = 0; i < 50; i++) {
      await completedWork("C_DEEP", "2.5", `unrelated chore ${i} touching widget ${i}`, 60 - i);
    }
    const session = await leadSession("C_DEEP", "2.5");

    const result = await dispatch(session.id, "migrate the audit log table to the new schema");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("same-work rule");
    expect(result.message).toContain(done.id.slice(0, 8));
  });

  test("matching completed work stays blocked behind more than a page of newer unrelated completions", async () => {
    const done = await completedWork(
      "C_DEEPER",
      "2.6",
      "backfill the invoice totals for the march billing run",
      600,
    );
    for (let i = 0; i < FOLLOW_UP_SAME_WORK_PAGE_SIZE + 50; i++) {
      await completedWork("C_DEEPER", "2.6", `unrelated chore ${i} touching widget ${i}`, 300 - i);
    }
    const session = await leadSession("C_DEEPER", "2.6");

    const result = await dispatch(
      session.id,
      "backfill the invoice totals for the march billing run",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("same-work rule");
    expect(result.message).toContain(done.id.slice(0, 8));
  });

  test("the loop cap blocks a distinct dispatch once the thread hit the cap", async () => {
    for (let i = 0; i < FOLLOW_UP_DISPATCH_CAP; i++) {
      await createTaskExtended(`loop step number ${i} with unique words ${i * 7}`, {
        agentId: workerAgent.id,
        creatorAgentId: leadAgent.id,
        source: "mcp",
        slackChannelId: "C_LOOP",
        slackThreadTs: "4.1",
      });
    }
    const session = await leadSession("C_LOOP", "4.1");

    const result = await dispatch(
      session.id,
      "draft the quarterly changelog summary for customers",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("loop-cap rule");
    expect(result.message).toContain(`cap ${FOLLOW_UP_DISPATCH_CAP}`);
    expect(result.message).toContain("allowRedelegation: true");
  });

  /** A durable run's `ctx.step.agentTask` step tasks, created by the Lead in the thread. */
  async function runSteps(channel: string, thread: string, steps: number) {
    const runId = crypto.randomUUID();
    for (let i = 0; i < steps; i++) {
      await createTaskExtended(`deck slide ${i} for run ${runId.slice(0, 8)} words ${i * 11}`, {
        agentId: workerAgent.id,
        creatorAgentId: leadAgent.id,
        source: "mcp",
        taskType: "script-run-step",
        contextKey: `script-run:${runId}:slide-${i}`,
        slackChannelId: channel,
        slackThreadTs: thread,
      });
    }
    return runId;
  }

  test("a 29-step durable run plus one send-task counts as two dispatches", async () => {
    await runSteps("C_LOOP_RUN", "4.3", 29);
    await createTaskExtended("one plain send-task dispatch into the thread", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      source: "mcp",
      slackChannelId: "C_LOOP_RUN",
      slackThreadTs: "4.3",
    });
    expect(
      await countAgentDispatchesInThread(
        "C_LOOP_RUN",
        "4.3",
        leadAgent.id,
        FOLLOW_UP_DISPATCH_WINDOW_MINUTES,
      ),
    ).toBe(2);
    const session = await leadSession("C_LOOP_RUN", "4.3");

    const result = await dispatch(session.id, "summarize the deck review notes for the team");
    expect(result.ok).toBe(true);
  });

  test("the loop cap counts each durable run and each send-task once", async () => {
    for (let i = 0; i < FOLLOW_UP_DISPATCH_CAP / 2; i++) {
      await runSteps("C_LOOP_MIX", "4.4", 3);
      await createTaskExtended(`mixed loop send-task ${i} unique words ${i * 17}`, {
        agentId: workerAgent.id,
        creatorAgentId: leadAgent.id,
        source: "mcp",
        slackChannelId: "C_LOOP_MIX",
        slackThreadTs: "4.4",
      });
    }
    const session = await leadSession("C_LOOP_MIX", "4.4");

    const result = await dispatch(session.id, "write the release announcement for the blog");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("loop-cap rule");
    expect(result.message).toContain(`dispatched ${FOLLOW_UP_DISPATCH_CAP} times`);
  });

  test("dispatches older than the loop-cap window do not count", async () => {
    for (let i = 0; i < FOLLOW_UP_DISPATCH_CAP; i++) {
      const old = await createTaskExtended(`old loop step ${i} distinct text ${i * 13}`, {
        agentId: workerAgent.id,
        creatorAgentId: leadAgent.id,
        source: "mcp",
        slackChannelId: "C_LOOP_OLD",
        slackThreadTs: "4.2",
      });
      await backdate(old.id, 7 * 60);
    }
    const session = await leadSession("C_LOOP_OLD", "4.2");

    const result = await dispatch(session.id, "audit the onboarding emails for broken links");
    expect(result.ok).toBe(true);
  });

  test("a failed task more recent than the completion lets the same work through", async () => {
    await completedWork("C_FAIL", "5.1", "migrate the reports page to the new table component");
    const failed = await createTaskExtended("migrate the reports page, second attempt", {
      agentId: workerAgent.id,
      slackChannelId: "C_FAIL",
      slackThreadTs: "5.1",
    });
    await failTask(failed.id, "TypeError: cannot read property of undefined");
    const session = await leadSession("C_FAIL", "5.1");

    const result = await dispatch(
      session.id,
      "migrate the reports page to the new table component",
    );
    expect(result.ok).toBe(true);
  });

  test("a failure older than the completion does not bypass the same-work rule", async () => {
    const failed = await createTaskExtended("compress the landing hero images, first try", {
      agentId: workerAgent.id,
      slackChannelId: "C_FAIL_OLD",
      slackThreadTs: "5.2",
    });
    await failTask(failed.id, "network error");
    await backdate(failed.id, 60);
    await completedWork("C_FAIL_OLD", "5.2", "compress the landing hero images to webp", 30);
    const session = await leadSession("C_FAIL_OLD", "5.2");

    const result = await dispatch(session.id, "compress the landing hero images to webp");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("same-work rule");
  });

  test("a cancelled task more recent than the completion still lets the same work through", async () => {
    await completedWork("C_CANCEL", "6.1", "translate the pricing page into spanish copy");
    const cancelled = await createTaskExtended("translate the pricing page, rerun", {
      agentId: workerAgent.id,
      slackChannelId: "C_CANCEL",
      slackThreadTs: "6.1",
    });
    await cancelTask(cancelled.id, "cancelled");
    const session = await leadSession("C_CANCEL", "6.1");

    const result = await dispatch(session.id, "translate the pricing page into spanish copy");
    expect(result.ok).toBe(true);
  });

  test("allowRedelegation overrides both rules", async () => {
    await completedWork("C_OVERRIDE", "7.1", "regenerate the openapi spec after the route change");
    const session = await leadSession("C_OVERRIDE", "7.1");

    const blocked = await dispatch(
      session.id,
      "regenerate the openapi spec after the route change",
    );
    expect(blocked.ok).toBe(false);

    const result = await dispatch(
      session.id,
      "regenerate the openapi spec after the route change",
      { allowRedelegation: true },
    );
    expect(result.ok).toBe(true);

    for (let i = 0; i < FOLLOW_UP_DISPATCH_CAP; i++) {
      await createTaskExtended(`override loop filler ${i} words ${i * 11}`, {
        agentId: workerAgent.id,
        creatorAgentId: leadAgent.id,
        source: "mcp",
        slackChannelId: "C_OVERRIDE",
        slackThreadTs: "7.1",
      });
    }
    const capped = await dispatch(session.id, "write release notes for the export feature", {
      allowRedelegation: true,
    });
    expect(capped.ok).toBe(true);
  });

  test("a resume source task is exempt from the guard", async () => {
    await completedWork("C_RESUME", "8.1", "finish the interrupted search index rebuild");
    const resume = await leadSession("C_RESUME", "8.1", "resume");

    const result = await dispatch(resume.id, "finish the interrupted search index rebuild");
    expect(result.ok).toBe(true);
  });

  test("a non-follow-up source task is not guarded", async () => {
    await completedWork("C_INBOX", "9.1", "summarize the open incidents for this week");
    const inbox = await leadSession("C_INBOX", "9.1", "inbox");

    const result = await dispatch(inbox.id, "summarize the open incidents for this week");
    expect(result.ok).toBe(true);
  });
});

describe("findDuplicateTask", () => {
  test("finds an older duplicate behind 50 newer unrelated tasks from the same creator", async () => {
    const creator = await createAgent({
      name: "dedup-deep-creator",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const original = await createTaskExtended("backfill the invoice totals for october", {
      creatorAgentId: creator.id,
    });
    await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
      new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      original.id,
    ]);
    for (let i = 0; i < 50; i++) {
      await createTaskExtended(`unrelated chore ${i} touching widget ${i}`, {
        creatorAgentId: creator.id,
      });
    }

    const match = await findDuplicateTask({
      taskDescription: "backfill the invoice totals for october",
      creatorAgentId: creator.id,
    });
    expect(match?.task.id).toBe(original.id);
  });

  test("scans at most DEDUP_SCAN_LIMIT rows, so a large backlog keeps one dispatch bounded", async () => {
    const creator = await createAgent({
      name: "dedup-backlog-creator",
      isLead: true,
      status: "idle",
      capabilities: [],
    });
    const original = await createTaskExtended("reconcile the ledger exports for november", {
      creatorAgentId: creator.id,
    });
    await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
      new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      original.id,
    ]);
    for (let i = 0; i < DEDUP_SCAN_LIMIT; i++) {
      await createTaskExtended(`backlog chore ${i} touching gadget ${i}`, {
        creatorAgentId: creator.id,
      });
    }

    const match = await findDuplicateTask({
      taskDescription: "reconcile the ledger exports for november",
      creatorAgentId: creator.id,
    });
    expect(match).toBeNull();
  });
});
