/**
 * Background user merges (src/be/user-merge-jobs.ts) and the 202 contract of
 * POST /api/users/:id/merge.
 *
 * The HTTP harness mirrors http-users.test.ts: a node http.Server running
 * `handleCore → handleUsers`, so the bearer gate, the operator actor and the
 * route() matching are the production ones.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createScheduledTask,
  createUser,
  createWorkflow,
  createWorkflowRun,
  deleteUser,
  getDbClient,
  getScheduledTaskById,
  getUserById,
  getWorkflowRun,
  initDb,
  updateWorkflowRun,
} from "../be/db";
import {
  assertNotLastAdmin,
  ensureRbacSeedsSynced,
  LastAdminError,
  setUserRoles,
} from "../be/rbac-roles";
import {
  clearUserMergeRetryTimersForTests,
  createUserMergeJob,
  getUserMergeJob,
  listUserMergeJobs,
  pauseUserMergeRunnerForTests,
  resumeUserMergeJobs,
  runUserMergeJobs,
  USER_MERGE_MAX_ATTEMPTS,
} from "../be/user-merge-jobs";
import {
  findUserByEmail,
  findUserByExternalId,
  findUsersByName,
  fingerprintApiKey,
  linkIdentity,
  mintToken,
} from "../be/users";
import { handleCore } from "../http/core";
import { handleUsers } from "../http/users";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = `./test-user-merge-jobs-${crypto.randomUUID()}.sqlite`;
const API_KEY = "example-test-merge-jobs-key";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleUsers(req, res, pathSegments, queryParams);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let server: Server;
let port: number;
const ORIGINAL_API_KEY = process.env.AGENT_SWARM_API_KEY;
const OPERATOR = { kind: "operator" as const, id: fingerprintApiKey(API_KEY) };

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  server = createTestServer(API_KEY);
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  pauseUserMergeRunnerForTests(false);
  clearUserMergeRetryTimersForTests();
  await runUserMergeJobs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.AGENT_SWARM_API_KEY;
  } else {
    process.env.AGENT_SWARM_API_KEY = ORIGINAL_API_KEY;
  }
});

beforeEach(async () => {
  pauseUserMergeRunnerForTests(false);
  clearUserMergeRetryTimersForTests();
  await runUserMergeJobs();
  const client = getDbClient();
  for (const table of [
    "user_merge_jobs",
    "user_identity_events",
    "user_external_ids",
    "user_tokens",
    "workflow_run_steps",
    "workflow_runs",
    "workflows",
    "scheduled_tasks",
    "kv_entries",
    "users",
  ]) {
    await client.run(`DELETE FROM ${table}`);
  }
});

function authedFetch(path: string, init: RequestInit = {}, bearer = API_KEY): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return fetch(`http://localhost:${port}${path}`, { ...init, headers });
}

type JobBody = {
  job: {
    id: string;
    status: string;
    sourceUserId: string;
    targetUserId: string;
    progress: Record<string, number>;
    error: string | null;
    attempts: number;
  };
};

/** Poll until the job leaves the pending and running states, or give up after `ms`. */
async function waitForJobToSettle(jobId: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const job = await getUserMergeJob(jobId);
    if (job && job.status !== "pending" && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getUserMergeJob(jobId);
}

async function mergeViaRoute(targetId: string, sourceId: string): Promise<Response> {
  return authedFetch(`/api/users/${targetId}/merge`, {
    method: "POST",
    body: JSON.stringify({ sourceUserId: sourceId }),
  });
}

/** `count` kv rows attributed to `userId` (kv_entries is WITHOUT ROWID, so it exercises the PK batch key). */
async function seedKvRows(userId: string, count: number): Promise<void> {
  const client = getDbClient();
  for (let i = 0; i < count; i++) {
    await client.run(
      `INSERT INTO kv_entries (namespace, key, value, value_type, created_at, updated_at, created_by, updated_by)
       VALUES ('merge-test', ?, '1', 'integer', 0, 0, ?, ?)`,
      [`k${i}`, userId, userId],
    );
  }
}

async function countKvRowsOwnedBy(userId: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM kv_entries WHERE created_by = ? OR updated_by = ?",
    [userId, userId],
  );
  return row?.n ?? 0;
}

async function seedRequestedRuns(userId: string, count: number): Promise<string[]> {
  const workflow = await createWorkflow({
    name: `merge-jobs-${crypto.randomUUID()}`,
    definition: { nodes: [] },
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const runId = crypto.randomUUID();
    await createWorkflowRun({
      id: runId,
      workflowId: workflow.id,
      triggerType: "manual",
      createdBy: userId,
    });
    await updateWorkflowRun(runId, {
      status: "running",
      context: { swarm: { requestedByUserId: userId }, input: { i } },
    });
    ids.push(runId);
  }
  return ids;
}

describe("runUserMergeJobs", () => {
  test("completes the job, moves every reference and deletes the source", async () => {
    const target = await createUser({ name: "Target", email: "target@x.com" });
    const source = await createUser({ name: "Source", email: "source@x.com" });
    const runIds = await seedRequestedRuns(source.id, 3);
    await seedKvRows(source.id, 4);
    const schedule = await createScheduledTask({
      name: `merge-jobs-schedule-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      taskTemplate: "Run it",
      createdBy: source.id,
    });

    const job = await createUserMergeJob({ sourceUserId: source.id, targetUserId: target.id });
    expect(job.status).toBe("pending");
    await runUserMergeJobs({ pace: false });

    const done = await getUserMergeJob(job.id);
    expect(done?.status).toBe("done");
    expect(done?.error).toBeNull();
    expect(done?.phase).toBe("delete-user");
    expect(done?.startedAt).not.toBeNull();
    expect(done?.finishedAt).not.toBeNull();
    expect(done?.progress["workflow-context"]).toBe(3);
    expect(done?.progress["workflow_runs.created_by"]).toBe(3);
    expect(done?.progress["kv_entries.created_by"]).toBe(4);
    expect(done?.progress["kv_entries.updated_by"]).toBe(4);
    expect(done?.progress["scheduled_tasks.created_by"]).toBe(1);
    expect(done?.progress["delete-user"]).toBe(1);
    // Columns with no rows for the source are not listed.
    expect(done?.progress["agents.created_by"]).toBeUndefined();

    expect(await getUserById(source.id)).toBeNull();
    expect(await countKvRowsOwnedBy(source.id)).toBe(0);
    expect(await countKvRowsOwnedBy(target.id)).toBe(4);
    for (const runId of runIds) {
      const run = await getWorkflowRun(runId);
      expect(run?.createdBy).toBe(target.id);
      expect(
        (run?.context as { swarm: { requestedByUserId: string } }).swarm.requestedByUserId,
      ).toBe(target.id);
    }
    expect((await getScheduledTaskById(schedule.id))?.createdBy).toBe(target.id);
  });

  test("respects the batch size and commits one batch per transaction", async () => {
    const target = await createUser({ name: "BatchTarget" });
    const source = await createUser({ name: "BatchSource" });
    await seedKvRows(source.id, 7);
    await seedRequestedRuns(source.id, 5);

    const batches: Array<{ phase: string; changes: number }> = [];
    const job = await createUserMergeJob({ sourceUserId: source.id, targetUserId: target.id });
    await runUserMergeJobs({
      batchSize: 3,
      pace: false,
      afterBatch: ({ phase, changes }) => {
        batches.push({ phase, changes });
      },
    });

    expect((await getUserMergeJob(job.id))?.status).toBe("done");
    const sizes = (phase: string) => batches.filter((b) => b.phase === phase).map((b) => b.changes);
    expect(sizes("workflow-context")).toEqual([3, 2]);
    expect(sizes("kv_entries.created_by")).toEqual([3, 3, 1]);
    expect(sizes("kv_entries.updated_by")).toEqual([3, 3, 1]);
    expect(sizes("workflow_runs.created_by")).toEqual([3, 2]);
    expect(batches.every((b) => b.changes <= 3)).toBe(true);
  });

  test("a job interrupted mid-way waits for a retry and finishes on resume", async () => {
    const target = await createUser({ name: "ResumeTarget" });
    const source = await createUser({ name: "ResumeSource" });
    await seedKvRows(source.id, 10);
    const runIds = await seedRequestedRuns(source.id, 4);

    const committed: Array<{ phase: string; changes: number }> = [];
    const job = await createUserMergeJob({ sourceUserId: source.id, targetUserId: target.id });
    await runUserMergeJobs({
      batchSize: 2,
      pace: false,
      retryDelayMs: () => 60_000,
      afterBatch: (info) => {
        committed.push(info);
        if (committed.length === 3) throw new Error("simulated crash after batch 3");
      },
    });

    // The failed attempt goes back to pending with a backoff, not to failed.
    const failed = await getUserMergeJob(job.id);
    expect(failed?.status).toBe("pending");
    expect(failed?.attempts).toBe(1);
    expect(failed?.nextAttemptAt).not.toBeNull();
    expect(failed?.error).toContain("simulated crash");
    // The backoff has not passed: a plain drain leaves it alone.
    await runUserMergeJobs({ pace: false });
    expect((await getUserMergeJob(job.id))?.status).toBe("pending");
    clearUserMergeRetryTimersForTests();
    // The three committed batches stay: the 2 + 2 context runs, then the
    // first 2 rows of whichever discovered column comes first.
    expect(committed.slice(0, 2)).toEqual([
      { jobId: job.id, phase: "workflow-context", changes: 2 },
      { jobId: job.id, phase: "workflow-context", changes: 2 },
    ]);
    const third = committed[2];
    expect(third.phase).not.toBe("workflow-context");
    expect(third.changes).toBe(2);
    expect(failed?.progress["workflow-context"]).toBe(4);
    expect(failed?.progress[third.phase]).toBe(2);
    expect(await getUserById(source.id)).not.toBeNull();

    // A restart re-queues it and the remaining rows move; nothing is counted twice.
    const resumed: Array<{ phase: string; changes: number }> = [];
    await resumeUserMergeJobs({
      batchSize: 2,
      pace: false,
      afterBatch: (info) => {
        resumed.push(info);
      },
    });
    const done = await getUserMergeJob(job.id);
    expect(done?.status).toBe("done");
    expect(done?.error).toBeNull();
    expect(done?.attempts).toBe(2);
    expect(done?.nextAttemptAt).toBeNull();
    expect(done?.progress["workflow-context"]).toBe(4);
    expect(done?.progress["kv_entries.created_by"]).toBe(10);
    expect(done?.progress["kv_entries.updated_by"]).toBe(10);
    expect(resumed.filter((b) => b.phase === "workflow-context")).toEqual([]);
    // The interrupted column continues after its committed rows.
    const thirdTotal = resumed
      .filter((b) => b.phase === third.phase)
      .reduce((sum, b) => sum + b.changes, 0);
    expect(thirdTotal + 2).toBe(done?.progress[third.phase]);
    expect(
      resumed.filter((b) => b.phase === "kv_entries.updated_by").map((b) => b.changes),
    ).toEqual([2, 2, 2, 2, 2]);
    expect(await getUserById(source.id)).toBeNull();
    expect(await countKvRowsOwnedBy(target.id)).toBe(10);
    for (const runId of runIds) {
      expect((await getWorkflowRun(runId))?.createdBy).toBe(target.id);
    }
  });

  test("a job whose source is already gone completes without changes", async () => {
    const target = await createUser({ name: "GoneTarget" });
    const job = await createUserMergeJob({ sourceUserId: "no-such-user", targetUserId: target.id });
    await runUserMergeJobs({ pace: false });
    const done = await getUserMergeJob(job.id);
    expect(done?.status).toBe("done");
    expect(done?.progress["delete-user"]).toBe(0);
  });

  test("a job whose target is gone fails for good and is not re-queued on boot", async () => {
    const source = await createUser({ name: "OrphanSource" });
    const job = await createUserMergeJob({ sourceUserId: source.id, targetUserId: "no-such-user" });
    await runUserMergeJobs({ pace: false });
    const failed = await getUserMergeJob(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);
    expect(failed?.error).toBe("Target user not found");
    expect(await getUserById(source.id)).not.toBeNull();

    await resumeUserMergeJobs({ pace: false });
    const afterBoot = await getUserMergeJob(job.id);
    expect(afterBoot?.status).toBe("failed");
    expect(afterBoot?.attempts).toBe(1);
  });

  test("a job that keeps failing is marked failed after the attempt cap", async () => {
    const target = await createUser({ name: "CapTarget" });
    const source = await createUser({ name: "CapSource" });
    await seedKvRows(source.id, 3);
    // The batches are idempotent, so only the final delete can fail on every
    // attempt: block it the way a constraint would.
    await getDbClient().run(
      `CREATE TRIGGER merge_test_block_delete BEFORE DELETE ON users
       BEGIN SELECT RAISE(ABORT, 'delete blocked'); END`,
    );
    try {
      const job = await createUserMergeJob({ sourceUserId: source.id, targetUserId: target.id });
      await runUserMergeJobs({ pace: false, retryDelayMs: () => 1 });
      // The retry timers drive the later attempts.
      const settled = await waitForJobToSettle(job.id);
      expect(settled?.status).toBe("failed");
      expect(settled?.attempts).toBe(USER_MERGE_MAX_ATTEMPTS);
      expect(settled?.error).toContain("delete blocked");
      expect(settled?.phase).toBe("delete-user");
      expect(settled?.finishedAt).not.toBeNull();
      // The rows moved exactly once and the source row is still there.
      expect(settled?.progress["kv_entries.created_by"]).toBe(3);
      expect(await countKvRowsOwnedBy(target.id)).toBe(3);
      expect(await getUserById(source.id)).not.toBeNull();
    } finally {
      await getDbClient().run("DROP TRIGGER IF EXISTS merge_test_block_delete");
    }
  });

  test("rows written while the job runs are swept before the source is deleted", async () => {
    const target = await createUser({ name: "SweepTarget" });
    const source = await createUser({ name: "SweepSource" });
    await seedKvRows(source.id, 7);
    const batchSize = 3;

    // A writer that still holds the source id in memory (a running workflow,
    // an agent task) inserts after the kv updated_by pass ends: one more kv
    // row (both audit columns) and one more requested workflow run.
    let lateWrite = false;
    const job = await createUserMergeJob({ sourceUserId: source.id, targetUserId: target.id });
    await runUserMergeJobs({
      batchSize,
      pace: false,
      afterBatch: async ({ phase, changes }) => {
        if (phase !== "kv_entries.updated_by" || changes >= batchSize || lateWrite) return;
        lateWrite = true;
        await getDbClient().run(
          `INSERT INTO kv_entries (namespace, key, value, value_type, created_at, updated_at, created_by, updated_by)
           VALUES ('merge-test', 'late', '1', 'integer', 0, 0, ?, ?)`,
          [source.id, source.id],
        );
        await seedRequestedRuns(source.id, 1);
      },
    });

    expect(lateWrite).toBe(true);
    const done = await getUserMergeJob(job.id);
    expect(done?.status).toBe("done");
    expect(done?.error).toBeNull();
    expect(done?.progress["delete-user"]).toBe(1);
    // The pass saw 7 rows; the final sweep moved the late one.
    expect(done?.progress["kv_entries.updated_by"]).toBe(8);
    expect(done?.progress["kv_entries.created_by"]).toBe(8);
    expect(done?.progress["workflow-context"]).toBe(1);
    expect(done?.progress["workflow_runs.created_by"]).toBe(1);
    expect(await getUserById(source.id)).toBeNull();
    expect(await countKvRowsOwnedBy(source.id)).toBe(0);
    expect(await countKvRowsOwnedBy(target.id)).toBe(8);
    const lateRun = await getDbClient().get<{ created_by: string; requester: string }>(
      `SELECT created_by, json_extract(context, '$.swarm.requestedByUserId') AS requester
       FROM workflow_runs`,
    );
    expect(lateRun?.created_by).toBe(target.id);
    expect(lateRun?.requester).toBe(target.id);
  });

  test("listUserMergeJobs filters by status", async () => {
    const a = await createUser({ name: "ListA" });
    const b = await createUser({ name: "ListB" });
    pauseUserMergeRunnerForTests(true);
    const job = await createUserMergeJob({ sourceUserId: a.id, targetUserId: b.id });
    expect((await listUserMergeJobs({ status: "pending" })).map((j) => j.id)).toEqual([job.id]);
    expect(await listUserMergeJobs({ status: "done" })).toEqual([]);
    pauseUserMergeRunnerForTests(false);
    await runUserMergeJobs({ pace: false });
    expect((await listUserMergeJobs({ status: "done" })).map((j) => j.id)).toEqual([job.id]);
  });
});

describe("POST /api/users/:id/merge", () => {
  test("returns 202 with the job, GET returns it, and the job finishes", async () => {
    const target = await createUser({ name: "RouteTarget", email: "route-target@x.com" });
    const source = await createUser({ name: "RouteSource", email: "route-source@x.com" });
    await linkIdentity(source.id, "slack", "U_ROUTE", OPERATOR);

    const r = await mergeViaRoute(target.id, source.id);
    expect(r.status).toBe(202);
    const { job } = (await r.json()) as JobBody;
    expect(job.sourceUserId).toBe(source.id);
    expect(job.targetUserId).toBe(target.id);

    const polled = await authedFetch(`/api/users/merge-jobs/${job.id}`);
    expect(polled.status).toBe(200);
    expect(((await polled.json()) as JobBody).job.id).toBe(job.id);

    await runUserMergeJobs();
    const final = await authedFetch(`/api/users/merge-jobs/${job.id}`);
    expect(((await final.json()) as JobBody).job.status).toBe("done");
    expect((await authedFetch(`/api/users/${source.id}`)).status).toBe(404);

    const list = await authedFetch("/api/users/merge-jobs");
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id),
    ).toContain(job.id);
    expect((await authedFetch("/api/users/merge-jobs", {}, "wrong-key")).status).toBe(401);
  });

  test("while the job is pending the source resolves to the target and cannot authenticate", async () => {
    const target = await createUser({ name: "PendingTarget", email: "pending-target@x.com" });
    const source = await createUser({
      name: "PendingSource",
      email: "pending-source@x.com",
      emailAliases: ["pending-alias@x.com"],
    });
    await linkIdentity(source.id, "slack", "U_PENDING", OPERATOR);
    const { plaintext } = await mintToken(source.id, "cli", OPERATOR);
    const before = await authedFetch("/api/whoami", {}, plaintext);
    expect(before.status).toBe(200);

    pauseUserMergeRunnerForTests(true);
    try {
      const r = await mergeViaRoute(target.id, source.id);
      expect(r.status).toBe(202);
      const { job } = (await r.json()) as JobBody;
      expect(job.status).toBe("pending");

      // The source row is still there, marked.
      const sourceNow = await getUserById(source.id);
      expect(sourceNow?.mergedIntoUserId).toBe(target.id);
      const sourceR = await authedFetch(`/api/users/${source.id}`);
      expect(sourceR.status).toBe(200);
      expect(
        ((await sourceR.json()) as { user: { mergedIntoUserId?: string } }).user.mergedIntoUserId,
      ).toBe(target.id);

      // Every identity lookup lands on the target.
      expect((await findUserByExternalId("slack", "U_PENDING"))?.id).toBe(target.id);
      expect((await findUserByEmail("pending-source@x.com"))?.id).toBe(target.id);
      expect((await findUserByEmail("pending-alias@x.com"))?.id).toBe(target.id);
      expect((await findUsersByName("PendingSource")).map((u) => u.id)).toEqual([]);

      // The source's tokens were revoked by the short phase, and a token that
      // still names the source is refused by the auth gate.
      expect((await authedFetch("/api/whoami", {}, plaintext)).status).toBe(401);
      const { plaintext: late } = await mintToken(source.id, "late", OPERATOR);
      expect((await authedFetch("/api/whoami", {}, late)).status).toBe(401);

      // A second merge touching either user is refused.
      const other = await createUser({ name: "PendingOther" });
      const again = await mergeViaRoute(other.id, source.id);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe("merge_in_progress");
      expect((await mergeViaRoute(target.id, other.id)).status).toBe(409);
    } finally {
      pauseUserMergeRunnerForTests(false);
    }

    await runUserMergeJobs({ pace: false });
    expect(await getUserById(source.id)).toBeNull();
    expect((await findUserByExternalId("slack", "U_PENDING"))?.id).toBe(target.id);
  });

  test("400 on self-merge, 404 on unknown users", async () => {
    const u = await createUser({ name: "Self" });
    expect((await mergeViaRoute(u.id, u.id)).status).toBe(400);
    expect((await mergeViaRoute(u.id, "no-such-user")).status).toBe(404);
    expect((await mergeViaRoute("no-such-user", u.id)).status).toBe(404);
    expect(
      (await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM user_merge_jobs"))?.n,
    ).toBe(0);
  });

  test("409 last_admin when the source is the only admin, and nothing is queued", async () => {
    ensureRbacSeedsSynced({ quiet: true });
    const admin = await createUser({ name: "OnlyAdmin" });
    const viewer = await createUser({ name: "Viewer" });
    await setUserRoles(admin.id, ["admin"], null);
    await setUserRoles(viewer.id, ["viewer"], null);

    const r = await mergeViaRoute(viewer.id, admin.id);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("last_admin");
    expect((await getUserById(admin.id))?.mergedIntoUserId).toBeUndefined();
    expect(
      (await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM user_merge_jobs"))?.n,
    ).toBe(0);
  });

  test("a merge source never counts as a live admin while its job is pending", async () => {
    ensureRbacSeedsSynced({ quiet: true });
    const adminA = await createUser({ name: "AdminA" });
    const adminB = await createUser({ name: "AdminB" });
    await setUserRoles(adminA.id, ["admin"], null);
    await setUserRoles(adminB.id, ["admin"], null);

    pauseUserMergeRunnerForTests(true);
    try {
      expect((await mergeViaRoute(adminB.id, adminA.id)).status).toBe(202);
      // A is marked and cannot authenticate, so B is the only real admin.
      await expect(setUserRoles(adminB.id, ["viewer"], null)).rejects.toBeInstanceOf(
        LastAdminError,
      );
      await expect(assertNotLastAdmin(adminB.id)).rejects.toBeInstanceOf(LastAdminError);
    } finally {
      pauseUserMergeRunnerForTests(false);
    }
    await runUserMergeJobs({ pace: false });
    expect(await getUserById(adminA.id)).toBeNull();
  });

  test("repeating a merge whose job failed re-queues that job", async () => {
    const target = await createUser({ name: "RetryTarget", email: "retry-target@x.com" });
    const source = await createUser({ name: "RetrySource", email: "retry-source@x.com" });
    await seedKvRows(source.id, 2);

    pauseUserMergeRunnerForTests(true);
    const first = await mergeViaRoute(target.id, source.id);
    expect(first.status).toBe(202);
    const { job } = (await first.json()) as JobBody;
    // The runner spent its attempts (simulated): the source stays marked.
    await getDbClient().run(
      "UPDATE user_merge_jobs SET status = 'failed', error = 'disk full', attempts = ? WHERE id = ?",
      [USER_MERGE_MAX_ATTEMPTS, job.id],
    );
    expect((await getUserById(source.id))?.mergedIntoUserId).toBe(target.id);

    // The same pair answers 202 with the same job, pending again.
    const again = await mergeViaRoute(target.id, source.id);
    expect(again.status).toBe(202);
    const requeued = ((await again.json()) as JobBody).job;
    expect(requeued.id).toBe(job.id);
    expect(requeued.status).toBe("pending");
    expect(requeued.error).toBeNull();
    expect(requeued.attempts).toBe(0);
    // Only one manual_merge event: the short phase did not run twice.
    const events = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM user_identity_events WHERE userId = ? AND eventType = 'manual_merge'",
      [target.id],
    );
    expect(events?.n).toBe(1);

    pauseUserMergeRunnerForTests(false);
    await runUserMergeJobs({ pace: false });
    expect((await getUserMergeJob(job.id))?.status).toBe("done");
    expect(await getUserById(source.id)).toBeNull();
    expect(await countKvRowsOwnedBy(target.id)).toBe(2);
  });

  test("a source whose target vanished can be merged into another user", async () => {
    const target = await createUser({ name: "VanishTarget", email: "vanish-target@x.com" });
    const source = await createUser({ name: "VanishSource", email: "vanish-source@x.com" });
    const other = await createUser({ name: "VanishOther", email: "vanish-other@x.com" });
    await seedKvRows(source.id, 2);

    pauseUserMergeRunnerForTests(true);
    const first = await mergeViaRoute(target.id, source.id);
    expect(first.status).toBe(202);
    const { job } = (await first.json()) as JobBody;
    // The target is deleted by the synchronous path before the job runs.
    expect(await deleteUser(target.id)).toBe(true);
    pauseUserMergeRunnerForTests(false);
    await runUserMergeJobs({ pace: false });
    const failed = await getUserMergeJob(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("Target user not found");
    expect((await getUserById(source.id))?.mergedIntoUserId).toBe(target.id);

    // The same pair cannot be re-queued (the target is gone) ...
    expect((await mergeViaRoute(target.id, source.id)).status).toBe(404);
    // ... but a new target goes through the short phase and a new job.
    const moved = await mergeViaRoute(other.id, source.id);
    expect(moved.status).toBe(202);
    const next = ((await moved.json()) as JobBody).job;
    expect(next.id).not.toBe(job.id);
    expect((await getUserById(source.id))?.mergedIntoUserId).toBe(other.id);
    await runUserMergeJobs({ pace: false });
    expect((await getUserMergeJob(next.id))?.status).toBe("done");
    expect(await getUserById(source.id)).toBeNull();
    expect(await countKvRowsOwnedBy(other.id)).toBe(2);
    expect((await findUserByEmail("vanish-source@x.com"))?.id).toBe(other.id);
  });
});
