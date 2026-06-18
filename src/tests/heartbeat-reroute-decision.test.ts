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
import { MAX_RESUME_GENERATIONS } from "../heartbeat/heartbeat";
import { getTemplateDefinition } from "../prompts/registry";
import { resolveTemplate } from "../prompts/resolver";
import { createRerouteDecisionTask, RESUME_GENERATION_TAG_PREFIX } from "../tasks/worker-follow-up";
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

describe("Heartbeat — reroute-decision fallback (DES-523)", () => {
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
});
