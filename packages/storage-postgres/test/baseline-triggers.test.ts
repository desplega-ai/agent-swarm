import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createPostgresClient, type PostgresClient, runPostgresMigrations } from "../src";
import { createScratchDatabase, type ScratchDatabase } from "./scratch";

// The plpgsql trigger ports of the baseline (decision D9), at SQL level. Each
// group ports the assertions of its black-box scenario
// (scripts/e2e/scenarios/trigger-<group>.ts) and also drives the triggers that
// no API path reaches (thoughts/taras/research/2026-11-20-trigger-groups.md).
// The FTS sync group has no port: Postgres full-text search uses expression
// indexes (migration 368, test/fulltext.test.ts), which need no trigger.

const CHAIN_DIR = join(import.meta.dir, "..", "..", "..", "src", "be", "migrations", "postgres");

let scratch: ScratchDatabase;
let db: PostgresClient;
let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

beforeAll(async () => {
  scratch = await createScratchDatabase("triggers");
  db = createPostgresClient(scratch.url, { max: 4 });
  await runPostgresMigrations(db, { migrationsDir: CHAIN_DIR, log: () => {}, warn: () => {} });
}, 60_000); // applies the full baseline: a budget, not a retry

afterAll(async () => {
  await db.close();
  await scratch.drop();
});

async function user(): Promise<string> {
  const userId = id("user");
  await db.run(`INSERT INTO users (id, name) VALUES ($1, $2)`, [userId, `User ${userId}`]);
  return userId;
}

async function agent(isLead = false): Promise<string> {
  const agentId = id("agent");
  await db.run(
    `INSERT INTO agents (id, name, "isLead", status, "createdAt", "lastUpdatedAt")
     VALUES ($1, $1, $2, 'idle', statement_timestamp(), statement_timestamp())`,
    [agentId, isLead],
  );
  return agentId;
}

type TaskFields = {
  parentTaskId?: string | null;
  status?: string;
  source?: string;
  key?: string;
  requestedByUserId?: string | null;
  agentId?: string | null;
  contextKey?: string | null;
  taskType?: string | null;
  slackChannelId?: string | null;
  slackThreadTs?: string | null;
  at?: string;
};

async function task(fields: TaskFields = {}): Promise<string> {
  const taskId = id("task");
  const at = fields.at ?? new Date().toISOString();
  await db.run(
    `INSERT INTO agent_tasks (id, task, status, source, "key", "parentTaskId", "requestedByUserId",
       "agentId", "contextKey", "taskType", "slackChannelId", "slackThreadTs", "createdAt", "lastUpdatedAt")
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      taskId,
      fields.status ?? "pending",
      fields.source ?? "api",
      fields.key ?? "shared/",
      fields.parentTaskId ?? null,
      fields.requestedByUserId ?? null,
      fields.agentId ?? null,
      fields.contextKey ?? null,
      fields.taskType ?? null,
      fields.slackChannelId ?? null,
      fields.slackThreadTs ?? null,
      at,
    ],
  );
  return taskId;
}

const iso = (offsetMs: number) =>
  new Date(Date.UTC(2026, 10, 21, 10, 0, 0) + offsetMs).toISOString();
const isoOf = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

describe("asset keys", () => {
  test("a canonical key under shared/ or personal/<existing user>/ passes; others are refused", async () => {
    const owner = await user();
    for (const key of ["shared/", "shared/team/a/", `personal/${owner}/`, `personal/${owner}/x/`]) {
      await task({ key });
    }
    for (const key of [
      "",
      "shared",
      "Shared/",
      " shared/",
      "shared//a/",
      "shared/a/../b/",
      "shared/./a/",
      "shared\\a/",
      "elsewhere/",
      "personal/nobody/",
      `personal/${owner}`,
      `shared/${"a".repeat(256)}/`,
    ]) {
      await expect(task({ key })).rejects.toThrow("invalid asset namespace key");
    }
  });

  test("each table validates on insert and on a key update", async () => {
    const taskId = await task({ key: "shared/a/" });
    await expect(
      db.run(`UPDATE agent_tasks SET "key" = 'SHARED/' WHERE id = $1`, [taskId]),
    ).rejects.toThrow("invalid asset namespace key");
    await db.run(`UPDATE agent_tasks SET "key" = 'shared/b/' WHERE id = $1`, [taskId]);

    // A key update on each other validated table.
    const scheduleId = id("sched");
    await db.run(
      `INSERT INTO scheduled_tasks (id, name, "scheduleType", "taskTemplate", "createdAt", "lastUpdatedAt")
       VALUES ($1, $1, 'one_time', 't', statement_timestamp(), statement_timestamp())`,
      [scheduleId],
    );
    await expect(
      db.run(`UPDATE scheduled_tasks SET "key" = 'shared' WHERE id = $1`, [scheduleId]),
    ).rejects.toThrow("invalid asset namespace key");
    const workflowId = id("wf");
    await expect(
      db.run(`INSERT INTO workflows (id, name, definition, "key") VALUES ($1, $1, '{}', 'nope/')`, [
        workflowId,
      ]),
    ).rejects.toThrow("invalid asset namespace key");
  });

  test("a mapping refuses an empty provider id/key; deleting its attachment detaches it", async () => {
    await expect(
      db.run(
        `INSERT INTO asset_key_mappings (id, provider_id, provider_key, "key") VALUES ($1, '', 'k', 'shared/')`,
        [id("map")],
      ),
    ).rejects.toThrow("invalid asset key mapping");
    await expect(
      db.run(
        `INSERT INTO asset_key_mappings (id, provider_id, provider_key, "key") VALUES ($1, 'p', 'k', 'shared')`,
        [id("map")],
      ),
    ).rejects.toThrow("invalid asset key mapping");

    const taskId = await task();
    const attachmentId = id("att");
    await db.run(
      `INSERT INTO task_attachments (id, task_id, name, kind) VALUES ($1, $2, 'f', 'agent-fs')`,
      [attachmentId, taskId],
    );
    const mappingId = id("map");
    await db.run(
      `INSERT INTO asset_key_mappings (id, provider_id, provider_key, "key", source_entity_type, source_entity_id)
       VALUES ($1, 'p', $1, 'shared/', 'task-attachment', $2)`,
      [mappingId, attachmentId],
    );
    await db.run(`DELETE FROM task_attachments WHERE id = $1`, [attachmentId]);
    const row = await db.get<{ source_entity_type: string; source_entity_id: string | null }>(
      `SELECT source_entity_type, source_entity_id FROM asset_key_mappings WHERE id = $1`,
      [mappingId],
    );
    expect(row).toEqual({ source_entity_type: "external", source_entity_id: null });
  });
});

describe("model profiles and groups", () => {
  async function profile(name: string) {
    await db.run(
      `INSERT INTO model_profiles (name, harness, model, "createdAt", "lastUpdatedAt")
       VALUES ($1, 'claude', 'm', statement_timestamp(), statement_timestamp())`,
      [name],
    );
  }
  async function group(name: string) {
    await db.run(
      `INSERT INTO model_groups (name, "createdAt", "lastUpdatedAt")
       VALUES ($1, statement_timestamp(), statement_timestamp())`,
      [name],
    );
  }

  test("profiles and groups share one name space", async () => {
    await profile("p-shared-name");
    await expect(group("p-shared-name")).rejects.toThrow(
      "model-name-taken: a model profile has this name",
    );
    await group("g-shared-name");
    await expect(profile("g-shared-name")).rejects.toThrow(
      "model-name-taken: a model group has this name",
    );
  });

  test("a task or schedule names an existing profile and group", async () => {
    await profile("p-ref");
    await group("g-ref");
    const ok = id("task");
    await db.run(
      `INSERT INTO agent_tasks (id, task, profile, "modelGroup", "createdAt", "lastUpdatedAt")
       VALUES ($1, 't', 'p-ref', 'g-ref', statement_timestamp(), statement_timestamp())`,
      [ok],
    );
    await expect(
      db.run(
        `INSERT INTO agent_tasks (id, task, profile, "createdAt", "lastUpdatedAt")
         VALUES ($1, 't', 'p-missing', statement_timestamp(), statement_timestamp())`,
        [id("task")],
      ),
    ).rejects.toThrow("model-profile-missing: the task's model profile does not exist");
    await expect(
      db.run(`UPDATE agent_tasks SET "modelGroup" = 'g-missing' WHERE id = $1`, [ok]),
    ).rejects.toThrow("model-group-missing: the task's model group does not exist");
    await expect(
      db.run(`UPDATE agent_tasks SET profile = 'p-missing' WHERE id = $1`, [ok]),
    ).rejects.toThrow("model-profile-missing: the task's model profile does not exist");

    const scheduleId = id("sched");
    await db.run(
      `INSERT INTO scheduled_tasks (id, name, "scheduleType", "taskTemplate", profile, "createdAt", "lastUpdatedAt")
       VALUES ($1, $1, 'one_time', 't', 'p-ref', statement_timestamp(), statement_timestamp())`,
      [scheduleId],
    );
    await expect(
      db.run(`UPDATE scheduled_tasks SET profile = 'p-missing' WHERE id = $1`, [scheduleId]),
    ).rejects.toThrow("model-profile-missing: the schedule's model profile does not exist");
    await expect(
      db.run(`UPDATE scheduled_tasks SET "modelGroup" = 'g-missing' WHERE id = $1`, [scheduleId]),
    ).rejects.toThrow("model-group-missing: the schedule's model group does not exist");
  });

  test("an agent's default profile must exist (trimmed)", async () => {
    await profile("p-default");
    const insert = (value: string) =>
      db.run(
        `INSERT INTO swarm_config (id, scope, "scopeId", key, value, "createdAt", "lastUpdatedAt")
         VALUES ($1, 'agent', $2, 'MODEL_PROFILE', $3, statement_timestamp(), statement_timestamp())`,
        [id("cfg"), id("agent"), value],
      );
    await expect(insert("p-nope")).rejects.toThrow(
      "model-profile-missing: the agent's default model profile does not exist",
    );
    await insert("  p-default  ");
  });
});

describe("session maintenance", () => {
  type Summary = {
    chainCount: string;
    openTaskCount: string;
    pendingApprovalCount: string;
    latestStatus: string;
    lastActivityAt: Date;
    lastHumanAt: Date | null;
    key: string;
    requestedByUserId: string | null;
  };
  const summary = (rootId: string) =>
    db.get<Summary>(
      `SELECT "chainCount", "openTaskCount", "pendingApprovalCount", "latestStatus",
         "lastActivityAt", "lastHumanAt", "key", "requestedByUserId"
       FROM session_summaries WHERE "rootId" = $1`,
      [rootId],
    );

  test("a root opens a session, a child joins, activity and terminal moves follow", async () => {
    const source = await user();
    const rootId = await task({ requestedByUserId: source, at: iso(0), key: "shared/s/a/" });
    let s = await summary(rootId);
    expect(s).not.toBeNull();
    expect(Number(s?.chainCount)).toBe(1);
    expect(Number(s?.openTaskCount)).toBe(1);
    expect(Number(s?.pendingApprovalCount)).toBe(0);
    expect(s?.latestStatus).toBe("pending");
    expect(isoOf(s?.lastActivityAt)).toBe(iso(0));
    expect(isoOf(s?.lastHumanAt)).toBe(iso(0)); // a person asked directly (source api)
    expect(s?.key).toBe("shared/s/a/");

    const childId = await task({ parentTaskId: rootId, at: iso(1000) });
    const member = await db.get<{ rootId: string }>(
      `SELECT "rootId" FROM session_members WHERE "taskId" = $1`,
      [childId],
    );
    expect(member?.rootId).toBe(rootId);
    s = await summary(rootId);
    expect(Number(s?.chainCount)).toBe(2);
    expect(Number(s?.openTaskCount)).toBe(2);
    expect(isoOf(s?.lastActivityAt)).toBe(iso(1000));

    // session_task_open + session_task_activity: a terminal child closes one open task.
    await db.run(
      `UPDATE agent_tasks SET status = 'completed', "lastUpdatedAt" = $2 WHERE id = $1`,
      [childId, iso(2000)],
    );
    s = await summary(rootId);
    expect(Number(s?.openTaskCount)).toBe(1);
    expect(s?.latestStatus).toBe("completed");
    expect(isoOf(s?.lastActivityAt)).toBe(iso(2000));

    // session_root_columns: the summary copies the root's key.
    await db.run(`UPDATE agent_tasks SET "key" = 'shared/s/b/' WHERE id = $1`, [rootId]);
    expect((await summary(rootId))?.key).toBe("shared/s/b/");

    // session_task_human: a requester change recomputes (inherited => no human time).
    const target = await user();
    await db.run(
      `UPDATE agent_tasks SET "requestedByUserId" = $2, "requestedByUserIdInherited" = true WHERE id = $1`,
      [rootId, target],
    );
    s = await summary(rootId);
    expect(s?.requestedByUserId).toBe(target);
    expect(s?.lastHumanAt).toBeNull();

    // session_task_activity_rewind: moving lastUpdatedAt back recomputes the aggregates.
    await db.run(`UPDATE agent_tasks SET "lastUpdatedAt" = $2 WHERE id = $1`, [childId, iso(500)]);
    s = await summary(rootId);
    expect(isoOf(s?.lastActivityAt)).toBe(iso(500));
    expect(s?.latestStatus).toBe("completed");

    // session_task_delete: a deleted child leaves the chain; a deleted root drops the summary.
    await db.run(`DELETE FROM agent_tasks WHERE id = $1`, [childId]);
    s = await summary(rootId);
    expect(Number(s?.chainCount)).toBe(1);
    await db.run(`DELETE FROM agent_tasks WHERE id = $1`, [rootId]);
    expect(await summary(rootId)).toBeNull();
  });

  test("approvals and steering messages are human activity", async () => {
    const source = await user();
    const rootId = await task({ requestedByUserId: source, at: iso(0) });
    const childId = await task({ parentTaskId: rootId, at: iso(100) });

    const steeringId = id("steer");
    await db.run(
      `INSERT INTO task_steering_messages (id, task_id, body, mode, source, created_by_kind, created_at)
       VALUES ($1, $2, 'steer', 'queue', 'ui', 'user', $3)`,
      [steeringId, childId, iso(5000)],
    );
    let s = await summary(rootId);
    expect(isoOf(s?.lastHumanAt)).toBe(iso(5000));

    const approvalId = id("appr");
    await db.run(
      `INSERT INTO approval_requests (id, title, questions, approvers, "sourceTaskId", status, "createdAt")
       VALUES ($1, 't', '[]', '{}', $2, 'pending', $3)`,
      [approvalId, childId, iso(9000)],
    );
    s = await summary(rootId);
    expect(Number(s?.pendingApprovalCount)).toBe(1);
    expect(isoOf(s?.lastHumanAt)).toBe(iso(9000));

    await db.run(`UPDATE approval_requests SET status = 'cancelled' WHERE id = $1`, [approvalId]);
    s = await summary(rootId);
    expect(Number(s?.pendingApprovalCount)).toBe(0);
    expect(isoOf(s?.lastHumanAt)).toBe(iso(5000));

    // session_steering_update: a cancelled message no longer counts.
    await db.run(`UPDATE task_steering_messages SET status = 'cancelled' WHERE id = $1`, [
      steeringId,
    ]);
    expect(isoOf((await summary(rootId))?.lastHumanAt)).toBe(iso(0));

    // session_approval_delete / session_steering_delete.
    const second = id("appr");
    await db.run(
      `INSERT INTO approval_requests (id, title, questions, approvers, "sourceTaskId", status, "createdAt")
       VALUES ($1, 't', '[]', '{}', $2, 'pending', $3)`,
      [second, childId, iso(7000)],
    );
    expect(Number((await summary(rootId))?.pendingApprovalCount)).toBe(1);
    await db.run(`DELETE FROM approval_requests WHERE id = $1`, [second]);
    expect(Number((await summary(rootId))?.pendingApprovalCount)).toBe(0);
    const live = id("steer");
    await db.run(
      `INSERT INTO task_steering_messages (id, task_id, body, mode, source, created_by_kind, created_at)
       VALUES ($1, $2, 'steer', 'queue', 'ui', 'user', $3)`,
      [live, childId, iso(8000)],
    );
    expect(isoOf((await summary(rootId))?.lastHumanAt)).toBe(iso(8000));
    await db.run(`DELETE FROM task_steering_messages WHERE id = $1`, [live]);
    expect(isoOf((await summary(rootId))?.lastHumanAt)).toBe(iso(0));
  });
});

describe("slack and chat relay", () => {
  const chatObligation = (taskId: string) =>
    db.get(`SELECT task_id FROM chat_relay_obligations WHERE task_id = $1`, [taskId]);
  const slackObligation = (taskId: string) =>
    db.get(`SELECT task_id FROM slack_relay_obligations WHERE task_id = $1`, [taskId]);

  test("a chat task owes a relay when it ends; a deferral drops it", async () => {
    const chatId = await task({ source: "chat", contextKey: "task:chat-sdk:telegram:1" });
    expect(await chatObligation(chatId)).toBeNull();
    await db.run(`UPDATE agent_tasks SET status = 'completed' WHERE id = $1`, [chatId]);
    expect(await chatObligation(chatId)).not.toBeNull();
    // A second terminal write keeps one obligation (ON CONFLICT DO NOTHING).
    await db.run(`UPDATE agent_tasks SET status = 'failed' WHERE id = $1`, [chatId]);

    // Not a chat-sdk context: no obligation.
    const other = await task({ source: "chat", contextKey: "task:slack:1" });
    await db.run(`UPDATE agent_tasks SET status = 'completed' WHERE id = $1`, [other]);
    expect(await chatObligation(other)).toBeNull();

    // A lead's resume task on a chat thread owes a relay; insert-time terminal too.
    const lead = await agent(true);
    const resumed = await task({
      source: "system",
      taskType: "resume",
      agentId: lead,
      contextKey: "task:chat-sdk:telegram:2",
      status: "completed",
    });
    expect(await chatObligation(resumed)).not.toBeNull();

    // drop_chat_relay_on_defer.
    const deferred = await task({ source: "chat", contextKey: "task:chat-sdk:telegram:3" });
    await db.run(`UPDATE agent_tasks SET status = 'completed' WHERE id = $1`, [deferred]);
    expect(await chatObligation(deferred)).not.toBeNull();
    await db.run(`UPDATE agent_tasks SET "deferredAt" = statement_timestamp() WHERE id = $1`, [
      deferred,
    ]);
    expect(await chatObligation(deferred)).toBeNull();
  });

  test("a Slack task owes its thread a relay; a new task reopens a closed tree", async () => {
    const thread = { slackChannelId: "C1", slackThreadTs: `${Date.now()}.0001` };
    const treeId = id("tree");
    await db.run(
      `INSERT INTO slack_messages (id, context_key, channel_id, thread_ts, ts, kind, closed_at)
       VALUES ($1, 'ctx', $2, $3, $4, 'tree', statement_timestamp())`,
      [treeId, thread.slackChannelId, thread.slackThreadTs, `${thread.slackThreadTs}-t`],
    );
    const slackId = await task({ source: "slack", ...thread });
    const tree = await db.get<{ closed_at: unknown }>(
      `SELECT closed_at FROM slack_messages WHERE id = $1`,
      [treeId],
    );
    expect(tree?.closed_at).toBeNull();
    expect(await slackObligation(slackId)).toBeNull();
    await db.run(`UPDATE agent_tasks SET status = 'completed' WHERE id = $1`, [slackId]);
    expect(await slackObligation(slackId)).not.toBeNull();

    // An outcome card in the thread reopens a closed tree too.
    await db.run(`UPDATE slack_messages SET closed_at = statement_timestamp() WHERE id = $1`, [
      treeId,
    ]);
    await db.run(
      `INSERT INTO slack_messages (id, context_key, channel_id, thread_ts, ts, kind)
       VALUES ($1, 'ctx', $2, $3, $4, 'outcome')`,
      [id("outcome"), thread.slackChannelId, thread.slackThreadTs, `${thread.slackThreadTs}-o`],
    );
    const reopened = await db.get<{ closed_at: unknown }>(
      `SELECT closed_at FROM slack_messages WHERE id = $1`,
      [treeId],
    );
    expect(reopened?.closed_at).toBeNull();
  });
});

describe("immutability", () => {
  test("agent_history is append-only and a task's parent never changes", async () => {
    const historyId = id("hist");
    await db.run(
      `INSERT INTO agent_history (id, agent_id, event, actor_ref, reason, snapshot_json, created_at)
       VALUES ($1, 'a', 'deleted', 'op', 'cleanup', '{}', statement_timestamp())`,
      [historyId],
    );
    await expect(
      db.run(`UPDATE agent_history SET reason = 'changed' WHERE id = $1`, [historyId]),
    ).rejects.toThrow("agent_history is append-only");
    await expect(db.run(`DELETE FROM agent_history WHERE id = $1`, [historyId])).rejects.toThrow(
      "agent_history is append-only",
    );

    const parent = await task();
    const child = await task({ parentTaskId: parent });
    const other = await task();
    await expect(
      db.run(`UPDATE agent_tasks SET "parentTaskId" = $2 WHERE id = $1`, [child, other]),
    ).rejects.toThrow("agent_tasks.parentTaskId is immutable (session_members depends on it)");
    // Writing the same parent is not a change.
    await db.run(`UPDATE agent_tasks SET "parentTaskId" = $2 WHERE id = $1`, [child, parent]);
  });
});

describe("rbac default role", () => {
  test("every new user gets the admin role", async () => {
    const userId = await user();
    const roles = await db.query<{ roleId: string; principalType: string }>(
      `SELECT "roleId", "principalType" FROM principal_roles WHERE "principalId" = $1`,
      [userId],
    );
    expect(roles).toEqual([{ roleId: "rbac-role-admin", principalType: "user" }]);
  });
});

describe("cascades", () => {
  test("cancelling a workflow step cancels its pending approval", async () => {
    const workflowId = id("wf");
    await db.run(`INSERT INTO workflows (id, name, definition) VALUES ($1, $1, '{}')`, [
      workflowId,
    ]);
    const runId = id("run");
    await db.run(`INSERT INTO workflow_runs (id, "workflowId") VALUES ($1, $2)`, [
      runId,
      workflowId,
    ]);
    const stepId = id("step");
    await db.run(
      `INSERT INTO workflow_run_steps (id, "runId", "nodeId", "nodeType", status)
       VALUES ($1, $2, 'n', 'human-in-the-loop', 'waiting')`,
      [stepId, runId],
    );
    const approvalId = id("appr");
    await db.run(
      `INSERT INTO approval_requests (id, title, questions, approvers, "workflowRunStepId", status)
       VALUES ($1, 't', '[]', '{}', $2, 'pending')`,
      [approvalId, stepId],
    );
    await db.run(`UPDATE workflow_run_steps SET status = 'cancelled' WHERE id = $1`, [stepId]);
    const row = await db.get<{ status: string; resolutionReason: string; resolvedAt: unknown }>(
      `SELECT status, "resolutionReason", "resolvedAt" FROM approval_requests WHERE id = $1`,
      [approvalId],
    );
    expect(row?.status).toBe("cancelled");
    expect(row?.resolutionReason).toBe("Human-in-the-loop step cancelled");
    // The codec returns timestamps in the SQLite text format of the column.
    expect(typeof row?.resolvedAt).toBe("string");
    expect(Number.isNaN(Date.parse(String(row?.resolvedAt)))).toBe(false);
  });

  test("deleting the last run of a source deletes the source", async () => {
    await db.run(`INSERT INTO script_run_sources (hash, source) VALUES ('h1', 'code')`);
    for (const runId of ["sr-1", "sr-2"]) {
      await db.run(
        `INSERT INTO script_runs (id, "agentId", source, "sourceHash") VALUES ($1, 'a', 'code', 'h1')`,
        [runId],
      );
    }
    await db.run(`DELETE FROM script_runs WHERE id = 'sr-1'`);
    expect(await db.get(`SELECT hash FROM script_run_sources WHERE hash = 'h1'`)).not.toBeNull();
    await db.run(`DELETE FROM script_runs WHERE id = 'sr-2'`);
    expect(await db.get(`SELECT hash FROM script_run_sources WHERE hash = 'h1'`)).toBeNull();
  });
});

describe("rowid surrogate", () => {
  test("_rowid numbers rows in insertion order; seeded rows keep the SQLite rowid", async () => {
    const a = await task();
    const b = await task();
    // The codec drops a result column named _rowid, so read it under another name.
    const rows = await db.query<{ id: string; _rowid_value: string }>(
      `SELECT id, "_rowid" AS _rowid_value FROM agent_tasks WHERE id IN ($1, $2) ORDER BY "_rowid"`,
      [a, b],
    );
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    expect(Number(rows[1]?._rowid_value)).toBeGreaterThan(Number(rows[0]?._rowid_value));
    // A copied value is accepted (BY DEFAULT), and the unique index refuses a duplicate.
    await expect(
      db.run(
        `INSERT INTO agent_tasks (id, task, "createdAt", "lastUpdatedAt", "_rowid")
         VALUES ($1, 't', statement_timestamp(), statement_timestamp(), $2)`,
        [id("task"), Number(rows[0]?._rowid_value)],
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    // The seed sequence continues after the seeded rowids.
    const roles = await db.query<{ id: string; _rowid_value: string }>(
      `SELECT id, "_rowid" AS _rowid_value FROM roles ORDER BY "_rowid"`,
    );
    expect(roles.map((r) => Number(r._rowid_value))).toEqual([1, 2]);
  });

  test("WITHOUT ROWID and INTEGER PRIMARY KEY tables get no _rowid", async () => {
    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name = '_rowid' AND table_name IN ('kv_entries', 'human_free_reclassify_queue', 'chat_queue')`,
    );
    expect(rows).toEqual([]);
  });
});
