import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  assignUnassignedTaskPending,
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentById,
  getDbClient,
  getTaskById,
  getUnassignedTaskIdsForAgent,
  initDb,
  isAgentEligibleForTask,
  updateAgentProfile,
} from "../be/db";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import { createPoolStarvationDecisionTask } from "../tasks/worker-follow-up";
import type { RoutingAffinity } from "../types";
// Side-effect import: registers task lifecycle templates (incl.
// task.pool.starved.decision), mirroring heartbeat-reroute-decision.test.ts.
import "../tools/templates";

const TEST_DB_PATH = "./test-pool-affinity.sqlite";

describe("Pool Affinity", () => {
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
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  // Clean up between tests to avoid interference
  beforeEach(async () => {
    await getDbClient().run("DELETE FROM agent_tasks");
    await getDbClient().run("DELETE FROM agents");
    await getDbClient().run("DELETE FROM agent_log");
  });

  function affinity(overrides: Partial<RoutingAffinity>): RoutingAffinity {
    return { capabilities: [], ...overrides };
  }

  // ==========================================================================
  // isAgentEligibleForTask matrix
  // ==========================================================================

  describe("isAgentEligibleForTask", () => {
    test("untagged task (no routingAffinity) is eligible for anyone", async () => {
      const agent = await createAgent({ name: "no-role-agent", isLead: false, status: "idle" });
      const task = await createTaskExtended("Untagged task");
      expect(isAgentEligibleForTask(agent, task)).toBe(true);
    });

    test("lead-only blocks a worker even when it is the affinity source", async () => {
      const worker = await createAgent({
        name: "privileged-worker",
        isLead: false,
        status: "idle",
      });
      const task = await createTaskExtended("Merge", {
        routingAffinity: affinity({ sourceAgentId: worker.id, leadOnly: true }),
      });
      expect(isAgentEligibleForTask(worker, task)).toBe(false);
      expect(await claimTask(task.id, worker.id)).toBeNull();
    });

    test("lead-only accepts a Lead and rejects direct worker assignment", async () => {
      const worker = await createAgent({ name: "direct-worker", isLead: false, status: "idle" });
      const lead = await createAgent({ name: "privileged-lead", isLead: true, status: "idle" });
      await expect(
        createTaskExtended("Merge", {
          agentId: worker.id,
          routingAffinity: affinity({ leadOnly: true }),
        }),
      ).rejects.toThrow("Lead-only task");
      const task = await createTaskExtended("Merge", {
        agentId: lead.id,
        routingAffinity: affinity({ leadOnly: true }),
      });
      expect(task.agentId).toBe(lead.id);
    });

    test("an unassigned lead-only task is claimable by a Lead but not a worker", async () => {
      const worker = await createAgent({ name: "pool-worker", isLead: false, status: "idle" });
      const lead = await createAgent({ name: "pool-lead", isLead: true, status: "idle" });
      const task = await createTaskExtended("Merge", {
        routingAffinity: affinity({ leadOnly: true }),
      });

      expect(await claimTask(task.id, worker.id)).toBeNull();
      expect(await claimTask(task.id, lead.id)).not.toBeNull();
    });

    test("malformed and schema-invalid persisted affinities are quarantined", async () => {
      const worker = await createAgent({
        name: "quarantine-worker",
        isLead: false,
        status: "idle",
      });
      const lead = await createAgent({ name: "quarantine-lead", isLead: true, status: "idle" });
      const malformed = await createTaskExtended("Malformed affinity");
      const schemaInvalid = await createTaskExtended("Invalid affinity", {
        routingAffinity: affinity({ leadOnly: true }),
      });
      await getDbClient().run("UPDATE agent_tasks SET routingAffinity = ? WHERE id = ?", [
        "{not-json",
        malformed.id,
      ]);
      await getDbClient().run("UPDATE agent_tasks SET routingAffinity = ? WHERE id = ?", [
        JSON.stringify({ leadOnly: true, capabilities: "bad" }),
        schemaInvalid.id,
      ]);

      for (const task of [malformed, schemaInvalid]) {
        expect((await getTaskById(task.id))?.routingAffinityInvalid).toBe(true);
        expect(await claimTask(task.id, worker.id)).toBeNull();
        expect(await assignUnassignedTaskPending(task.id, lead.id)).toBeNull();
        expect(await getUnassignedTaskIdsForAgent(lead.id)).not.toContain(task.id);
        expect((await getTaskById(task.id))?.status).toBe("unassigned");
      }
    });

    test("sourceAgentId bypass: own work is eligible even with a mismatched role", async () => {
      const owner = await createAgent({ name: "owner", isLead: false, status: "idle" });
      await updateAgentProfile(owner.id, { role: "researcher" });
      const ownerAgent = (await getAgentById(owner.id))!;
      const task = await createTaskExtended("Own work", {
        routingAffinity: affinity({ sourceAgentId: owner.id, role: "coder" }),
      });
      expect(isAgentEligibleForTask(ownerAgent, task)).toBe(true);
    });

    test("exact role match is eligible", async () => {
      const agent = await createAgent({ name: "coder-1", isLead: false, status: "idle" });
      await updateAgentProfile(agent.id, { role: "coder" });
      const coderAgent = (await getAgentById(agent.id))!;
      const task = await createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });
      expect(isAgentEligibleForTask(coderAgent, task)).toBe(true);
    });

    test("role mismatch is ineligible", async () => {
      const agent = await createAgent({ name: "researcher-1", isLead: false, status: "idle" });
      await updateAgentProfile(agent.id, { role: "researcher" });
      const researcherAgent = (await getAgentById(agent.id))!;
      const task = await createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });
      expect(isAgentEligibleForTask(researcherAgent, task)).toBe(false);
    });

    test("missing role on the agent is ineligible — no fail-open", async () => {
      const agent = await createAgent({ name: "no-role-agent-2", isLead: false, status: "idle" });
      const task = await createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });
      expect(isAgentEligibleForTask(agent, task)).toBe(false);
    });

    test("missing role on the task's affinity (capabilities-only) is ineligible for a non-owner — no fail-open", async () => {
      const agent = await createAgent({ name: "coder-2", isLead: false, status: "idle" });
      await updateAgentProfile(agent.id, { role: "coder" });
      const coderAgent = (await getAgentById(agent.id))!;
      const task = await createTaskExtended("Capability-only task", {
        routingAffinity: affinity({ capabilities: ["datadog"] }),
      });
      expect(isAgentEligibleForTask(coderAgent, task)).toBe(false);
    });

    test("capability subset: missing a required capability is ineligible", async () => {
      const agent = await createAgent({ name: "coder-3", isLead: false, status: "idle" });
      await updateAgentProfile(agent.id, { role: "coder", capabilities: ["typescript"] });
      const coderAgent = (await getAgentById(agent.id))!;
      const task = await createTaskExtended("Needs datadog", {
        routingAffinity: affinity({ role: "coder", capabilities: ["datadog"] }),
      });
      expect(isAgentEligibleForTask(coderAgent, task)).toBe(false);
    });

    test("capability subset: a superset of required capabilities is eligible", async () => {
      const agent = await createAgent({ name: "coder-4", isLead: false, status: "idle" });
      await updateAgentProfile(agent.id, {
        role: "coder",
        capabilities: ["typescript", "datadog"],
      });
      const coderAgent = (await getAgentById(agent.id))!;
      const task = await createTaskExtended("Needs datadog", {
        routingAffinity: affinity({ role: "coder", capabilities: ["datadog"] }),
      });
      expect(isAgentEligibleForTask(coderAgent, task)).toBe(true);
    });

    test("kill-switch: POOL_AFFINITY_ENFORCEMENT=0 makes every task eligible", async () => {
      const previous = process.env.POOL_AFFINITY_ENFORCEMENT;
      process.env.POOL_AFFINITY_ENFORCEMENT = "0";
      try {
        const agent = await createAgent({ name: "researcher-2", isLead: false, status: "idle" });
        await updateAgentProfile(agent.id, { role: "researcher" });
        const researcherAgent = (await getAgentById(agent.id))!;
        const task = await createTaskExtended("Coding task", {
          routingAffinity: affinity({ role: "coder" }),
        });
        expect(isAgentEligibleForTask(researcherAgent, task)).toBe(true);
      } finally {
        if (previous === undefined) {
          delete process.env.POOL_AFFINITY_ENFORCEMENT;
        } else {
          process.env.POOL_AFFINITY_ENFORCEMENT = previous;
        }
      }
    });
  });

  // ==========================================================================
  // claimTask eligibility gate
  // ==========================================================================

  describe("claimTask", () => {
    test("rejects an ineligible agent and logs task_claim_rejected_affinity", async () => {
      const researcher = await createAgent({ name: "researcher-3", isLead: false, status: "idle" });
      await updateAgentProfile(researcher.id, { role: "researcher" });
      const task = await createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const result = await claimTask(task.id, researcher.id);
      expect(result).toBeNull();

      const stillUnassigned = await getTaskById(task.id);
      expect(stillUnassigned?.status).toBe("unassigned");

      const log = (await getDbClient().get(
        "SELECT eventType FROM agent_log WHERE taskId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1",
        [task.id],
      )) as { eventType: string } | null;
      expect(log?.eventType).toBe("task_claim_rejected_affinity");
    });

    test("an eligible agent can claim after an ineligible agent was rejected", async () => {
      const researcher = await createAgent({ name: "researcher-4", isLead: false, status: "idle" });
      await updateAgentProfile(researcher.id, { role: "researcher" });
      const coder = await createAgent({ name: "coder-5", isLead: false, status: "idle" });
      await updateAgentProfile(coder.id, { role: "coder" });
      const task = await createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      expect(await claimTask(task.id, researcher.id)).toBeNull();

      const claimed = await claimTask(task.id, coder.id);
      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe("in_progress");
      expect(claimed?.agentId).toBe(coder.id);
    });

    test("only one of two eligible agents wins a race for the same task", async () => {
      const coderA = await createAgent({ name: "coder-6a", isLead: false, status: "idle" });
      await updateAgentProfile(coderA.id, { role: "coder" });
      const coderB = await createAgent({ name: "coder-6b", isLead: false, status: "idle" });
      await updateAgentProfile(coderB.id, { role: "coder" });
      const task = await createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const first = await claimTask(task.id, coderA.id);
      const second = await claimTask(task.id, coderB.id);

      expect([first, second].filter((r) => r !== null).length).toBe(1);
    });

    test("own sourceAgentId can reclaim its own affinity-tagged task", async () => {
      const agent = await createAgent({ name: "owner-2", isLead: false, status: "idle" });
      await updateAgentProfile(agent.id, { role: "researcher" });
      const task = await createTaskExtended("Own resumed work", {
        routingAffinity: affinity({ sourceAgentId: agent.id, role: "coder" }),
      });

      const claimed = await claimTask(task.id, agent.id);
      expect(claimed).not.toBeNull();
      expect(claimed?.agentId).toBe(agent.id);
    });

    test("a child cannot downgrade a lead-only parent's affinity or capabilities", async () => {
      const worker = await createAgent({ name: "child-worker", isLead: false, status: "idle" });
      const lead = await createAgent({ name: "child-lead", isLead: true, status: "idle" });
      const underprivilegedLead = await createAgent({
        name: "child-underprivileged-lead",
        isLead: true,
        status: "idle",
      });
      await updateAgentProfile(lead.id, { capabilities: ["merge"] });
      await updateAgentProfile(underprivilegedLead.id, { capabilities: ["typescript"] });
      const parent = await createTaskExtended("Merge", {
        agentId: lead.id,
        routingAffinity: affinity({ leadOnly: true, capabilities: ["merge"] }),
      });

      await expect(
        createTaskExtended("Child", {
          parentTaskId: parent.id,
          agentId: worker.id,
          routingAffinity: affinity({ leadOnly: false, capabilities: ["typescript"] }),
        }),
      ).rejects.toThrow("Lead-only task");
      const child = await createTaskExtended("Child", {
        parentTaskId: parent.id,
        routingAffinity: affinity({ leadOnly: false, capabilities: ["typescript"] }),
      });
      expect(child.routingAffinity).toMatchObject({ leadOnly: true });
      expect(child.routingAffinity?.capabilities).toEqual(["merge", "typescript"]);
      expect(await claimTask(child.id, underprivilegedLead.id)).toBeNull();
    });

    test("a child of a task whose affinity is inherited provenance (not a declared requirement) can be direct-assigned to a worker lacking the parent's capabilities", async () => {
      const originalWorker = await createAgent({
        name: "provenance-original-worker",
        isLead: false,
        status: "idle",
      });
      await updateAgentProfile(originalWorker.id, {
        role: "Implementation Engineer / Coder",
        capabilities: ["typescript", "javascript", "nodejs", "git", "worktrees"],
      });
      const differentWorker = await createAgent({
        name: "provenance-different-worker",
        isLead: false,
        status: "idle",
      });
      await updateAgentProfile(differentWorker.id, { role: "researcher", capabilities: [] });

      // Parent's routingAffinity is a snapshot of the ORIGINAL agent
      // (sourceAgentId/role/capabilities) — provenance, not a caller-declared
      // requirement. No `leadOnly`.
      const parent = await createTaskExtended("Original session", {
        agentId: originalWorker.id,
        routingAffinity: affinity({
          sourceAgentId: originalWorker.id,
          role: "Implementation Engineer / Coder",
          capabilities: ["typescript", "javascript", "nodejs", "git", "worktrees"],
        }),
      });

      // The child declares no routingAffinity of its own, so it falls back to
      // inheriting the parent's — but a direct assignment to a DIFFERENT
      // agent lacking that capability list must succeed: the inherited blob
      // is provenance, not an authorization requirement (#1276's ratchet is
      // for declared requirements and lead-only parents only).
      const child = await createTaskExtended("Continue with someone else", {
        parentTaskId: parent.id,
        agentId: differentWorker.id,
      });
      expect(child.agentId).toBe(differentWorker.id);
      expect(child.routingAffinity).toMatchObject({ sourceAgentId: originalWorker.id });
    });

    test("Superagent P1: a caller-declared (non-lead-only) capability requirement inherited by a continuation still gates direct assignment — it is not reclassified as provenance", async () => {
      // Parent's routingAffinity is a CALLER-DECLARED requirement (the same
      // shape `send-task`/`task-action` build from `requiredCapabilities`):
      // no `sourceAgentId`, no `role` — unlike `buildRoutingAffinityFromAgent`
      // provenance, which always stamps both. This is the exact shape the
      // Superagent security review flagged as being silently reclassified as
      // provenance and exempted from the direct-assignment/offer gate.
      const parent = await createTaskExtended("Needs a rare capability", {
        routingAffinity: affinity({ leadOnly: false, capabilities: ["rare-capability"] }),
      });

      // Even an agent that DOES hold the required capability is ineligible
      // here: a capability-only affinity (no `role`) is — by the documented
      // "no fail-open" contract above (`isAgentEligibleForTask`) — only ever
      // claimable by its own `sourceAgentId`, which a caller-declared
      // requirement never has. The point of this test is that the gate stays
      // ACTIVE on the continuation (throws), not that this specific agent is
      // the reason it's rejected.
      const capableWorker = await createAgent({
        name: "capable-but-not-source-worker",
        isLead: false,
        status: "idle",
      });
      await updateAgentProfile(capableWorker.id, {
        role: "coder",
        capabilities: ["rare-capability"],
      });

      // The child declares no routingAffinity of its own, so it falls back to
      // inheriting the parent's caller-declared requirement. Before the fix,
      // `routingAffinityIsInheritedProvenance` was derived from `!leadOnly`
      // alone, so this collapsed to "provenance" and the direct-assignment
      // gate below was skipped entirely — silently dropping the requirement.
      await expect(
        createTaskExtended("Continue the rare-capability work", {
          parentTaskId: parent.id,
          agentId: capableWorker.id,
        }),
      ).rejects.toThrow("Task routing affinity does not authorize assignment or offer");
    });
  });

  // ==========================================================================
  // assignUnassignedTaskPending eligibility gate
  // ==========================================================================

  describe("assignUnassignedTaskPending", () => {
    test("rejects an ineligible agent (defense in depth)", async () => {
      const researcher = await createAgent({ name: "researcher-5", isLead: false, status: "idle" });
      await updateAgentProfile(researcher.id, { role: "researcher" });
      const task = await createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const result = await assignUnassignedTaskPending(task.id, researcher.id);
      expect(result).toBeNull();
      expect((await getTaskById(task.id))?.status).toBe("unassigned");
    });

    test("assigns an eligible agent", async () => {
      const coder = await createAgent({ name: "coder-7", isLead: false, status: "idle" });
      await updateAgentProfile(coder.id, { role: "coder" });
      const task = await createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const result = await assignUnassignedTaskPending(task.id, coder.id);
      expect(result?.status).toBe("pending");
      expect(result?.agentId).toBe(coder.id);
    });
  });

  // ==========================================================================
  // getUnassignedTaskIdsForAgent ordering + filtering
  // ==========================================================================

  describe("getUnassignedTaskIdsForAgent", () => {
    test("filters out ineligible tasks and preserves priority/creation ordering", async () => {
      const coder = await createAgent({ name: "coder-8", isLead: false, status: "idle" });
      await updateAgentProfile(coder.id, { role: "coder" });

      const researchTask = await createTaskExtended("Research task", {
        routingAffinity: affinity({ role: "researcher" }),
        priority: 90,
      });
      const lowPriorityCoderTask = await createTaskExtended("Low priority coding task", {
        routingAffinity: affinity({ role: "coder" }),
        priority: 10,
      });
      const highPriorityCoderTask = await createTaskExtended("High priority coding task", {
        routingAffinity: affinity({ role: "coder" }),
        priority: 80,
      });
      const untaggedTask = await createTaskExtended("Untagged task", { priority: 50 });

      const ids = await getUnassignedTaskIdsForAgent(coder.id, 10);

      expect(ids).not.toContain(researchTask.id);
      expect(ids).toContain(lowPriorityCoderTask.id);
      expect(ids).toContain(highPriorityCoderTask.id);
      expect(ids).toContain(untaggedTask.id);

      // Priority DESC ordering preserved among eligible candidates.
      const highIdx = ids.indexOf(highPriorityCoderTask.id);
      const untaggedIdx = ids.indexOf(untaggedTask.id);
      const lowIdx = ids.indexOf(lowPriorityCoderTask.id);
      expect(highIdx).toBeLessThan(untaggedIdx);
      expect(untaggedIdx).toBeLessThan(lowIdx);
    });

    test("returns an empty list for an unknown agent", async () => {
      await createTaskExtended("Untagged task");
      expect(
        await getUnassignedTaskIdsForAgent("00000000-0000-0000-0000-000000000000", 10),
      ).toEqual([]);
    });

    test("paginates past a wall of ineligible affinity tasks larger than the old fixed scan window", async () => {
      // PR #954 review: the old implementation fetched a single fixed window
      // (max(limit * 5, 25) = 50 rows for limit=10) and filtered in JS, so an
      // eligible task sorted past row 50 was invisible no matter how many
      // times this was called. This seeds 55 high-priority ineligible tasks
      // ahead of one low-priority eligible task — more than the old window —
      // to prove the scan now pages through rather than stopping at row 50.
      const coder = await createAgent({
        name: "coder-9-pagination",
        isLead: false,
        status: "idle",
      });
      await updateAgentProfile(coder.id, { role: "coder" });

      for (let i = 0; i < 55; i++) {
        await createTaskExtended(`Ineligible research task ${i}`, {
          routingAffinity: affinity({ role: "researcher" }),
          priority: 100,
        });
      }
      const eligibleTask = await createTaskExtended("Eligible coder task buried behind the wall", {
        routingAffinity: affinity({ role: "coder" }),
        priority: 1,
      });

      const ids = await getUnassignedTaskIdsForAgent(coder.id, 10);

      expect(ids).toContain(eligibleTask.id);
    });
  });

  // ==========================================================================
  // autoAssignPoolTasks (via codeLevelTriage) — per-task eligibility filtering
  // ==========================================================================

  describe("autoAssignPoolTasks eligibility", () => {
    test("skips an ineligible idle worker and leaves the task queued", async () => {
      const researcher = await createAgent({
        name: "idle-researcher",
        isLead: false,
        status: "idle",
      });
      await updateAgentProfile(researcher.id, { role: "researcher" });
      const task = await createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const findings = await codeLevelTriage();

      expect(findings.autoAssigned.length).toBe(0);
      expect((await getTaskById(task.id))?.status).toBe("unassigned");
    });

    test("assigns to the eligible worker, skipping an ineligible one that sorts first", async () => {
      const researcher = await createAgent({
        name: "idle-researcher-2",
        isLead: false,
        status: "idle",
      });
      await updateAgentProfile(researcher.id, { role: "researcher" });
      const coder = await createAgent({ name: "idle-coder", isLead: false, status: "idle" });
      await updateAgentProfile(coder.id, { role: "coder" });
      const task = await createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const findings = await codeLevelTriage();

      expect(findings.autoAssigned.length).toBe(1);
      expect(findings.autoAssigned[0]!.agentId).toBe(coder.id);
      expect((await getTaskById(task.id))?.agentId).toBe(coder.id);
    });

    test("untagged tasks are unaffected — assigned to any idle worker", async () => {
      const worker = await createAgent({ name: "idle-any", isLead: false, status: "idle" });
      const task = await createTaskExtended("Untagged pool task");

      const findings = await codeLevelTriage();

      expect(findings.autoAssigned.length).toBe(1);
      expect(findings.autoAssigned[0]!.agentId).toBe(worker.id);
      expect((await getTaskById(task.id))?.agentId).toBe(worker.id);
    });

    test("paginates past a wall of ineligible affinity tasks larger than the old fixed sweep window", async () => {
      // PR #954 review: the old implementation fetched only
      // getUnassignedPoolTasks(MAX_AUTO_ASSIGN_PER_SWEEP) — a single bounded
      // window (default 5) — so a high-priority run of affinity-tagged tasks
      // for another role could hide all eligible work behind it forever,
      // across every sweep, since the same ineligible head-of-line rows were
      // re-fetched every time. This seeds 55 ineligible high-priority tasks
      // (more than the default POOL_SCAN_BATCH_SIZE of 50) ahead of one
      // low-priority eligible task, to prove the scan now pages through the
      // pool rather than stopping at the first window.
      const coder = await createAgent({
        name: "idle-coder-pagination",
        isLead: false,
        status: "idle",
      });
      await updateAgentProfile(coder.id, { role: "coder" });

      for (let i = 0; i < 55; i++) {
        await createTaskExtended(`Ineligible research task ${i}`, {
          routingAffinity: affinity({ role: "researcher" }),
          priority: 100,
        });
      }
      const eligibleTask = await createTaskExtended("Eligible coder task buried behind the wall", {
        routingAffinity: affinity({ role: "coder" }),
        priority: 1,
      });

      const findings = await codeLevelTriage();

      expect(findings.autoAssigned.length).toBe(1);
      expect(findings.autoAssigned[0]!.taskId).toBe(eligibleTask.id);
      expect(findings.autoAssigned[0]!.agentId).toBe(coder.id);
      expect((await getTaskById(eligibleTask.id))?.agentId).toBe(coder.id);
    });
  });

  // ==========================================================================
  // Pool-starvation escalation (createPoolStarvationDecisionTask) — the ONLY
  // path a capability-only (no-role) affinity task can ever get an owner, per
  // isAgentEligibleForTask's "no fail-open" contract. Pre-existing bug (not
  // introduced by, and not fixed by, PR #1340): this function force-assigns a
  // "reroute-decision" task to the Lead with no explicit routingAffinity, so
  // it plain-fallback-inherited `original`'s own affinity — and the
  // direct-assignment gate then evaluated that inherited affinity against the
  // LEAD, who satisfies neither `sourceAgentId` nor `role` on a caller-declared
  // capability requirement. The escalation is a deliberate system override,
  // not a continuation of the original's requirements, so it must assert its
  // own authorization instead.
  // ==========================================================================

  describe("createPoolStarvationDecisionTask", () => {
    test("original task has a caller-declared capability-only affinity (no role/sourceAgentId) → escalation to Lead does not throw", async () => {
      const lead = await createAgent({ name: "starvation-lead", isLead: true, status: "idle" });
      // Exact shape send-task/task-action's requiredCapabilities build: no
      // role, no sourceAgentId — zero registered agents (including the Lead)
      // can ever satisfy this per isAgentEligibleForTask's "no fail-open" rule.
      const original = await createTaskExtended("Needs a rare capability nobody online has", {
        routingAffinity: affinity({ leadOnly: false, capabilities: ["rare-capability"] }),
      });
      expect(isAgentEligibleForTask(lead, original)).toBe(false);

      const result = await createPoolStarvationDecisionTask({ original });

      expect(result.kind).toBe("created");
      if (result.kind !== "created") throw new Error("expected created");
      expect(result.task.agentId).toBe(lead.id);
      expect(result.task.taskType).toBe("reroute-decision");
      expect(result.task.parentTaskId).toBe(original.id);
      expect(result.task.status).toBe("pending");
    });

    test("idempotent: a second call does not create a duplicate decision", async () => {
      await createAgent({ name: "starvation-lead-dup", isLead: true, status: "idle" });
      const original = await createTaskExtended("Duplicate-guard capability task", {
        routingAffinity: affinity({ leadOnly: false, capabilities: ["another-rare-capability"] }),
      });

      const first = await createPoolStarvationDecisionTask({ original });
      expect(first.kind).toBe("created");

      const second = await createPoolStarvationDecisionTask({ original });
      expect(second.kind).toBe("skipped");
      if (second.kind === "skipped") expect(second.reason).toBe("duplicate_exists");
    });

    test("end-to-end via the heartbeat sweep: a starved capability-only task is escalated, not left throwing", async () => {
      const lead = await createAgent({ name: "starvation-lead-e2e", isLead: true, status: "idle" });
      const starved = await createTaskExtended("Starved rare-capability task", {
        routingAffinity: affinity({ leadOnly: false, capabilities: ["e2e-rare-capability"] }),
      });
      // Age past POOL_AFFINITY_ESCALATION_MIN (default 15 min) so
      // getStaleUnassignedAffinityTasks picks it up as a candidate.
      const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
        old,
        starved.id,
      ]);

      const findings = await codeLevelTriage();

      expect(findings.escalatedReroutes.length).toBe(1);
      expect(findings.escalatedReroutes[0]!.originalTaskId).toBe(starved.id);
      const decisionId = findings.escalatedReroutes[0]!.decisionTaskId;
      expect((await getTaskById(decisionId))!.agentId).toBe(lead.id);
    });
  });
});
