/**
 * DES-523: Lead reroute-decision fallback for crash-recovery resumes that were
 * pinned to their original agent but never reclaimed (the agent that looked
 * recoverable never returned).
 *
 * Phase 2 (here) exercises the capability `createRerouteDecisionTask` directly.
 * Phase 3 extends this file with the heartbeat reaper that invokes it.
 *
 * Mirrors heartbeat-supersede-resume.test.ts's own-sqlite-file setup, plus the
 * `../tools/templates` side-effect import so `task.reroute.decision` resolves.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  failPendingResumeIfUnclaimed,
  getChildTasks,
  getDbClient,
  getLeadAgent,
  getTaskById,
  initDb,
  startTask,
  supersedeTask,
} from "../be/db";
import { createTrackerSync, getTrackerSync } from "../be/db-queries/tracker";
import {
  codeLevelTriage,
  HEARTBEAT_RESUME_PIN_GRACE_MIN,
  maxResumeGenerations,
  RESUME_BUDGET_EXHAUSTED_REASON,
} from "../heartbeat/heartbeat";
import {
  CRASH_RECOVERY_PIN_TAG,
  createRerouteDecisionTask,
  createResumeFollowUp,
  GRACEFUL_SHUTDOWN_PIN_TAG,
  RESUME_GENERATION_TAG_PREFIX,
} from "../tasks/worker-follow-up";
import { registerSendTaskTool } from "../tools/send-task";
// Side-effect import: registers task lifecycle templates (incl. task.reroute.decision).
import "../tools/templates";

const TEST_DB_PATH = "./test-heartbeat-reroute-decision.sqlite";

/**
 * Build the post-crash state: a superseded original + a pending resume R1
 * (generation 1) pinned to the recoverable-looking agent.
 */
async function seedPinnedCrash(agentName: string) {
  const agent = await createAgent({ name: agentName, isLead: false, status: "idle" });
  const original = await createTaskExtended("Crashed worker's original work", {
    agentId: agent.id,
  });
  await startTask(original.id);
  const r1 = await createTaskExtended("Resume of crashed work", {
    agentId: agent.id,
    parentTaskId: original.id,
    taskType: "resume",
    // Mirror a genuine same-agent crash pin: the crash-pin tag is what scopes the
    // reaper's getStalePinnedResumes (pooled resumes never get it).
    tags: [
      "auto-resume",
      "reason:crash_recovery",
      `${RESUME_GENERATION_TAG_PREFIX}1`,
      CRASH_RECOVERY_PIN_TAG,
    ],
  });
  await supersedeTask(original.id, { reason: "crash", resumeTaskId: r1.id });
  return { agent, original: (await getTaskById(original.id))!, r1 };
}

/**
 * Build the graceful-shutdown equivalent: a superseded original + a pending
 * resume R1 (generation 1) pinned to the original agent with its own provenance
 * tag.
 */
async function seedPinnedGracefulShutdown(agentName: string) {
  const agent = await createAgent({ name: agentName, isLead: false, status: "idle" });
  const original = await createTaskExtended("Gracefully stopped worker's original work", {
    agentId: agent.id,
  });
  await startTask(original.id);
  const r1 = await createTaskExtended("Resume of gracefully stopped work", {
    agentId: agent.id,
    parentTaskId: original.id,
    taskType: "resume",
    tags: [
      "auto-resume",
      "reason:graceful_shutdown",
      `${RESUME_GENERATION_TAG_PREFIX}1`,
      GRACEFUL_SHUTDOWN_PIN_TAG,
    ],
  });
  await supersedeTask(original.id, { reason: "shutdown", resumeTaskId: r1.id });
  return { agent, original: (await getTaskById(original.id))!, r1 };
}

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

/** Invoke the registered send-task MCP tool as `callerAgentId` (mirrors send-task-requested-by.test.ts). */
function callSendTask(
  server: McpServer,
  args: Record<string, unknown>,
  callerAgentId: string,
  sourceTaskId?: string,
): Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools["send-task"];
  if (!tool) throw new Error("send-task not registered");
  const headers: Record<string, string> = { "x-agent-id": callerAgentId };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  return tool.handler(args, { sessionId: "test-session", requestInfo: { headers } });
}

function structuredOf(result: CallToolResult) {
  return result.structuredContent as { success: boolean; task?: { id: string }; message: string };
}

/** Age a row's createdAt so the reaper's grace window (measured from createdAt) has elapsed. */
async function ageCreatedAtPastGrace(taskId: string): Promise<void> {
  const old = new Date(
    Date.now() - (HEARTBEAT_RESUME_PIN_GRACE_MIN + 10) * 60 * 1000,
  ).toISOString();
  await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [old, taskId]);
}

describe("Heartbeat — reroute-decision fallback (DES-523)", () => {
  const sendTaskServer = new McpServer({ name: "test-reroute-send-task", version: "1.0.0" });
  registerSendTaskTool(sendTaskServer);

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

  beforeEach(async () => {
    const client = getDbClient();
    await client.run("DELETE FROM tracker_sync");
    await client.run("DELETE FROM agent_tasks");
    await client.run("DELETE FROM agents");
    await client.run("DELETE FROM active_sessions");
  });

  // --------------------------------------------------------------------------
  // Phase 2 — capability (createRerouteDecisionTask) invoked directly
  // --------------------------------------------------------------------------

  test("creates a Lead-owned reroute-decision; resume not pooled, original not reassigned to Lead", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "busy" });
    const { agent, original, r1 } = await seedPinnedCrash("coder-7");
    // Give the crashed agent an identity slice so the template carries context.
    await getDbClient().run("UPDATE agents SET identityMd = ? WHERE id = ?", [
      "Senior backend coder — owns the billing service.",
      agent.id,
    ]);

    const result = await createRerouteDecisionTask({
      original,
      staleResume: r1,
      reason: "crash_recovery",
      maxGenerations: maxResumeGenerations(),
    });

    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("expected created");
    const decision = result.task;

    // Lead-owned decision task, distinct taskType, parented to the original.
    expect(decision.agentId).toBe(lead.id);
    expect(decision.taskType).toBe("reroute-decision");
    expect(decision.parentTaskId).toBe(original.id);
    expect(decision.status).toBe("pending");

    // Body: references the original, the crashed-agent identity, and the
    // mandatory send-task re-delegation instructions.
    expect(decision.task).toContain(original.id);
    expect(decision.task).toContain("coder-7");
    expect(decision.task).toContain("billing service");
    expect(decision.task).toContain("send-task");
    expect(decision.task).toContain('taskType: "resume"');
    // Generation derived from the FAILED PIN (R1 = gen 1) → next = 2 (of max).
    expect(decision.task).toContain(`${RESUME_GENERATION_TAG_PREFIX}2`);
    expect(decision.task).toContain(`2 of ${maxResumeGenerations()}`);
    // No unresolved template variables leaked into the body.
    expect(decision.task).not.toContain("{{");

    // The resume R1 is NOT pooled — still pending, still pinned to the agent.
    const reFetchedR1 = (await getTaskById(r1.id))!;
    expect(reFetchedR1.status).toBe("pending");
    expect(reFetchedR1.agentId).toBe(agent.id);

    // The original work task was NOT reassigned to the Lead.
    expect((await getTaskById(original.id))!.agentId).toBe(agent.id);
  });

  test("idempotent: a second call does not create a duplicate decision", async () => {
    await createAgent({ name: "lead", isLead: true, status: "busy" });
    const { original, r1 } = await seedPinnedCrash("coder-dup");

    const first = await createRerouteDecisionTask({
      original,
      staleResume: r1,
      reason: "crash_recovery",
      maxGenerations: maxResumeGenerations(),
    });
    expect(first.kind).toBe("created");

    const second = await createRerouteDecisionTask({
      original,
      staleResume: r1,
      reason: "crash_recovery",
      maxGenerations: maxResumeGenerations(),
    });
    expect(second.kind).toBe("skipped");
    if (second.kind === "skipped") expect(second.reason).toBe("duplicate_exists");

    const decisions = (await getChildTasks(original.id)).filter(
      (c) => c.taskType === "reroute-decision",
    );
    expect(decisions.length).toBe(1);
  });

  test("no lead agent → no-op (skipped: lead_not_found), no decision created", async () => {
    const { original, r1 } = await seedPinnedCrash("coder-nolead"); // no lead created

    const result = await createRerouteDecisionTask({
      original,
      staleResume: r1,
      reason: "crash_recovery",
      maxGenerations: maxResumeGenerations(),
    });
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("lead_not_found");
    expect(
      (await getChildTasks(original.id)).filter((c) => c.taskType === "reroute-decision").length,
    ).toBe(0);
  });

  // NOTE: a dedicated "template resolves with no unresolved variables" test was
  // removed — it depended on the shared in-memory template registry (cleared by
  // prompt-template-resolver.test.ts in the same `bun test` process) and flaked.
  // The property is already covered by the first Phase-2 test above, which renders
  // the template via createRerouteDecisionTask and asserts `not.toContain("{{")`.

  // --------------------------------------------------------------------------
  // Phase 3 — reaper (escalateUnreclaimedResumes, run via codeLevelTriage)
  // --------------------------------------------------------------------------

  test("pinned resume older than grace → escalated to a Lead decision exactly once (idempotent)", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "busy" });
    const { original, r1 } = await seedPinnedCrash("coder-grace");
    await ageCreatedAtPastGrace(r1.id);

    const first = await codeLevelTriage();
    expect(first.escalatedReroutes.length).toBe(1);
    expect(first.escalatedReroutes[0]!.originalTaskId).toBe(original.id);

    // R1 was terminalized (no longer pending) and a Lead-owned decision exists.
    expect((await getTaskById(r1.id))!.status).not.toBe("pending");
    const decisions = (await getChildTasks(original.id)).filter(
      (c) => c.taskType === "reroute-decision",
    );
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.agentId).toBe(lead.id);

    // Idempotent: second sweep — R1 is no longer pending, so it is not re-escalated.
    const second = await codeLevelTriage();
    expect(second.escalatedReroutes.length).toBe(0);
    expect(
      (await getChildTasks(original.id)).filter((c) => c.taskType === "reroute-decision").length,
    ).toBe(1);
  });

  test("stale graceful_shutdown pin older than grace → escalated to a Lead decision", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "busy" });
    const { original, r1 } = await seedPinnedGracefulShutdown("coder-graceful");
    expect(r1.tags).toContain(GRACEFUL_SHUTDOWN_PIN_TAG);
    await ageCreatedAtPastGrace(r1.id);

    const findings = await codeLevelTriage();

    expect(findings.escalatedReroutes.length).toBe(1);
    expect(findings.escalatedReroutes[0]!.originalTaskId).toBe(original.id);
    expect((await getTaskById(r1.id))!.status).not.toBe("pending");
    const decisions = (await getChildTasks(original.id)).filter(
      (c) => c.taskType === "reroute-decision",
    );
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.agentId).toBe(lead.id);

    const second = await codeLevelTriage();
    expect(second.escalatedReroutes.length).toBe(0);
    expect(
      (await getChildTasks(original.id)).filter((c) => c.taskType === "reroute-decision").length,
    ).toBe(1);
  });

  test("pinned resume reclaimed (in_progress) before the grace window is NOT escalated", async () => {
    await createAgent({ name: "lead", isLead: true, status: "busy" });
    const { original, r1 } = await seedPinnedCrash("coder-reclaim");
    await ageCreatedAtPastGrace(r1.id);
    // The original agent returned and reclaimed it: pending → in_progress. startTask
    // also refreshes lastUpdatedAt, so the stall detector leaves it alone too.
    await startTask(r1.id);
    expect((await getTaskById(r1.id))!.status).toBe("in_progress");

    const findings = await codeLevelTriage();
    expect(findings.escalatedReroutes.length).toBe(0);
    expect(
      (await getChildTasks(original.id)).filter((c) => c.taskType === "reroute-decision").length,
    ).toBe(0);
    // The reclaimed resume is untouched — the reaper's status='pending' clause excludes it.
    expect((await getTaskById(r1.id))!.status).toBe("in_progress");
  });

  test("pinned resume at the generation cap → terminalized as budget-exhausted, NOT escalated", async () => {
    await createAgent({ name: "lead", isLead: true, status: "busy" });
    const agent = await createAgent({ name: "coder-cap", isLead: false, status: "idle" });
    const original = await createTaskExtended("capped work", { agentId: agent.id });
    await startTask(original.id);
    const capped = await createTaskExtended("resume at cap", {
      agentId: agent.id,
      parentTaskId: original.id,
      taskType: "resume",
      tags: [
        "auto-resume",
        "reason:crash_recovery",
        `${RESUME_GENERATION_TAG_PREFIX}${maxResumeGenerations()}`,
        CRASH_RECOVERY_PIN_TAG,
      ],
    });
    await supersedeTask(original.id, { reason: "crash", resumeTaskId: capped.id });
    await ageCreatedAtPastGrace(capped.id);

    const findings = await codeLevelTriage();
    expect(findings.escalatedReroutes.length).toBe(0);
    expect(
      (await getChildTasks(original.id)).filter((c) => c.taskType === "reroute-decision").length,
    ).toBe(0);
    const updated = (await getTaskById(capped.id))!;
    expect(updated.status).toBe("failed");
    expect(updated.failureReason).toBe(RESUME_BUDGET_EXHAUSTED_REASON);
  });

  test("tracker_sync chain on the gone-agent path: original → R1 → original → R2", async () => {
    const lead = await createAgent({ name: "lead", isLead: true, status: "busy" });
    const agentA = await createAgent({ name: "coder-A", isLead: false, status: "idle" });
    const agentB = await createAgent({ name: "coder-B", isLead: false, status: "idle" });
    const original = await createTaskExtended("tracked crashed work", { agentId: agentA.id });
    await startTask(original.id);
    await createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: original.id,
      externalId: "ENG-900",
      externalIdentifier: "ENG-900",
      externalUrl: "https://linear.app/test/issue/ENG-900",
    });

    // Pin via the real path: supersede frees capacity, then createResumeFollowUp pins
    // R1 to agentA AND repoints the tracker original → R1.
    await supersedeTask(original.id, { reason: "crash", resumeTaskId: null });
    const pin = await createResumeFollowUp({ parentId: original.id, reason: "crash_recovery" });
    expect(pin.kind).toBe("created");
    if (pin.kind !== "created") throw new Error("expected pin");
    const r1 = pin.task;
    expect(r1.agentId).toBe(agentA.id);
    expect((await getTrackerSync("linear", "task", r1.id))?.externalId).toBe("ENG-900");
    expect(await getTrackerSync("linear", "task", original.id)).toBeNull();

    // Reaper: R1 stale → terminalize + repoint tracker R1 → original + Lead decision.
    await ageCreatedAtPastGrace(r1.id);
    const findings = await codeLevelTriage();
    expect(findings.escalatedReroutes.length).toBe(1);
    expect((await getTaskById(r1.id))!.status).not.toBe("pending");
    expect((await getTrackerSync("linear", "task", original.id))?.externalId).toBe("ENG-900");
    expect(await getTrackerSync("linear", "task", r1.id)).toBeNull();

    const decision = (await getChildTasks(original.id)).find(
      (c) => c.taskType === "reroute-decision",
    );
    expect(decision).toBeDefined();

    // Lead re-delegates to agent B via send-task (taskType resume, parentTaskId original).
    // transferTrackerSyncToResumeChild repoints the tracker original → R2.
    const result = await callSendTask(
      sendTaskServer,
      {
        task: "Resume the crashed work on B",
        agentId: agentB.id,
        taskType: "resume",
        parentTaskId: original.id,
        allowDuplicate: true,
      },
      lead.id,
      decision!.id,
    );
    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const r2Id = s.task!.id;
    expect((await getTrackerSync("linear", "task", r2Id))?.externalId).toBe("ENG-900");
    expect(await getTrackerSync("linear", "task", original.id)).toBeNull();
    expect(await getTrackerSync("linear", "task", r1.id)).toBeNull();
  });

  test("a fresh (within-grace) crash pin is NOT escalated by the reaper", async () => {
    await createAgent({ name: "lead", isLead: true, status: "busy" });
    const { original, r1 } = await seedPinnedCrash("coder-fresh");
    // Deliberately do NOT age createdAt — the pin is well within the grace
    // window, so the reaper must leave it alone. (Guards against a regression
    // that drops/inverts the createdAt cutoff and escalates pins immediately.)

    const findings = await codeLevelTriage();

    expect(findings.escalatedReroutes.length).toBe(0);
    expect((await getTaskById(r1.id))!.status).toBe("pending"); // still pinned, untouched
    expect(
      (await getChildTasks(original.id)).filter((c) => c.taskType === "reroute-decision").length,
    ).toBe(0);
  });

  test("failPendingResumeIfUnclaimed cancels a pending resume but no-ops a reclaimed (in_progress) one", async () => {
    const agent = await createAgent({ name: "toctou-agent", isLead: false, status: "idle" });
    const parent = await createTaskExtended("toctou parent", { agentId: agent.id });
    await startTask(parent.id);

    // (a) pending → terminalized, row returned.
    const pendingResume = await createTaskExtended("pending resume", {
      agentId: agent.id,
      parentTaskId: parent.id,
      taskType: "resume",
    });
    expect(pendingResume.status).toBe("pending");
    const cancelled = await failPendingResumeIfUnclaimed(
      pendingResume.id,
      "cancelled",
      "test_reason",
    );
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("cancelled");
    expect((await getTaskById(pendingResume.id))!.status).toBe("cancelled");

    // (b) in_progress (reclaimed in the gap) → null, status untouched. This is
    // the load-bearing TOCTOU guard (AND status='pending') the function exists for.
    const reclaimed = await createTaskExtended("reclaimed resume", {
      agentId: agent.id,
      parentTaskId: parent.id,
      taskType: "resume",
    });
    await startTask(reclaimed.id);
    expect((await getTaskById(reclaimed.id))!.status).toBe("in_progress");
    const result = await failPendingResumeIfUnclaimed(reclaimed.id, "cancelled", "test_reason");
    expect(result).toBeNull();
    expect((await getTaskById(reclaimed.id))!.status).toBe("in_progress");
  });

  test("a pooled (untagged) resume auto-assigned in the same sweep is NOT reaped", async () => {
    // Regression for the same-sweep race: getStalePinnedResumes used to match ANY
    // pending resume with an old createdAt. autoAssignPoolTasks (runs before the
    // reaper in the same codeLevelTriage sweep) flips a lingering unassigned
    // resume to `pending` keeping its old createdAt, and the reaper would then
    // cancel it before the assigned worker polls. The crash-pin tag scoping fixes
    // it — a pooled resume never carries the tag.
    await createAgent({ name: "lead", isLead: true, status: "busy" });
    const worker = await createAgent({ name: "idle-worker", isLead: false, status: "idle" });
    const original = await createTaskExtended("pooled original", { agentId: worker.id });
    await startTask(original.id);
    const pooled = await createTaskExtended("pooled resume (no pin tag)", {
      parentTaskId: original.id,
      taskType: "resume",
      tags: ["auto-resume", "reason:graceful_shutdown", `${RESUME_GENERATION_TAG_PREFIX}1`],
    });
    expect(pooled.status).toBe("unassigned");
    await supersedeTask(original.id, { reason: "shutdown", resumeTaskId: pooled.id });
    await ageCreatedAtPastGrace(pooled.id);

    const findings = await codeLevelTriage();

    // autoAssignPoolTasks assigned it to the idle worker; the reaper left it alone.
    const after = (await getTaskById(pooled.id))!;
    expect(after.status).toBe("pending");
    expect(after.agentId).toBe(worker.id);
    expect(findings.escalatedReroutes.length).toBe(0);
    expect(
      (await getChildTasks(original.id)).filter((c) => c.taskType === "reroute-decision").length,
    ).toBe(0);
  });

  test("a pin at generation MAX-1 escalates (not budget-failed) with next-generation = MAX", async () => {
    await createAgent({ name: "lead", isLead: true, status: "busy" });
    const agent = await createAgent({ name: "coder-genmax", isLead: false, status: "idle" });
    const original = await createTaskExtended("near-cap work", { agentId: agent.id });
    await startTask(original.id);
    const r = await createTaskExtended("resume near cap", {
      agentId: agent.id,
      parentTaskId: original.id,
      taskType: "resume",
      tags: [
        "auto-resume",
        "reason:crash_recovery",
        `${RESUME_GENERATION_TAG_PREFIX}${maxResumeGenerations() - 1}`,
        CRASH_RECOVERY_PIN_TAG,
      ],
    });
    await supersedeTask(original.id, { reason: "crash", resumeTaskId: r.id });
    await ageCreatedAtPastGrace(r.id);

    const findings = await codeLevelTriage();

    expect(findings.escalatedReroutes.length).toBe(1);
    const decision = (await getChildTasks(original.id)).find(
      (c) => c.taskType === "reroute-decision",
    );
    expect(decision).toBeDefined();
    // generation_next derives from the failed pin (MAX-1) → MAX.
    expect(decision!.task).toContain(`${RESUME_GENERATION_TAG_PREFIX}${maxResumeGenerations()}`);
  });

  // --------------------------------------------------------------------------
  // Review hardening (codex PR review on #791)
  // --------------------------------------------------------------------------

  test("reroute-decision does NOT inherit the original's outputSchema (control task stays completable)", async () => {
    await createAgent({ name: "lead", isLead: true, status: "busy" });
    const agent = await createAgent({ name: "coder-schema", isLead: false, status: "idle" });
    const original = await createTaskExtended("work with a strict output contract", {
      agentId: agent.id,
      outputSchema: {
        type: "object",
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
    });
    await startTask(original.id);
    // A normal resume child DOES inherit the schema (proves inheritance is the default
    // and the decision's opt-out is targeted, not a global change).
    const r1 = await createTaskExtended("resume of schema work", {
      agentId: agent.id,
      parentTaskId: original.id,
      taskType: "resume",
      tags: [
        "auto-resume",
        "reason:crash_recovery",
        `${RESUME_GENERATION_TAG_PREFIX}1`,
        CRASH_RECOVERY_PIN_TAG,
      ],
    });
    expect(r1.outputSchema).toBeDefined();
    await supersedeTask(original.id, { reason: "crash", resumeTaskId: r1.id });

    const result = await createRerouteDecisionTask({
      original: (await getTaskById(original.id))!,
      staleResume: r1,
      reason: "crash_recovery",
      maxGenerations: maxResumeGenerations(),
    });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("expected created");
    // The Lead completes this control task by re-delegating, not by producing the
    // original work's structured output — so it must NOT carry the contract.
    expect(result.task.outputSchema).toBeUndefined();
  });

  test("offline-only Lead → reaper leaves the pin pending (no escalation to an unpollable Lead)", async () => {
    await createAgent({ name: "stale-lead", isLead: true, status: "offline" });
    const { original, r1 } = await seedPinnedCrash("coder-offlinelead");
    await ageCreatedAtPastGrace(r1.id);

    const findings = await codeLevelTriage();

    expect(findings.escalatedReroutes.length).toBe(0);
    // Pin is left pending (recoverable when a live Lead returns), NOT cancelled.
    expect((await getTaskById(r1.id))!.status).toBe("pending");
    expect(
      (await getChildTasks(original.id)).filter((c) => c.taskType === "reroute-decision").length,
    ).toBe(0);
  });

  test("getLeadAgent prefers a non-offline lead, falls back to any when all offline", async () => {
    const offline = await createAgent({ name: "old-lead", isLead: true, status: "offline" });
    const online = await createAgent({ name: "new-lead", isLead: true, status: "idle" });
    // The offline lead was registered first but must not shadow the live one.
    expect((await getLeadAgent())!.id).toBe(online.id);
    // When every lead is offline, still return one (preserves "is there a lead?" semantics).
    await getDbClient().run("UPDATE agents SET status = 'offline' WHERE id = ?", [online.id]);
    expect((await getLeadAgent())!.isLead).toBe(true);
    expect(offline.isLead).toBe(true); // (referenced to keep the binding meaningful)
  });

  test("a crashed reroute-decision is NOT auto-resumed — failed, no crash-recovery pin (no nested decisions)", async () => {
    await createAgent({ name: "lead", isLead: true, status: "busy" });
    const agent = await createAgent({ name: "coder-control", isLead: false, status: "idle" });
    const original = await createTaskExtended("original user work", { agentId: agent.id });
    // A Lead-owned reroute-decision the Lead started, then crashed on.
    const decision = await createTaskExtended("decide where to reroute", {
      agentId: agent.id,
      parentTaskId: original.id,
      taskType: "reroute-decision",
      tags: ["reroute-decision"],
    });
    await startTask(decision.id); // in_progress
    // Stale + no active session → the no-session crash branch (Case A).
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      old,
      decision.id,
    ]);

    await codeLevelTriage();

    // Failed via the legacy path (skip-auto-resume), NOT superseded into a resume.
    expect((await getTaskById(decision.id))!.status).toBe("failed");
    expect((await getChildTasks(decision.id)).filter((c) => c.taskType === "resume").length).toBe(
      0,
    );
  });
});
