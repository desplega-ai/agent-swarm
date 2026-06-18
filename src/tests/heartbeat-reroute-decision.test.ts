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
  getChildTasks,
  getDb,
  getTaskById,
  initDb,
  startTask,
  supersedeTask,
} from "../be/db";
import { createTrackerSync, getTrackerSync } from "../be/db-queries/tracker";
import {
  codeLevelTriage,
  HEARTBEAT_RESUME_PIN_GRACE_MIN,
  MAX_RESUME_GENERATIONS,
  RESUME_BUDGET_EXHAUSTED_REASON,
} from "../heartbeat/heartbeat";
import { getTemplateDefinition } from "../prompts/registry";
import { resolveTemplate } from "../prompts/resolver";
import {
  createRerouteDecisionTask,
  createResumeFollowUp,
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
function seedPinnedCrash(agentName: string) {
  const agent = createAgent({ name: agentName, isLead: false, status: "idle" });
  const original = createTaskExtended("Crashed worker's original work", { agentId: agent.id });
  startTask(original.id);
  const r1 = createTaskExtended("Resume of crashed work", {
    agentId: agent.id,
    parentTaskId: original.id,
    taskType: "resume",
    tags: ["auto-resume", "reason:crash_recovery", `${RESUME_GENERATION_TAG_PREFIX}1`],
  });
  supersedeTask(original.id, { reason: "crash", resumeTaskId: r1.id });
  return { agent, original: getTaskById(original.id)!, r1 };
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
function ageCreatedAtPastGrace(taskId: string) {
  const old = new Date(
    Date.now() - (HEARTBEAT_RESUME_PIN_GRACE_MIN + 10) * 60 * 1000,
  ).toISOString();
  getDb().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [old, taskId]);
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

  beforeEach(() => {
    getDb().run("DELETE FROM tracker_sync");
    getDb().run("DELETE FROM agent_tasks");
    getDb().run("DELETE FROM agents");
    getDb().run("DELETE FROM active_sessions");
  });

  // --------------------------------------------------------------------------
  // Phase 2 — capability (createRerouteDecisionTask) invoked directly
  // --------------------------------------------------------------------------

  test("creates a Lead-owned reroute-decision; resume not pooled, original not reassigned to Lead", () => {
    const lead = createAgent({ name: "lead", isLead: true, status: "busy" });
    const { agent, original, r1 } = seedPinnedCrash("coder-7");
    // Give the crashed agent an identity slice so the template carries context.
    getDb().run("UPDATE agents SET identityMd = ? WHERE id = ?", [
      "Senior backend coder — owns the billing service.",
      agent.id,
    ]);

    const result = createRerouteDecisionTask({
      original,
      staleResume: r1,
      reason: "crash_recovery",
      maxGenerations: MAX_RESUME_GENERATIONS,
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
    expect(decision.task).toContain(`2 of ${MAX_RESUME_GENERATIONS}`);
    // No unresolved template variables leaked into the body.
    expect(decision.task).not.toContain("{{");

    // The resume R1 is NOT pooled — still pending, still pinned to the agent.
    const reFetchedR1 = getTaskById(r1.id)!;
    expect(reFetchedR1.status).toBe("pending");
    expect(reFetchedR1.agentId).toBe(agent.id);

    // The original work task was NOT reassigned to the Lead.
    expect(getTaskById(original.id)!.agentId).toBe(agent.id);
  });

  test("idempotent: a second call does not create a duplicate decision", () => {
    createAgent({ name: "lead", isLead: true, status: "busy" });
    const { original, r1 } = seedPinnedCrash("coder-dup");

    const first = createRerouteDecisionTask({
      original,
      staleResume: r1,
      reason: "crash_recovery",
      maxGenerations: MAX_RESUME_GENERATIONS,
    });
    expect(first.kind).toBe("created");

    const second = createRerouteDecisionTask({
      original,
      staleResume: r1,
      reason: "crash_recovery",
      maxGenerations: MAX_RESUME_GENERATIONS,
    });
    expect(second.kind).toBe("skipped");
    if (second.kind === "skipped") expect(second.reason).toBe("duplicate_exists");

    const decisions = getChildTasks(original.id).filter((c) => c.taskType === "reroute-decision");
    expect(decisions.length).toBe(1);
  });

  test("no lead agent → no-op (skipped: lead_not_found), no decision created", () => {
    const { original, r1 } = seedPinnedCrash("coder-nolead"); // no lead created

    const result = createRerouteDecisionTask({
      original,
      staleResume: r1,
      reason: "crash_recovery",
      maxGenerations: MAX_RESUME_GENERATIONS,
    });
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("lead_not_found");
    expect(getChildTasks(original.id).filter((c) => c.taskType === "reroute-decision").length).toBe(
      0,
    );
  });

  test("task.reroute.decision template resolves with no unresolved variables", () => {
    const def = getTemplateDefinition("task.reroute.decision");
    expect(def).toBeDefined();
    const vars = Object.fromEntries((def?.variables ?? []).map((v) => [v.name, `val-${v.name}`]));
    const res = resolveTemplate("task.reroute.decision", vars);
    expect(res.unresolved.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Phase 3 — reaper (escalateUnreclaimedResumes, run via codeLevelTriage)
  // --------------------------------------------------------------------------

  test("pinned resume older than grace → escalated to a Lead decision exactly once (idempotent)", async () => {
    const lead = createAgent({ name: "lead", isLead: true, status: "busy" });
    const { original, r1 } = seedPinnedCrash("coder-grace");
    ageCreatedAtPastGrace(r1.id);

    const first = await codeLevelTriage();
    expect(first.escalatedReroutes.length).toBe(1);
    expect(first.escalatedReroutes[0]!.originalTaskId).toBe(original.id);

    // R1 was terminalized (no longer pending) and a Lead-owned decision exists.
    expect(getTaskById(r1.id)!.status).not.toBe("pending");
    const decisions = getChildTasks(original.id).filter((c) => c.taskType === "reroute-decision");
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.agentId).toBe(lead.id);

    // Idempotent: second sweep — R1 is no longer pending, so it is not re-escalated.
    const second = await codeLevelTriage();
    expect(second.escalatedReroutes.length).toBe(0);
    expect(getChildTasks(original.id).filter((c) => c.taskType === "reroute-decision").length).toBe(
      1,
    );
  });

  test("pinned resume reclaimed (in_progress) before the grace window is NOT escalated", async () => {
    createAgent({ name: "lead", isLead: true, status: "busy" });
    const { original, r1 } = seedPinnedCrash("coder-reclaim");
    ageCreatedAtPastGrace(r1.id);
    // The original agent returned and reclaimed it: pending → in_progress. startTask
    // also refreshes lastUpdatedAt, so the stall detector leaves it alone too.
    startTask(r1.id);
    expect(getTaskById(r1.id)!.status).toBe("in_progress");

    const findings = await codeLevelTriage();
    expect(findings.escalatedReroutes.length).toBe(0);
    expect(getChildTasks(original.id).filter((c) => c.taskType === "reroute-decision").length).toBe(
      0,
    );
    // The reclaimed resume is untouched — the reaper's status='pending' clause excludes it.
    expect(getTaskById(r1.id)!.status).toBe("in_progress");
  });

  test("pinned resume at the generation cap → terminalized as budget-exhausted, NOT escalated", async () => {
    createAgent({ name: "lead", isLead: true, status: "busy" });
    const agent = createAgent({ name: "coder-cap", isLead: false, status: "idle" });
    const original = createTaskExtended("capped work", { agentId: agent.id });
    startTask(original.id);
    const capped = createTaskExtended("resume at cap", {
      agentId: agent.id,
      parentTaskId: original.id,
      taskType: "resume",
      tags: [
        "auto-resume",
        "reason:crash_recovery",
        `${RESUME_GENERATION_TAG_PREFIX}${MAX_RESUME_GENERATIONS}`,
      ],
    });
    supersedeTask(original.id, { reason: "crash", resumeTaskId: capped.id });
    ageCreatedAtPastGrace(capped.id);

    const findings = await codeLevelTriage();
    expect(findings.escalatedReroutes.length).toBe(0);
    expect(getChildTasks(original.id).filter((c) => c.taskType === "reroute-decision").length).toBe(
      0,
    );
    const updated = getTaskById(capped.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.failureReason).toBe(RESUME_BUDGET_EXHAUSTED_REASON);
  });

  test("tracker_sync chain on the gone-agent path: original → R1 → original → R2", async () => {
    const lead = createAgent({ name: "lead", isLead: true, status: "busy" });
    const agentA = createAgent({ name: "coder-A", isLead: false, status: "idle" });
    const agentB = createAgent({ name: "coder-B", isLead: false, status: "idle" });
    const original = createTaskExtended("tracked crashed work", { agentId: agentA.id });
    startTask(original.id);
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: original.id,
      externalId: "ENG-900",
      externalIdentifier: "ENG-900",
      externalUrl: "https://linear.app/test/issue/ENG-900",
    });

    // Pin via the real path: supersede frees capacity, then createResumeFollowUp pins
    // R1 to agentA AND repoints the tracker original → R1.
    supersedeTask(original.id, { reason: "crash", resumeTaskId: null });
    const pin = createResumeFollowUp({ parentId: original.id, reason: "crash_recovery" });
    expect(pin.kind).toBe("created");
    if (pin.kind !== "created") throw new Error("expected pin");
    const r1 = pin.task;
    expect(r1.agentId).toBe(agentA.id);
    expect(getTrackerSync("linear", "task", r1.id)?.externalId).toBe("ENG-900");
    expect(getTrackerSync("linear", "task", original.id)).toBeNull();

    // Reaper: R1 stale → terminalize + repoint tracker R1 → original + Lead decision.
    ageCreatedAtPastGrace(r1.id);
    const findings = await codeLevelTriage();
    expect(findings.escalatedReroutes.length).toBe(1);
    expect(getTaskById(r1.id)!.status).not.toBe("pending");
    expect(getTrackerSync("linear", "task", original.id)?.externalId).toBe("ENG-900");
    expect(getTrackerSync("linear", "task", r1.id)).toBeNull();

    const decision = getChildTasks(original.id).find((c) => c.taskType === "reroute-decision");
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
    expect(getTrackerSync("linear", "task", r2Id)?.externalId).toBe("ENG-900");
    expect(getTrackerSync("linear", "task", original.id)).toBeNull();
    expect(getTrackerSync("linear", "task", r1.id)).toBeNull();
  });
});
