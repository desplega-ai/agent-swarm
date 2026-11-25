// Trigger group: session summary maintenance (session_members, session_summaries).
// Covers:
//   session_task_insert (a root opens a session, a child joins it),
//   session_task_open (openTaskCount follows terminal transitions),
//   session_task_activity (latestStatus and lastActivityAt follow task writes),
//   session_root_columns (the summary copies the root's key and requester),
//   session_task_human (a requester change recomputes the summary),
//   session_approval_insert, session_approval_update (pendingApprovalCount, lastHumanAt),
//   session_steering_insert (a user's steering message is human activity),
//   session_summary_recompute_apply (the recompute every trigger above queues).
// Unreachable:
//   session_task_delete: no API deletes an agent_tasks row.
//   session_task_activity_rewind: no API moves a task's lastUpdatedAt backwards.
//   session_approval_delete: only the workflow-run retention sweep deletes approval rows.
//   session_steering_delete: steering rows go only with their task, which is never deleted.
//   session_steering_update: the only reachable change carries a message to a wake or retry
//     task in the same session, which leaves the summary unchanged.
import { sql } from "../db";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

type Summary = {
  key: string;
  requestedByUserId: string | null;
  chainCount: number;
  openTaskCount: number;
  pendingApprovalCount: number;
  latestStatus: string;
  lastActivityAt: string;
  lastHumanAt: string | null;
};

function summary(ctx: ScenarioContext, rootId: string): Summary {
  const row = ctx.db.get<Summary>(
    sql`SELECT "key" AS key, "requestedByUserId", "chainCount", "openTaskCount",
          "pendingApprovalCount", "latestStatus", "lastActivityAt", "lastHumanAt"
        FROM session_summaries WHERE "rootId" = ${rootId}`,
  );
  expect(row, `no session summary for root ${rootId}`);
  return { ...row, chainCount: Number(row.chainCount), openTaskCount: Number(row.openTaskCount) };
}

function task(ctx: ScenarioContext, id: string) {
  const row = ctx.db.get<{ createdAt: string; lastUpdatedAt: string; status: string }>(
    sql`SELECT "createdAt", "lastUpdatedAt", status FROM agent_tasks WHERE id = ${id}`,
  );
  expect(row, `no task row ${id}`);
  return row;
}

const TERMINAL = ["completed", "failed", "cancelled", "superseded"];

/** The session's tasks, newest activity first. */
function chain(ctx: ScenarioContext, rootId: string) {
  return ctx.db.query<{ id: string; lastUpdatedAt: string; status: string }>(
    sql`SELECT t.id, t."lastUpdatedAt", t.status
        FROM session_members m JOIN agent_tasks t ON t.id = m."taskId"
        WHERE m."rootId" = ${rootId}
        ORDER BY t."lastUpdatedAt" DESC, t.id`,
  );
}

/** The chain aggregates the summary must equal, computed from the task rows. */
function expectChainAggregates(ctx: ScenarioContext, rootId: string, label: string): Summary {
  const rows = chain(ctx, rootId);
  const s = summary(ctx, rootId);
  const newest = rows[0];
  // Two writes in one millisecond tie on lastUpdatedAt: either one's status is the latest.
  const tied = rows.filter((row) => row.lastUpdatedAt === newest?.lastUpdatedAt);
  expect(
    newest !== undefined &&
      s.chainCount === rows.length &&
      s.openTaskCount === rows.filter((row) => !TERMINAL.includes(row.status)).length &&
      s.lastActivityAt === newest.lastUpdatedAt &&
      tied.some((row) => row.status === s.latestStatus),
    `${label}: summary ${JSON.stringify(s)} does not match the chain ${JSON.stringify(rows)}`,
  );
  return s;
}

async function createUser(ctx: ScenarioContext, label: string): Promise<string> {
  const response = await ctx.api("POST", "/api/users", {
    body: { name: `Trigger session ${label} ${ctx.nonce}`, status: "active" },
  });
  expectStatus(response, [200], `create user ${label}`);
  return asString(asRecord(asRecord(response.json).user).id, `${label} id`);
}

export const triggerSessionMaintenance: Scenario = {
  name: "trigger-session-maintenance",
  order: 9_330,
  async run(ctx) {
    const registered = await ctx.api("POST", "/api/agents", {
      body: { name: `trg-sess-worker-${ctx.nonce}`, role: "worker", status: "online" },
    });
    expectStatus(registered, [201], "register a worker");
    const workerId = asString(asRecord(registered.json).id, "worker id");
    const source = await createUser(ctx, "source");
    const target = await createUser(ctx, "target");
    const base = `shared/trg-sess-${ctx.nonce}`;
    const create = async (label: string, extra: Record<string, unknown>) => {
      const response = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `session ${label} ${ctx.nonce}`,
          agentId: workerId,
          routingReason: "human_pinned",
          source: "api",
          key: `${base}/a/`,
          ...extra,
        },
      });
      expectStatus(response, [201], `create ${label}`);
      return asString(asRecord(response.json).id, `${label} id`);
    };
    const taskIds: string[] = [];

    try {
      // ── insert: a root opens a session, a child joins it ───────────────────
      const rootId = await create("root", { requestedByUserId: source });
      taskIds.push(rootId);
      let s = summary(ctx, rootId);
      const root = task(ctx, rootId);
      expect(
        s.chainCount === 1 &&
          s.openTaskCount === 1 &&
          s.pendingApprovalCount === 0 &&
          s.latestStatus === root.status &&
          s.lastActivityAt === root.lastUpdatedAt &&
          s.key === `${base}/a/` &&
          s.requestedByUserId === source &&
          s.lastHumanAt === root.createdAt,
        `a new root's summary: ${JSON.stringify(s)}`,
      );

      const childId = await create("child", { parentTaskId: rootId });
      taskIds.push(childId);
      const member = ctx.db.get<{ rootId: string }>(
        sql`SELECT "rootId" FROM session_members WHERE "taskId" = ${childId}`,
      );
      expect(member?.rootId === rootId, "the child joins its root's session");
      s = expectChainAggregates(ctx, rootId, "a child joins");
      expect(
        s.chainCount === 2 && s.openTaskCount === 2 && s.lastHumanAt === root.createdAt,
        `a child joins the summary: ${JSON.stringify(s)}`,
      );

      // ── a user's steering message is human activity ────────────────────────
      let response = await ctx.api("POST", `/api/tasks/${childId}/steer`, {
        body: {
          message: `steer ${ctx.nonce}`,
          mode: "queue",
          source: "ui",
          requestedByUserId: source,
        },
      });
      expectStatus(response, [200], "steer the child as a user");
      const steering = ctx.db.get<{ created_at: string }>(
        sql`SELECT created_at FROM task_steering_messages
            WHERE task_id = ${childId} AND created_by_kind = 'user'`,
      );
      expect(steering, "the steering message is stored as a user's");
      s = summary(ctx, rootId);
      expect(
        s.lastHumanAt === steering.created_at,
        `lastHumanAt moves to the steering message: ${JSON.stringify(s)}`,
      );

      // ── a pending approval counts, a cancelled one does not ────────────────
      response = await ctx.api("POST", "/api/approval-requests", {
        agentId: workerId,
        body: {
          title: `Trigger approval ${ctx.nonce}`,
          questions: [{ id: "go", type: "approval", label: "Go?", required: true }],
          approvers: { policy: "any" },
          sourceTaskId: childId,
        },
      });
      expectStatus(response, [201], "raise an approval on the child");
      const approval = asRecord(asRecord(response.json).approvalRequest);
      const approvalId = asString(approval.id, "approval id");
      const approvalAt = ctx.db.get<{ createdAt: string }>(
        sql`SELECT "createdAt" FROM approval_requests WHERE id = ${approvalId}`,
      )?.createdAt;
      s = summary(ctx, rootId);
      expect(
        s.pendingApprovalCount === 1 && s.lastHumanAt === approvalAt,
        `a pending approval counts and is the newest human event: ${JSON.stringify(s)}`,
      );
      response = await ctx.api("POST", `/api/approval-requests/${approvalId}/cancel`, {
        body: { reason: "trigger scenario" },
      });
      expectStatus(response, [200], "cancel the approval");
      s = summary(ctx, rootId);
      expect(
        s.pendingApprovalCount === 0 && s.lastHumanAt === steering.created_at,
        `a cancelled approval leaves the summary: ${JSON.stringify(s)}`,
      );

      // ── a terminal child closes one open task ──────────────────────────────
      // Cancelling a task with a queued user message promotes that message to a new task in
      // the same session, so the expected values come from the chain rows.
      const openBefore = summary(ctx, rootId).openTaskCount;
      response = await ctx.api("POST", `/api/tasks/${childId}/cancel`, {
        body: { reason: "trigger scenario" },
      });
      expectStatus(response, [200], "cancel the child");
      expect(task(ctx, childId).status === "cancelled", "the child is cancelled");
      s = expectChainAggregates(ctx, rootId, "after the child's cancel");
      const promoted = chain(ctx, rootId).filter((row) => ![rootId, childId].includes(row.id));
      taskIds.push(...promoted.map((row) => row.id));
      expect(
        s.openTaskCount === openBefore - 1 + promoted.length,
        `the cancel closes exactly one open task: ${JSON.stringify(s)}`,
      );
      const humanBeforeMerge = s.lastHumanAt;

      // ── root columns: a key move and a requester merge reach the summary ───
      response = await ctx.api("PATCH", `/api/assets/task/${rootId}/key`, {
        body: { key: `${base}/b/`, cascade: true },
      });
      expectStatus(response, [200], "move the session");
      expect(summary(ctx, rootId).key === `${base}/b/`, "the summary follows the root's key");

      response = await ctx.api("POST", `/api/users/${target}/merge`, {
        body: { sourceUserId: source },
      });
      expectStatus(response, [202], "merge the requester into another user");
      const jobId = asString(asRecord(asRecord(response.json).job).id, "merge job id");
      const merged = await pollUntil(async () => {
        const job = await ctx.api("GET", `/api/users/merge-jobs/${jobId}`);
        expectStatus(job, [200], "read the merge job");
        const status = asRecord(asRecord(job.json).job).status;
        expect(status !== "failed", `the merge job failed: ${job.text}`);
        return status === "done";
      }, 30_000);
      expect(merged, "the merge job never finished");
      s = expectChainAggregates(ctx, rootId, "after the merge");
      expect(
        s.requestedByUserId === target && s.lastHumanAt === humanBeforeMerge,
        `the summary follows the root's new requester: ${JSON.stringify(s)}`,
      );

      // ── cancelling every open task closes the session ──────────────────────
      for (const row of chain(ctx, rootId)) {
        if (TERMINAL.includes(row.status)) continue;
        response = await ctx.api("POST", `/api/tasks/${row.id}/cancel`, {
          body: { reason: "trigger scenario" },
        });
        expectStatus(response, [200], `cancel ${row.id}`);
      }
      s = expectChainAggregates(ctx, rootId, "after closing the session");
      expect(
        s.openTaskCount === 0 && s.latestStatus === "cancelled",
        `a closed session has no open task: ${JSON.stringify(s)}`,
      );
    } finally {
      for (const id of taskIds) {
        await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: { reason: "trigger cleanup" } });
      }
      await ctx.api("POST", "/close", { agentId: workerId, body: {} });
    }
  },
};
