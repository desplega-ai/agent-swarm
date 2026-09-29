/**
 * QA edge cases for the heartbeat Reclaim/Unpin/attempt-fence (PR #1682).
 *
 * `test.failing` = a confirmed gap: the test states the required behavior and
 * is expected to fail on the PR head. Bun reports it as a failure when the gap
 * is fixed, so whoever fixes it flips it to `test`. Plain `test` = a hazard the
 * PR handles correctly, kept as a regression guard.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getChildTasks,
  getDbClient,
  getTaskById,
  initDb,
  reclaimTask,
  startTask,
} from "../be/db";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import { handleActiveSessions } from "../http/active-sessions";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-heartbeat-qa-edge-cases.sqlite";
const RUNTIME_A = "qa-runtime-a-0000";
const RUNTIME_B = "qa-runtime-b-1111";

const minutesAgo = (min: number) => new Date(Date.now() - min * 60 * 1000).toISOString();

let server: Server;
let baseUrl: string;

async function api(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

const as = (agentId: string, runtime: string) => ({
  "X-Agent-ID": agentId,
  "X-Runtime-Instance-ID": runtime,
});

const worker = (name: string) => createAgent({ name, isLead: false, status: "busy", maxTasks: 2 });

/** Attempt 0 started on runtime A, reclaimed, restarted by runtime B: B holds attempt 1. */
async function replacedByB(agentId: string) {
  const task = await createTaskExtended(`QA work ${crypto.randomUUID()}`, { agentId });
  await startTask(task.id, { runtimeInstanceId: RUNTIME_A });
  const row = await getTaskById(task.id);
  const reclaimed = await reclaimTask(task.id, {
    expectedAttempt: 0,
    expectedLastUpdatedAt: row!.lastUpdatedAt,
    observedSessionHeartbeatAt: null,
    reason: "qa stall",
  });
  expect(reclaimed?.attempt).toBe(1);
  await startTask(task.id, { runtimeInstanceId: RUNTIME_B });
  return task;
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "qa-edge-cases" });
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    const callerAgentId = req.headers["x-agent-id"] as string | undefined;
    try {
      if (await handleActiveSessions(req, res, pathSegments, query, callerAgentId)) return;
      if (await handleTasks(req, res, pathSegments, query, callerAgentId)) return;
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("QA-1 (P2): worker write routes the attempt fence does not cover", () => {
  test.failing(
    "POST /api/tasks/:id/progress from the old runtime cannot overwrite the replacement's progress",
    async () => {
      const agent = await worker("qa1-progress");
      const task = await replacedByB(agent.id);
      await api("POST", `/api/tasks/${task.id}/progress`, as(agent.id, RUNTIME_B), {
        progress: "attempt 1 progress",
      });

      const stale = await api("POST", `/api/tasks/${task.id}/progress`, as(agent.id, RUNTIME_A), {
        progress: "STALE attempt 0 progress",
      });
      expect(stale.status).toBeGreaterThanOrEqual(400);
      expect((await getTaskById(task.id))?.progress).toBe("attempt 1 progress");
    },
  );

  test.failing(
    "PUT /api/tasks/:id/session from the old runtime cannot overwrite the replacement's provider session",
    async () => {
      const agent = await worker("qa1-session");
      const task = await replacedByB(agent.id);
      await api("PUT", `/api/tasks/${task.id}/session`, as(agent.id, RUNTIME_B), {
        claudeSessionId: "session-of-attempt-1",
        provider: "claude",
      });

      const stale = await api("PUT", `/api/tasks/${task.id}/session`, as(agent.id, RUNTIME_A), {
        claudeSessionId: "STALE-session-of-attempt-0",
        provider: "claude",
      });
      expect(stale.status).toBeGreaterThanOrEqual(400);
      expect((await getTaskById(task.id))?.claudeSessionId).toBe("session-of-attempt-1");
    },
  );

  test.failing(
    "POST /api/active-sessions from the old runtime cannot register a session for the replacement's task",
    async () => {
      const agent = await worker("qa1-session-create");
      const task = await replacedByB(agent.id);
      const stale = await api("POST", "/api/active-sessions", as(agent.id, RUNTIME_A), {
        agentId: agent.id,
        taskId: task.id,
        triggerType: "task_assigned",
        runtimeInstanceId: RUNTIME_A,
      });
      expect(stale.status).toBeGreaterThanOrEqual(400);
    },
  );
});

describe("QA-2 (P2): recover-orphaned-tasks bypasses the attempt counter", () => {
  test.failing(
    "a sibling runtime booting for the same agent does not reset the other runtime's live attempt",
    async () => {
      const agent = await worker("qa2-recover");
      const task = await createTaskExtended(`QA live ${crypto.randomUUID()}`, {
        agentId: agent.id,
      });
      // Runtime A started it 3 minutes ago; its harness has not registered a
      // session or reported a provider session id yet.
      await startTask(task.id, { runtimeInstanceId: RUNTIME_A });
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        minutesAgo(3),
        task.id,
      ]);

      // Runtime B of the same agent boots and runs the runner's boot recovery.
      const recover = await api(
        "POST",
        "/api/active-sessions/recover-orphaned-tasks",
        as(agent.id, RUNTIME_B),
        { agentId: agent.id, minAgeSeconds: 60 },
      );
      expect(recover.status).toBe(200);

      const after = await getTaskById(task.id);
      expect(after?.status).toBe("in_progress");
    },
  );
});

describe("QA-3 (P3): a superseded row without a resume child", () => {
  test.failing(
    "the heartbeat repairs a row left `superseded` with no continuation (legacy crash window)",
    async () => {
      const agent = await worker("qa3-orphan");
      const task = await createTaskExtended(`QA orphan ${crypto.randomUUID()}`, {
        agentId: agent.id,
      });
      await startTask(task.id, { runtimeInstanceId: RUNTIME_A });
      // Shape the pre-upgrade non-atomic supersede leaves if the API dies
      // between `supersedeTask` and `createResumeFollowUp`.
      await getDbClient().run(
        "UPDATE agent_tasks SET status = 'superseded', lastUpdatedAt = ? WHERE id = ?",
        [minutesAgo(30), task.id],
      );

      await codeLevelTriage();
      await codeLevelTriage();

      expect((await getChildTasks(task.id)).length).toBeGreaterThan(0);
    },
  );
});

describe("QA-4 (P3): retry budget across the upgrade", () => {
  test.failing(
    "a legacy resume row already at the generation cap is failed, not given a fresh budget",
    async () => {
      const agent = await worker("qa4-budget");
      const task = await createTaskExtended(`QA gen3 ${crypto.randomUUID()}`, {
        agentId: agent.id,
        taskType: "resume",
        tags: ["auto-resume", "reason:crash_recovery", "resume-generation:3"],
      });
      await startTask(task.id, { runtimeInstanceId: RUNTIME_A });
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        minutesAgo(10),
        task.id,
      ]);

      await codeLevelTriage();

      // Old chain: generation 3 of 3 (HEARTBEAT_MAX_RESUME_GENERATIONS) has no
      // budget left. New code reads only `attempt`, which starts at 0.
      expect((await getTaskById(task.id))?.status).toBe("failed");
    },
  );
});

describe("regression guards (handled correctly by the PR)", () => {
  test("two workers racing to claim an unpinned reclaimed row: exactly one wins, attempt survives", async () => {
    const owner = await worker("guard-owner");
    const c1 = await worker("guard-c1");
    const c2 = await worker("guard-c2");
    const task = await createTaskExtended(`QA race ${crypto.randomUUID()}`, { agentId: owner.id });
    await startTask(task.id, { runtimeInstanceId: RUNTIME_A });
    const row = await getTaskById(task.id);
    await reclaimTask(task.id, {
      expectedAttempt: 0,
      expectedLastUpdatedAt: row!.lastUpdatedAt,
      observedSessionHeartbeatAt: null,
      reason: "qa stall",
    });
    // Unpin as the heartbeat does.
    await getDbClient().run(
      "UPDATE agent_tasks SET status = 'unassigned', agentId = NULL WHERE id = ?",
      [task.id],
    );

    const claims = await Promise.all([
      claimTask(task.id, c1.id, { runtimeInstanceId: "rt-c1" }),
      claimTask(task.id, c2.id, { runtimeInstanceId: "rt-c2" }),
      claimTask(task.id, c1.id, { runtimeInstanceId: "rt-c1" }),
      claimTask(task.id, c2.id, { runtimeInstanceId: "rt-c2" }),
    ]);
    expect(claims.filter(Boolean).length).toBe(1);
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("in_progress");
    expect(after?.attempt).toBe(1);
  });

  test("a pause request from the old runtime after replacement is refused (403), row untouched", async () => {
    const agent = await worker("guard-pause");
    const task = await replacedByB(agent.id);
    const stale = await api("POST", `/api/tasks/${task.id}/pause`, as(agent.id, RUNTIME_A));
    expect(stale.status).toBe(403);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });
});
