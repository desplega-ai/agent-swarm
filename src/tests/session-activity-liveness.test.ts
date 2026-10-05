/**
 * Issue #1877 — a task that streams provider output (e.g. a long OpenCode
 * reasoning phase with no tool calls) must not be failed by the heartbeat
 * watchdog as a crashed session.
 *
 * Every harness pushes its output through POST /api/session-logs, so that
 * endpoint refreshes the task's active session. These tests drive the real HTTP
 * handler and then the real stalled-task classifier.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getActiveSessionForTask,
  getDbClient,
  getTaskById,
  initDb,
  insertActiveSession,
  refreshActiveSessionOnActivity,
  SESSION_ACTIVITY_REFRESH_MIN_INTERVAL_MS,
  startTask,
} from "../be/db";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import { handleSessionData } from "../http/session-data";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-session-activity-liveness.sqlite";
const MIN = 60 * 1000;

let server: Server;
let baseUrl: string;

async function postSessionLogs(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/session-logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function reasoningDeltaLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({ type: "message.part.updated", part: { type: "reasoning", delta: `t${i}` } }),
  );
}

/** An in-progress task with a session whose heartbeat AND task update are `ageMin` old. */
async function seedStaleRunningTask(
  name: string,
  ageMin: number,
  opts: { workflowStep?: boolean } = {},
) {
  const agent = await createAgent({ name, isLead: false, status: "busy" });
  const task = await createTaskExtended(`Long reasoning task (${name})`, { agentId: agent.id });
  await startTask(task.id);
  await insertActiveSession({ agentId: agent.id, taskId: task.id, triggerType: "task_assigned" });

  if (opts.workflowStep) {
    // FKs off: this only exercises the heartbeat path, not the workflow engine
    // (same pattern as heartbeat-supersede-resume.test.ts).
    await getDbClient().run("PRAGMA foreign_keys = OFF");
    try {
      await getDbClient().run("UPDATE agent_tasks SET workflowRunStepId = ? WHERE id = ?", [
        crypto.randomUUID(),
        task.id,
      ]);
    } finally {
      await getDbClient().run("PRAGMA foreign_keys = ON");
    }
  }

  const stale = new Date(Date.now() - ageMin * MIN).toISOString();
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
    stale,
    task.id,
  ]);
  await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
    stale,
    task.id,
  ]);
  return { agent, task, stale };
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
  closeDb();
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req, res) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const handled = await handleSessionData(
      req,
      res,
      pathSegments,
      queryParams,
      req.headers["x-agent-id"] as string | undefined,
    );
    if (!handled) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  server.close();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM session_logs");
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run("DELETE FROM agents");
  await getDbClient().run("DELETE FROM active_sessions");
});

describe("session-log ingestion refreshes session liveness (#1877)", () => {
  test("control: a stale session with no provider activity is still remediated", async () => {
    const { task } = await seedStaleRunningTask("quiet-worker", 20);

    const findings = await codeLevelTriage();

    expect(findings.autoResumedTasks.map((t) => t.taskId)).toEqual([task.id]);
    expect((await getTaskById(task.id))?.status).toBe("superseded");
    expect(await getActiveSessionForTask(task.id)).toBeNull();
  });

  test("streamed session logs keep a would-be-stale session alive", async () => {
    const { task, stale } = await seedStaleRunningTask("streaming-worker", 20);

    const res = await postSessionLogs({
      sessionId: "runner-session-1",
      iteration: 1,
      taskId: task.id,
      cli: "opencode",
      lines: reasoningDeltaLines(50),
    });
    expect(res.status).toBe(201);

    const session = await getActiveSessionForTask(task.id);
    expect(session).not.toBeNull();
    expect(new Date(session!.lastHeartbeatAt).getTime()).toBeGreaterThan(
      new Date(stale).getTime() + 19 * MIN,
    );

    const findings = await codeLevelTriage();

    expect(findings.autoResumedTasks).toHaveLength(0);
    expect(findings.autoFailedTasks).toHaveLength(0);
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("in_progress");
    expect(await getActiveSessionForTask(task.id)).not.toBeNull();
  });

  test("a workflow-step task that streams is not failed with superseded_workflow_task", async () => {
    const { task } = await seedStaleRunningTask("workflow-streaming-worker", 20, {
      workflowStep: true,
    });
    // Control: without activity the same setup fails the step.
    const quiet = await seedStaleRunningTask("workflow-quiet-worker", 20, { workflowStep: true });

    const res = await postSessionLogs({
      sessionId: "runner-session-wf",
      iteration: 1,
      taskId: task.id,
      cli: "opencode",
      lines: reasoningDeltaLines(5),
    });
    expect(res.status).toBe(201);

    const findings = await codeLevelTriage();

    expect(findings.autoFailedTasks.map((t) => t.taskId)).toEqual([quiet.task.id]);
    expect(findings.autoFailedTasks[0]?.reason).toBe("superseded_workflow_task");
    const streaming = await getTaskById(task.id);
    expect(streaming?.status).toBe("in_progress");
    expect(streaming?.failureReason).toBeFalsy();
  });

  test("only the session of the task the logs belong to is refreshed", async () => {
    const streaming = await seedStaleRunningTask("streaming-worker", 20);
    const other = await seedStaleRunningTask("other-worker", 20);

    await postSessionLogs({
      sessionId: "runner-session-2",
      iteration: 1,
      taskId: streaming.task.id,
      lines: ["x"],
    });

    const otherSession = await getActiveSessionForTask(other.task.id);
    expect(otherSession?.lastHeartbeatAt).toBe(other.stale);

    const findings = await codeLevelTriage();
    expect(findings.autoResumedTasks.map((t) => t.taskId)).toEqual([other.task.id]);
    expect((await getTaskById(streaming.task.id))?.status).toBe("in_progress");
  });

  test("logs without a taskId, or for a task with no session, are stored and refresh nothing", async () => {
    const { task, stale } = await seedStaleRunningTask("unrelated-worker", 20);

    const noTask = await postSessionLogs({ sessionId: "s", iteration: 1, lines: ["a"] });
    const noSession = await postSessionLogs({
      sessionId: "s",
      iteration: 1,
      taskId: crypto.randomUUID(),
      lines: ["b"],
    });

    expect(noTask.status).toBe(201);
    expect(noSession.status).toBe(201);
    expect((await getActiveSessionForTask(task.id))?.lastHeartbeatAt).toBe(stale);
  });
});

describe("refreshActiveSessionOnActivity", () => {
  test("throttles: a second call inside the window writes nothing", async () => {
    const { task } = await seedStaleRunningTask("throttle-worker", 20);

    expect(await refreshActiveSessionOnActivity(task.id)).toBe(true);
    const first = (await getActiveSessionForTask(task.id))!.lastHeartbeatAt;

    expect(await refreshActiveSessionOnActivity(task.id)).toBe(false);
    expect((await getActiveSessionForTask(task.id))!.lastHeartbeatAt).toBe(first);
  });

  test("writes again once the window has passed", async () => {
    const { task } = await seedStaleRunningTask("window-worker", 20);
    const justOutside = new Date(
      Date.now() - SESSION_ACTIVITY_REFRESH_MIN_INTERVAL_MS - 1000,
    ).toISOString();
    await getDbClient().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
      justOutside,
      task.id,
    ]);

    expect(await refreshActiveSessionOnActivity(task.id)).toBe(true);
    expect(
      new Date((await getActiveSessionForTask(task.id))!.lastHeartbeatAt).getTime(),
    ).toBeGreaterThan(new Date(justOutside).getTime());
  });
});
