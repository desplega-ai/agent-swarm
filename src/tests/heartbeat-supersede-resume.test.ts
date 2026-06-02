/**
 * DES-523: heartbeat sweep should auto-supersede + resume crashed-worker tasks.
 *
 * Mirrors the test-setup pattern from `heartbeat.test.ts` (own sqlite file,
 * full DB reset between tests). Each test exercises one branch of
 * `remediateCrashedWorkerTask` inside `detectAndRemediateStalledTasks`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getChildTasks,
  getDb,
  getLogsByTaskId,
  getTaskById,
  initDb,
  insertActiveSession,
  startTask,
} from "../be/db";
import {
  createTrackerSync,
  getTrackerSync,
  getTrackerSyncByExternalId,
} from "../be/db-queries/tracker";
import {
  codeLevelTriage,
  MAX_RESUME_GENERATIONS,
  RESUME_BUDGET_EXHAUSTED_REASON,
  setBeforeHeartbeatSupersedeForTests,
} from "../heartbeat/heartbeat";
import { RESUME_GENERATION_TAG_PREFIX } from "../tasks/worker-follow-up";

const TEST_DB_PATH = "./test-heartbeat-supersede-resume.sqlite";

describe("Heartbeat — supersede + resume (DES-523)", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    closeDb();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
      try {
        await unlink(path);
      } catch {
        // Files may not exist
      }
    }
  });

  beforeEach(() => {
    setBeforeHeartbeatSupersedeForTests(null);
    getDb().run("DELETE FROM tracker_sync");
    getDb().run("DELETE FROM agent_tasks");
    getDb().run("DELETE FROM agents");
    getDb().run("DELETE FROM active_sessions");
  });

  // --------------------------------------------------------------------------
  // Case A — no active session
  // --------------------------------------------------------------------------

  test("Case A: regular task with no active session is auto-superseded and resumed", async () => {
    const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
    const parent = createTaskExtended("Long-running parent work", { agentId: agent.id });
    startTask(parent.id);

    // 10 min stale — past the 5 min no-session threshold.
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);

    const findings = await codeLevelTriage();

    expect(findings.autoResumedTasks.length).toBe(1);
    expect(findings.autoResumedTasks[0]!.taskId).toBe(parent.id);
    expect(findings.autoFailedTasks.length).toBe(0);

    // Parent transitioned to `superseded` (NOT `failed`).
    const updatedParent = getTaskById(parent.id);
    expect(updatedParent?.status).toBe("superseded");

    // A resume follow-up child exists.
    const children = getChildTasks(parent.id);
    expect(children.length).toBe(1);
    const resume = children[0]!;
    expect(resume.taskType).toBe("resume");
    expect(resume.tags).toContain("auto-resume");
    expect(resume.tags).toContain("reason:crash_recovery");
    expect(resume.tags).toContain(`${RESUME_GENERATION_TAG_PREFIX}1`);
    expect(resume.id).toBe(findings.autoResumedTasks[0]!.resumeTaskId);

    const supersedeLog = getLogsByTaskId(parent.id).find(
      (log) => log.eventType === "task_superseded",
    );
    expect(supersedeLog).toBeTruthy();
    const metadata = JSON.parse(supersedeLog!.metadata ?? "{}") as { resumeTaskId?: string };
    expect(metadata.resumeTaskId).toBe(resume.id);
  });

  test("Case A: crash-recovery resume chain stops at the generation cap", async () => {
    const agent = createAgent({ name: "dead-resume-worker", isLead: false, status: "busy" });
    const parent = createTaskExtended("Resume at generation cap", {
      agentId: agent.id,
      taskType: "resume",
      tags: [
        "auto-resume",
        "reason:crash_recovery",
        `${RESUME_GENERATION_TAG_PREFIX}${MAX_RESUME_GENERATIONS}`,
      ],
    });
    startTask(parent.id);

    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);

    const findings = await codeLevelTriage();

    expect(findings.autoResumedTasks.length).toBe(0);
    expect(findings.autoFailedTasks.length).toBe(1);
    expect(findings.autoFailedTasks[0]!.taskId).toBe(parent.id);
    expect(findings.autoFailedTasks[0]!.reason).toBe(RESUME_BUDGET_EXHAUSTED_REASON);

    const updatedParent = getTaskById(parent.id);
    expect(updatedParent?.status).toBe("failed");
    expect(updatedParent?.failureReason).toBe(RESUME_BUDGET_EXHAUSTED_REASON);
    expect(getChildTasks(parent.id).length).toBe(0);
  });

  test("Case A: supersede race does not create a resume child or repoint tracker_sync", async () => {
    const agent = createAgent({ name: "dead-worker-race", isLead: false, status: "busy" });
    const parent = createTaskExtended("Tracked parent that finishes during heartbeat", {
      agentId: agent.id,
    });
    startTask(parent.id);

    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: parent.id,
      externalId: "linear-race-issue",
      externalIdentifier: "ENG-637",
      externalUrl: "https://linear.app/test/issue/ENG-637",
    });

    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);

    setBeforeHeartbeatSupersedeForTests((task) => {
      expect(task.id).toBe(parent.id);
      completeTask(parent.id, "finished by racing worker");
    });

    const findings = await codeLevelTriage();

    expect(findings.autoResumedTasks.length).toBe(0);
    expect(findings.autoFailedTasks.length).toBe(0);

    const updatedParent = getTaskById(parent.id);
    expect(updatedParent?.status).toBe("completed");
    expect(getChildTasks(parent.id).length).toBe(0);

    expect(getTrackerSync("linear", "task", parent.id)).not.toBeNull();
    const byExternal = getTrackerSyncByExternalId("linear", "task", "linear-race-issue");
    expect(byExternal?.swarmId).toBe(parent.id);
  });

  // --------------------------------------------------------------------------
  // Case A — system task: must fall back to failTask, never resume
  // --------------------------------------------------------------------------

  test("Case A: system task (taskType=heartbeat) is failed, not resumed", async () => {
    const lead = createAgent({ name: "lead", isLead: true, status: "busy" });
    const parent = createTaskExtended("Periodic heartbeat checklist", {
      agentId: lead.id,
      taskType: "heartbeat",
    });
    startTask(parent.id);

    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);

    const findings = await codeLevelTriage();

    expect(findings.autoFailedTasks.length).toBe(1);
    expect(findings.autoFailedTasks[0]!.taskId).toBe(parent.id);
    expect(findings.autoResumedTasks.length).toBe(0);

    const updatedParent = getTaskById(parent.id);
    expect(updatedParent?.status).toBe("failed");

    // No resume child was created.
    const children = getChildTasks(parent.id);
    expect(children.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case A — idempotency: a non-terminal child already exists → fail, no 2nd resume
  // --------------------------------------------------------------------------

  test("Case A: idempotency — non-terminal child already exists, parent is failed (no 2nd resume)", async () => {
    const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
    const parent = createTaskExtended("Parent with existing child", { agentId: agent.id });
    startTask(parent.id);

    // Pre-insert a non-terminal child. `createTaskExtended` defaults to
    // `unassigned` without an agentId — we assign the same agent so the child
    // lands in `pending`, mirroring what a prior sweep would have produced.
    const preexisting = createTaskExtended("Existing pending child", {
      parentTaskId: parent.id,
      agentId: agent.id,
      tags: ["auto-resume", "reason:crash_recovery"],
      taskType: "resume",
    });
    expect(preexisting.status).toBe("pending");

    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);

    const findings = await codeLevelTriage();

    // Idempotency path: parent gets the legacy `failTask` treatment.
    expect(findings.autoFailedTasks.length).toBe(1);
    expect(findings.autoFailedTasks[0]!.taskId).toBe(parent.id);
    expect(findings.autoResumedTasks.length).toBe(0);

    const updatedParent = getTaskById(parent.id);
    expect(updatedParent?.status).toBe("failed");

    // Only the original pre-existing child remains — no second resume was created.
    const children = getChildTasks(parent.id);
    expect(children.length).toBe(1);
    expect(children[0]!.id).toBe(preexisting.id);
  });

  // --------------------------------------------------------------------------
  // Case A — delegation children must NOT block the resume path
  // --------------------------------------------------------------------------

  test("Case A: ordinary delegation child does NOT block resume (only taskType=resume children count)", async () => {
    // PR #594 review: `send-task` auto-defaults `parentTaskId` to the
    // caller's current task. So a crashed worker that had delegated subtasks
    // has non-terminal children that are NOT resume tasks. The idempotency
    // guard must only count taskType=resume children — otherwise the parent
    // is silently failed and the original work is dropped.
    const agent = createAgent({ name: "dead-delegator", isLead: false, status: "busy" });
    const otherAgent = createAgent({ name: "subtask-worker", isLead: false, status: "busy" });
    const parent = createTaskExtended("Parent that delegated", { agentId: agent.id });
    startTask(parent.id);

    // A delegated subtask — `taskType` is NOT "resume". `send-task` auto-sets
    // parentTaskId to the delegator's current task, so this models reality.
    const delegated = createTaskExtended("Delegated subtask", {
      parentTaskId: parent.id,
      agentId: otherAgent.id,
      taskType: "delegation",
    });
    expect(delegated.status).toBe("pending");

    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);

    const findings = await codeLevelTriage();

    // Resume path should fire — the delegated child does not count.
    expect(findings.autoResumedTasks.length).toBe(1);
    expect(findings.autoResumedTasks[0]!.taskId).toBe(parent.id);
    expect(findings.autoFailedTasks.length).toBe(0);

    const updatedParent = getTaskById(parent.id);
    expect(updatedParent?.status).toBe("superseded");

    // Children now: the original delegation + the new resume.
    const children = getChildTasks(parent.id);
    expect(children.length).toBe(2);
    const resumeChild = children.find((c) => c.taskType === "resume");
    expect(resumeChild).not.toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Case B — stale session heartbeat
  // --------------------------------------------------------------------------

  test("Case B: stale session heartbeat is auto-superseded and resumed", async () => {
    const agent = createAgent({ name: "crashed-worker", isLead: false, status: "busy" });
    const parent = createTaskExtended("Crashed worker's task", { agentId: agent.id });
    startTask(parent.id);

    insertActiveSession({
      agentId: agent.id,
      taskId: parent.id,
      triggerType: "task_assigned",
    });

    // Make both task and session heartbeat 20 min stale — past the 15 min threshold.
    const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);
    getDb().run("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?", [
      oldTime,
      parent.id,
    ]);

    const findings = await codeLevelTriage();

    expect(findings.autoResumedTasks.length).toBe(1);
    expect(findings.autoResumedTasks[0]!.taskId).toBe(parent.id);
    expect(findings.autoFailedTasks.length).toBe(0);

    const updatedParent = getTaskById(parent.id);
    expect(updatedParent?.status).toBe("superseded");

    const children = getChildTasks(parent.id);
    expect(children.length).toBe(1);
    const resume = children[0]!;
    expect(resume.taskType).toBe("resume");
    expect(resume.tags).toContain("auto-resume");
    expect(resume.tags).toContain("reason:crash_recovery");

    // Orphan active_session row was cleaned up.
    const remainingSessions = getDb()
      .query("SELECT COUNT(*) as count FROM active_sessions WHERE taskId = ?")
      .get(parent.id) as { count: number };
    expect(remainingSessions.count).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Workflow carve-out — workflowRunStepId set → workflow-skip → failTask path
  // --------------------------------------------------------------------------

  test("Workflow-step parent: failed with workflow reason, no supersede or resume", async () => {
    const agent = createAgent({ name: "workflow-worker", isLead: false, status: "busy" });
    const parent = createTaskExtended("Workflow-step task", { agentId: agent.id });
    startTask(parent.id);

    // Backfill workflowRunStepId — createTaskExtended doesn't accept it.
    // FKs are toggled off because this test only exercises the heartbeat path,
    // not the workflow engine itself (same pattern as task-supersede-resume.test.ts).
    const stepId = crypto.randomUUID();
    getDb().exec("PRAGMA foreign_keys = OFF");
    try {
      getDb().run("UPDATE agent_tasks SET workflowRunStepId = ? WHERE id = ?", [stepId, parent.id]);
    } finally {
      getDb().exec("PRAGMA foreign_keys = ON");
    }

    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);

    const findings = await codeLevelTriage();

    // Workflow carve-out: the engine owns retry. Skip the supersede flow and
    // mark the dedicated workflow-task failure so the engine can react.
    expect(findings.autoResumedTasks.length).toBe(0);
    expect(findings.autoFailedTasks.length).toBe(1);
    expect(findings.autoFailedTasks[0]!.taskId).toBe(parent.id);
    expect(findings.autoFailedTasks[0]!.reason).toBe("superseded_workflow_task");

    // No resume child was created.
    const children = getChildTasks(parent.id);
    expect(children.length).toBe(0);

    const updatedParent = getTaskById(parent.id);
    expect(updatedParent?.status).toBe("failed");
    expect(updatedParent?.failureReason).toBe("superseded_workflow_task");
  });
});
