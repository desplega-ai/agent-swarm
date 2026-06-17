/**
 * DES-523: Lead-routed takeover-decision mechanism for crash recovery.
 *
 * Tests the new TAKEOVER_VIA_LEAD path in remediateCrashedWorkerTask and
 * the escalateTakeoverTimeouts() fail-open handler.
 *
 * Mirrors the test-setup pattern from heartbeat-supersede-resume.test.ts:
 * own sqlite file, full DB reset between tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getChildTasks,
  getDb,
  getTaskById,
  hasAnyResumeChild,
  hasNonTerminalResumeChild,
  initDb,
  startTask,
} from "../be/db";
import {
  createTrackerSync,
  getTrackerSync,
  getTrackerSyncByExternalId,
} from "../be/db-queries/tracker";
import {
  codeLevelTriage,
  LEAD_ESCALATION_TIMEOUT_MIN,
  MAX_RESUME_GENERATIONS,
  RESUME_BUDGET_EXHAUSTED_REASON,
  runRebootSweep,
  setBeforeHeartbeatSupersedeForTests,
  setTakeoverViaLeadForTests,
} from "../heartbeat/heartbeat";
import { resolveTemplate } from "../prompts/resolver";
import { RESUME_GENERATION_TAG_PREFIX } from "../tasks/worker-follow-up";
import { sendTaskHandler } from "../tools/send-task";
import "../tools/templates"; // registers all templates including task.takeover.decision

const TEST_DB_PATH = "./test-takeover-decision.sqlite";

describe("Heartbeat — Lead-routed takeover-decision (DES-523)", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist yet
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
    setTakeoverViaLeadForTests(null); // restore env default (false)
    getDb().run("DELETE FROM tracker_sync");
    getDb().run("DELETE FROM agent_tasks");
    getDb().run("DELETE FROM agents");
    getDb().run("DELETE FROM active_sessions");
  });

  // --------------------------------------------------------------------------
  // Test 1: Decision-task creation
  // --------------------------------------------------------------------------

  test("T1: crashed worker → takeover-decision task created (no resume yet); findings.escalatedTakeovers populated", async () => {
    setTakeoverViaLeadForTests(true);

    const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
    const worker = createAgent({
      name: "coder-1",
      isLead: false,
      status: "busy",
      role: "coder",
      harnessProvider: "claude",
    });
    const parent = createTaskExtended("Build the feature", { agentId: worker.id });
    startTask(parent.id);

    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);

    const findings = await codeLevelTriage();

    // Escalated, not directly resumed.
    expect(findings.escalatedTakeovers.length).toBe(1);
    expect(findings.escalatedTakeovers[0]!.taskId).toBe(parent.id);
    expect(findings.autoResumedTasks.length).toBe(0);

    const updatedParent = getTaskById(parent.id);
    expect(updatedParent?.status).toBe("superseded");

    // Exactly one child: the takeover-decision task.
    const children = getChildTasks(parent.id);
    expect(children.length).toBe(1);
    const decision = children[0]!;
    expect(decision.taskType).toBe("takeover-decision");
    expect(decision.agentId).toBe(lead.id);
    expect(decision.tags).toContain("takeover-decision");
    expect(decision.tags).toContain("reason:crash_recovery");
    expect(decision.tags).toContain(`${RESUME_GENERATION_TAG_PREFIX}1`);
    expect(findings.escalatedTakeovers[0]!.decisionTaskId).toBe(decision.id);

    // No resume child yet.
    expect(hasNonTerminalResumeChild(parent.id)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Test 2: Timeout → fail-open pool resume
  // --------------------------------------------------------------------------

  test("T2a: decision task past timeout → pool resume created, decision failed (lead_escalation_timeout)", async () => {
    setTakeoverViaLeadForTests(true);

    const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "coder-2", isLead: false, status: "busy" });
    const parent = createTaskExtended("Heavy refactor", { agentId: worker.id });
    startTask(parent.id);

    // Supersede the parent and manually create a decision task that is already past the timeout.
    getDb().run("UPDATE agent_tasks SET status = 'superseded' WHERE id = ?", [parent.id]);
    const decision = createTaskExtended("Takeover decision placeholder", {
      agentId: lead.id,
      taskType: "takeover-decision",
      parentTaskId: parent.id,
    });
    startTask(decision.id);

    // Age the decision task past LEAD_ESCALATION_TIMEOUT_MIN.
    const expiredTime = new Date(
      Date.now() - (LEAD_ESCALATION_TIMEOUT_MIN + 1) * 60 * 1000,
    ).toISOString();
    getDb().run("UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?", [
      expiredTime,
      expiredTime,
      decision.id,
    ]);

    const findings = await codeLevelTriage();

    // Pool resume was created via fail-open.
    expect(findings.autoResumedTasks.length).toBeGreaterThanOrEqual(1);
    const resumed = findings.autoResumedTasks.find((r) => r.taskId === parent.id);
    expect(resumed).toBeDefined();

    const resumeTask = getTaskById(resumed!.resumeTaskId);
    expect(resumeTask).not.toBeNull();
    expect(resumeTask?.taskType).toBe("resume");
    expect(resumeTask?.tags).toContain("reason:crash_recovery");

    // Decision task is now failed.
    const updatedDecision = getTaskById(decision.id);
    expect(updatedDecision?.status).toBe("failed");
    expect(updatedDecision?.failureReason).toBe("lead_escalation_timeout");
  });

  test("T2b: decision task within timeout → no resume created, decision still open", async () => {
    setTakeoverViaLeadForTests(true);

    const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "coder-3", isLead: false, status: "busy" });
    const parent = createTaskExtended("API migration", { agentId: worker.id });
    startTask(parent.id);

    getDb().run("UPDATE agent_tasks SET status = 'superseded' WHERE id = ?", [parent.id]);
    const decision = createTaskExtended("Takeover decision", {
      agentId: lead.id,
      taskType: "takeover-decision",
      parentTaskId: parent.id,
    });
    startTask(decision.id);

    // Decision is fresh (created just now) — well within the timeout window.

    const findings = await codeLevelTriage();

    expect(findings.autoResumedTasks.length).toBe(0);

    const updatedDecision = getTaskById(decision.id);
    // Decision task remains in_progress (not closed or failed).
    expect(updatedDecision?.status).toBe("in_progress");
  });

  // --------------------------------------------------------------------------
  // Test 3: Lead already routed → decision task completed, no second resume
  // --------------------------------------------------------------------------

  test("T3: Lead already routed (resume child exists) → decision closed, no second resume", async () => {
    setTakeoverViaLeadForTests(true);

    const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "coder-4", isLead: false, status: "busy" });
    const parent = createTaskExtended("Auth refactor", { agentId: worker.id });
    startTask(parent.id);

    getDb().run("UPDATE agent_tasks SET status = 'superseded' WHERE id = ?", [parent.id]);

    // Lead created a resume child.
    createTaskExtended("Resume interrupted auth refactor", {
      parentTaskId: parent.id,
      taskType: "resume",
      tags: ["auto-resume", "reason:crash_recovery", `${RESUME_GENERATION_TAG_PREFIX}1`],
    });

    // Decision task is past the timeout.
    const decision = createTaskExtended("Takeover decision", {
      agentId: lead.id,
      taskType: "takeover-decision",
      parentTaskId: parent.id,
    });
    startTask(decision.id);
    const expiredTime = new Date(
      Date.now() - (LEAD_ESCALATION_TIMEOUT_MIN + 1) * 60 * 1000,
    ).toISOString();
    getDb().run("UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?", [
      expiredTime,
      expiredTime,
      decision.id,
    ]);

    await codeLevelTriage();

    // Decision task was completed (not failed), no second resume.
    const updatedDecision = getTaskById(decision.id);
    expect(updatedDecision?.status).toBe("completed");

    const children = getChildTasks(parent.id).filter((c) => c.taskType === "resume");
    expect(children.length).toBe(1); // still exactly one resume
  });

  test("T3b: Lead-routed child completed before timeout → decision closed, no second pool resume", async () => {
    setTakeoverViaLeadForTests(true);

    const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "coder-4b", isLead: false, status: "busy" });
    const parent = createTaskExtended("Auth refactor (completed resume)", { agentId: worker.id });
    startTask(parent.id);

    getDb().run("UPDATE agent_tasks SET status = 'superseded' WHERE id = ?", [parent.id]);

    // Lead routed a resume task — it has since completed successfully.
    const resume = createTaskExtended("Resume interrupted auth refactor", {
      parentTaskId: parent.id,
      taskType: "resume",
      tags: ["auto-resume", "reason:crash_recovery", `${RESUME_GENERATION_TAG_PREFIX}1`],
    });
    startTask(resume.id);
    getDb().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [resume.id]);

    // Decision task is past the timeout.
    const decision = createTaskExtended("Takeover decision", {
      agentId: lead.id,
      taskType: "takeover-decision",
      parentTaskId: parent.id,
    });
    startTask(decision.id);
    const expiredTime = new Date(
      Date.now() - (LEAD_ESCALATION_TIMEOUT_MIN + 1) * 60 * 1000,
    ).toISOString();
    getDb().run("UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?", [
      expiredTime,
      expiredTime,
      decision.id,
    ]);

    const findings = await codeLevelTriage();

    // Decision task was completed (routed_by_lead), NOT a second pool resume.
    const updatedDecision = getTaskById(decision.id);
    expect(updatedDecision?.status).toBe("completed");

    // hasAnyResumeChild returns true even though the resume has completed.
    expect(hasAnyResumeChild(parent.id)).toBe(true);
    expect(hasNonTerminalResumeChild(parent.id)).toBe(false); // confirms the gap this fix addresses

    // No new resume was created — still exactly one resume child.
    const resumeChildren = getChildTasks(parent.id).filter((c) => c.taskType === "resume");
    expect(resumeChildren.length).toBe(1);
    expect(findings.autoResumedTasks.find((r) => r.taskId === parent.id)).toBeUndefined();
  });

  test("T3d: Lead-dispatched resume via send-task repoints tracker_sync to the resume child", async () => {
    setTakeoverViaLeadForTests(true);

    const lead = createAgent({ name: "lead", isLead: true, status: "busy" });
    const worker = createAgent({ name: "coder-4d", isLead: false, status: "busy" });
    const replacement = createAgent({ name: "coder-replacement", isLead: false, status: "idle" });
    const parent = createTaskExtended("Tracked crash-recovery work", { agentId: worker.id });
    startTask(parent.id);

    getDb().run("UPDATE agent_tasks SET status = 'superseded' WHERE id = ?", [parent.id]);

    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: parent.id,
      externalId: "linear-lead-routed-resume",
      externalIdentifier: "ENG-783",
      externalUrl: "https://linear.app/test/issue/ENG-783",
    });

    expect(getTrackerSync("linear", "task", parent.id)).not.toBeNull();

    const result = await sendTaskHandler(
      { kind: "owner", agentId: lead.id },
      {
        task: "Resume tracked crash-recovery work",
        agentId: replacement.id,
        taskType: "resume",
        tags: ["auto-resume", "reason:crash_recovery", `${RESUME_GENERATION_TAG_PREFIX}1`],
        parentTaskId: parent.id,
        offerMode: false,
        allowDuplicate: true,
      },
    );

    const structured = result.structuredContent as {
      success: boolean;
      task?: { id: string; parentTaskId?: string };
    };
    expect(structured.success).toBe(true);
    expect(structured.task?.parentTaskId).toBe(parent.id);

    expect(getTrackerSync("linear", "task", parent.id)).toBeNull();
    const childLookup = getTrackerSync("linear", "task", structured.task!.id);
    expect(childLookup).not.toBeNull();
    const byExternal = getTrackerSyncByExternalId("linear", "task", "linear-lead-routed-resume");
    expect(byExternal?.swarmId).toBe(structured.task!.id);
    expect(byExternal?.externalIdentifier).toBe("ENG-783");
  });

  test("T3c: runRebootSweep — completed Lead-routed resume child → decision failed but no second pool resume", async () => {
    setTakeoverViaLeadForTests(true);

    const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "coder-4c", isLead: false, status: "busy" });
    const parent = createTaskExtended("Auth refactor (reboot sweep)", { agentId: worker.id });
    startTask(parent.id);

    getDb().run("UPDATE agent_tasks SET status = 'superseded' WHERE id = ?", [parent.id]);

    // Lead routed a resume task — it has since completed successfully.
    const resume = createTaskExtended("Resume interrupted auth refactor", {
      parentTaskId: parent.id,
      taskType: "resume",
      tags: ["auto-resume", "reason:crash_recovery", `${RESUME_GENERATION_TAG_PREFIX}1`],
    });
    startTask(resume.id);
    getDb().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [resume.id]);

    // Takeover-decision task is in_progress (assigned to lead, no active session).
    const decision = createTaskExtended("Takeover decision", {
      agentId: lead.id,
      taskType: "takeover-decision",
      parentTaskId: parent.id,
    });
    startTask(decision.id);

    // Backdate so getStalledInProgressTasks(0) deterministically includes this task.
    // Without this, startTask() and the sweep cutoff may land in the same millisecond,
    // causing lastUpdatedAt == cutoff (not <), which silently excludes the task.
    const pastTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ? WHERE id = ?", [
      pastTime,
      pastTime,
      decision.id,
    ]);

    // Sanity: confirm the gap this fixes — old predicate would miss the completed child.
    expect(hasAnyResumeChild(parent.id)).toBe(true);
    expect(hasNonTerminalResumeChild(parent.id)).toBe(false);

    await runRebootSweep();

    // Reboot sweep fails in-progress tasks with no active session — expected.
    const updatedDecision = getTaskById(decision.id);
    expect(updatedDecision?.status).toBe("failed");

    // No second pool resume must be created — still exactly one resume child.
    const resumeChildren = getChildTasks(parent.id).filter((c) => c.taskType === "resume");
    expect(resumeChildren.length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Test 4: Generation-cap propagation
  // --------------------------------------------------------------------------

  test("T4a: original at generation cap → fails with RESUME_BUDGET_EXHAUSTED, no decision task", async () => {
    setTakeoverViaLeadForTests(true);

    const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "coder-5", isLead: false, status: "busy" });
    const parent = createTaskExtended("Budget-exhausted task", {
      agentId: worker.id,
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

    expect(findings.autoFailedTasks.length).toBe(1);
    expect(findings.autoFailedTasks[0]!.reason).toBe(RESUME_BUDGET_EXHAUSTED_REASON);
    expect(findings.escalatedTakeovers.length).toBe(0);

    const updatedParent = getTaskById(parent.id);
    expect(updatedParent?.status).toBe("failed");
    expect(getChildTasks(parent.id).length).toBe(0);

    // Lead was defined but should not be referenced.
    void lead;
  });

  test("T4b: decision-task body carries resume-generation:N+1 for an under-cap original", () => {
    // Template resolution test — no DB needed.
    const result = resolveTemplate("task.takeover.decision", {
      original_agent_name: "coder-test",
      original_role: "coder",
      original_provider: "claude",
      original_task_id: "test-id-1234",
      reason: "crash_recovery",
      task_desc: "Build a feature",
      generation_next: "2",
      max_generations: String(MAX_RESUME_GENERATIONS),
      artifacts_block: "",
      timeout_min: String(LEAD_ESCALATION_TIMEOUT_MIN),
    });

    expect(result.skipped).toBe(false);
    expect(result.text).toContain(`taskType: "resume"`); // send-task shape the timeout handler expects
    expect(result.text).toContain("resume-generation:2");
    expect(result.text).toContain("parentTaskId: test-id-1234");
    expect(result.text).toContain("crash_recovery");
    expect(result.text).toContain("takeover-routing");
    expect(result.text).toContain("Fail-open warning");
    expect(result.text).toContain(String(LEAD_ESCALATION_TIMEOUT_MIN));
  });

  // --------------------------------------------------------------------------
  // Test 5: Opt-in scope gating
  // --------------------------------------------------------------------------

  test("T5a: TAKEOVER_VIA_LEAD=false → today's pool resume path fires, no decision task", async () => {
    setTakeoverViaLeadForTests(false);

    createAgent({ name: "lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "coder-6", isLead: false, status: "busy" });
    const parent = createTaskExtended("Docs update", { agentId: worker.id });
    startTask(parent.id);

    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);

    const findings = await codeLevelTriage();

    // Direct pool resume, not decision task.
    expect(findings.autoResumedTasks.length).toBe(1);
    expect(findings.escalatedTakeovers.length).toBe(0);

    const children = getChildTasks(parent.id);
    expect(children.length).toBe(1);
    expect(children[0]!.taskType).toBe("resume");
  });

  test("T5b: TAKEOVER_VIA_LEAD=false — ordinary unassigned pool tasks are still auto-assigned normally", async () => {
    setTakeoverViaLeadForTests(false);

    createAgent({ name: "lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "idle-worker", isLead: false, status: "idle", maxTasks: 2 });
    const poolTask = createTaskExtended("Pool work item");
    void worker;
    void poolTask;

    const findings = await codeLevelTriage();

    // Auto-assign kicks in for the idle pool task.
    expect(findings.autoAssigned.length).toBeGreaterThanOrEqual(1);
    expect(findings.escalatedTakeovers.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test 6: Skip-guard — stalled takeover-decision task not superseded by crash detector
  // --------------------------------------------------------------------------

  test("T6: stalled takeover-decision task is NOT superseded by detectAndRemediateStalledTasks", async () => {
    setTakeoverViaLeadForTests(true);

    const lead = createAgent({ name: "lead", isLead: true, status: "busy" });
    // Create a decision task directly assigned to the lead, simulate it stalling.
    const decisionTask = createTaskExtended("Stalled decision task", {
      agentId: lead.id,
      taskType: "takeover-decision",
    });
    startTask(decisionTask.id);

    // Age it well past all stall thresholds.
    const veryOldTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      veryOldTime,
      decisionTask.id,
    ]);

    const findings = await codeLevelTriage();

    // The stall detector must NOT touch the decision task — it is handled only by
    // escalateTakeoverTimeouts. The task should not appear in autoFailedTasks.
    const failedDecision = findings.autoFailedTasks.find((f) => f.taskId === decisionTask.id);
    expect(failedDecision).toBeUndefined();

    // The task must still be in_progress (the escalateTakeoverTimeouts handler
    // won't close it because parent doesn't exist or isn't past timeout either).
    const updated = getTaskById(decisionTask.id);
    // Either still in_progress or failed by escalateTakeoverTimeouts (no_parent) — either way,
    // NOT superseded by the crash detector.
    expect(updated?.status).not.toBe("superseded");
  });

  // --------------------------------------------------------------------------
  // Test 7: Idempotency — no double-escalation on repeated sweeps
  // --------------------------------------------------------------------------

  test("T7: repeated sweeps do not create a second takeover-decision task (idempotency)", async () => {
    setTakeoverViaLeadForTests(true);

    const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "coder-7", isLead: false, status: "busy" });
    const parent = createTaskExtended("Long task", { agentId: worker.id });
    startTask(parent.id);

    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, parent.id]);

    // First sweep creates the decision task.
    await codeLevelTriage();

    const children1 = getChildTasks(parent.id);
    expect(children1.filter((c) => c.taskType === "takeover-decision").length).toBe(1);

    // Second sweep: parent is already superseded, decision task already exists.
    const findings2 = await codeLevelTriage();
    expect(findings2.escalatedTakeovers.length).toBe(0);

    const children2 = getChildTasks(parent.id);
    expect(children2.filter((c) => c.taskType === "takeover-decision").length).toBe(1);

    void lead;
  });
});
