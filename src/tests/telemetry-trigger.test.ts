import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getDbClient,
  initDb,
  updateAgentProfile,
} from "../be/db";
import { checkHeartbeatChecklist, createBootTriageTask } from "../heartbeat/heartbeat";
// Side-effect import: the checklist and boot-triage prompts come from the heartbeat templates.
import "../heartbeat/templates";
import { telemetry } from "../telemetry";
import { _resetTriggerSurfaceCacheForTests, resolveTriggerSurface } from "../telemetry-trigger";

// initTelemetry is not called here, but emitTaskTelemetry checks the opt-out
// env first, and the CI env may set it.
process.env.ANONYMIZED_TELEMETRY = "true";

const TEST_DB_PATH = "./test-telemetry-trigger.sqlite";
const WORKER_ID = "bbbb0000-0000-4000-8000-000000000003";
const LEAD_ID = "aaaa0000-0000-4000-8000-000000000003";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File does not exist.
    }
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

type Call = { event: string; props: Record<string, unknown> };

describe("trigger_surface on task telemetry", () => {
  let spy: ReturnType<typeof spyOn>;
  let calls: Call[];

  const forTask = (taskId: string, event: string) =>
    calls.find((c) => c.props.taskId === taskId && c.event === event);

  beforeEach(async () => {
    closeDb();
    await removeTestDb();
    initDb(TEST_DB_PATH);
    _resetTriggerSurfaceCacheForTests();
    await createAgent({ id: WORKER_ID, name: "Trigger Worker", isLead: false, status: "idle" });
    await createAgent({ id: LEAD_ID, name: "Trigger Lead", isLead: true, status: "idle" });
    calls = [];
    spy = spyOn(telemetry, "taskEvent").mockImplementation((event, props) => {
      calls.push({ event, props: props as Record<string, unknown> });
    });
  });

  afterEach(async () => {
    spy.mockRestore();
    closeDb();
    await removeTestDb();
  });

  test("a slack root with an mcp child and a system follow-up reports slack on every created and completed event", async () => {
    const root = await createTaskExtended("slack ask", { agentId: LEAD_ID, source: "slack" });
    const child = await createTaskExtended("delegated", {
      agentId: WORKER_ID,
      source: "mcp",
      parentTaskId: root.id,
    });
    const followUp = await createTaskExtended("follow-up", {
      agentId: LEAD_ID,
      source: "system",
      parentTaskId: child.id,
    });
    await flush();
    await completeTask(root.id, "done");
    await completeTask(child.id, "done");
    await completeTask(followUp.id, "done");
    await flush();

    const tasks = [
      { id: root.id, taskSource: "slack" },
      { id: child.id, taskSource: "mcp" },
      { id: followUp.id, taskSource: "system" },
    ];
    for (const { id, taskSource } of tasks) {
      for (const event of ["created", "completed"]) {
        const call = forTask(id, event);
        expect(call?.props.trigger_surface).toBe("slack");
        expect(call?.props.task_source).toBe(taskSource);
      }
    }
  });

  test("a failed child reports its root's surface", async () => {
    const root = await createTaskExtended("linear ask", { agentId: LEAD_ID, source: "linear" });
    const child = await createTaskExtended("delegated", {
      agentId: WORKER_ID,
      source: "mcp",
      parentTaskId: root.id,
    });
    await flush();
    await failTask(child.id, "nope");
    await flush();

    const failed = forTask(child.id, "failed");
    expect(failed?.props.trigger_surface).toBe("linear");
    expect(failed?.props.task_source).toBe("mcp");
  });

  test("no task event carries a source property", async () => {
    const root = await createTaskExtended("api ask", { agentId: LEAD_ID, source: "api" });
    await flush();
    await completeTask(root.id, "done");
    await flush();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect("source" in call.props).toBe(false);
  });

  // The two heartbeat creators default to source "mcp" when they omit `source`,
  // so each one is run for real and judged on the row it persists and the
  // task.created event it emits.
  const heartbeatCreators: Array<{ taskType: string; create: () => Promise<void> }> = [
    {
      taskType: "boot-triage",
      create: async () => {
        // A clean boot creates no task; force one to judge its source.
        process.env.HEARTBEAT_BOOT_TRIAGE_ALWAYS = "true";
        try {
          await createBootTriageTask();
        } finally {
          delete process.env.HEARTBEAT_BOOT_TRIAGE_ALWAYS;
        }
      },
    },
    {
      taskType: "heartbeat-checklist",
      create: async () => {
        await updateAgentProfile(LEAD_ID, { heartbeatMd: "- Check for stuck tasks\n" });
        await checkHeartbeatChecklist();
      },
    },
  ];

  for (const { taskType, create } of heartbeatCreators) {
    test(`a ${taskType} task reports system, not mcp`, async () => {
      await create();
      await flush();

      const row = await getDbClient().get<{ id: string; source: string }>(
        "SELECT id, source FROM agent_tasks WHERE taskType = ?",
        [taskType],
      );
      // The row says system too, so the dashboard UI stops calling it mcp.
      expect(row?.source).toBe("system");

      const created = forTask(row?.id as string, "created");
      expect(created?.props.trigger_surface).toBe("system");
      expect(created?.props.task_source).toBe("system");
    });
  }

  test("an orphan (parent row deleted) uses the deepest row that still exists", async () => {
    const root = await createTaskExtended("root", { agentId: LEAD_ID, source: "github" });
    const child = await createTaskExtended("child", {
      agentId: WORKER_ID,
      source: "mcp",
      parentTaskId: root.id,
    });
    _resetTriggerSurfaceCacheForTests();
    await getDbClient().run("PRAGMA foreign_keys = OFF");
    await getDbClient().run("DELETE FROM agent_tasks WHERE id = ?", [root.id]);
    expect(await resolveTriggerSurface(child.id)).toBe("mcp");
  });

  test("a task that no longer exists falls back to the caller's source, uncached", async () => {
    expect(await resolveTriggerSurface("missing-task", "schedule")).toBe("schedule");
    expect(await resolveTriggerSurface("missing-task", "weird")).toBe("other");
  });

  test("the root surface is memoized, because a task's root is fixed at creation", async () => {
    const root = await createTaskExtended("root", { agentId: LEAD_ID, source: "jira" });
    expect(await resolveTriggerSurface(root.id)).toBe("jira");
    await getDbClient().run("PRAGMA foreign_keys = OFF");
    await getDbClient().run("DELETE FROM agent_tasks WHERE id = ?", [root.id]);
    expect(await resolveTriggerSurface(root.id)).toBe("jira");
  });

  test("a chain deeper than the cap stops at the cap instead of looping", async () => {
    // 60 tasks in a line, inserted as raw rows to avoid 60 full createTask calls.
    const ids = Array.from({ length: 60 }, (_, i) => `chain-${String(i).padStart(2, "0")}`);
    await getDbClient().run("PRAGMA foreign_keys = OFF");
    for (const [i, id] of ids.entries()) {
      await getDbClient().run(
        `INSERT INTO agent_tasks (id, task, status, source, parentTaskId, createdAt, lastUpdatedAt)
         VALUES (?, 'x', 'pending', ?, ?, datetime('now'), datetime('now'))`,
        [id, i === 0 ? "slack" : "mcp", i === 0 ? null : ids[i - 1]],
      );
    }
    // Depth 50 above the tail is chain-09, an mcp task: the walk stopped at the cap.
    expect(await resolveTriggerSurface("chain-59")).toBe("mcp");
    // A chain inside the cap reaches the slack root.
    expect(await resolveTriggerSurface("chain-40")).toBe("slack");
  });
});
