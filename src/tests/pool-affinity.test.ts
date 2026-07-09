import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  assignUnassignedTaskPending,
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentById,
  getDb,
  getTaskById,
  getUnassignedTaskIdsForAgent,
  initDb,
  isAgentEligibleForTask,
  updateAgentProfile,
} from "../be/db";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import type { RoutingAffinity } from "../types";

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
  beforeEach(() => {
    getDb().run("DELETE FROM agent_tasks");
    getDb().run("DELETE FROM agents");
    getDb().run("DELETE FROM agent_log");
  });

  function affinity(overrides: Partial<RoutingAffinity>): RoutingAffinity {
    return { capabilities: [], ...overrides };
  }

  // ==========================================================================
  // isAgentEligibleForTask matrix
  // ==========================================================================

  describe("isAgentEligibleForTask", () => {
    test("untagged task (no routingAffinity) is eligible for anyone", () => {
      const agent = createAgent({ name: "no-role-agent", isLead: false, status: "idle" });
      const task = createTaskExtended("Untagged task");
      expect(isAgentEligibleForTask(agent, task)).toBe(true);
    });

    test("sourceAgentId bypass: own work is eligible even with a mismatched role", () => {
      const owner = createAgent({ name: "owner", isLead: false, status: "idle" });
      updateAgentProfile(owner.id, { role: "researcher" });
      const ownerAgent = getAgentById(owner.id)!;
      const task = createTaskExtended("Own work", {
        routingAffinity: affinity({ sourceAgentId: owner.id, role: "coder" }),
      });
      expect(isAgentEligibleForTask(ownerAgent, task)).toBe(true);
    });

    test("exact role match is eligible", () => {
      const agent = createAgent({ name: "coder-1", isLead: false, status: "idle" });
      updateAgentProfile(agent.id, { role: "coder" });
      const coderAgent = getAgentById(agent.id)!;
      const task = createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });
      expect(isAgentEligibleForTask(coderAgent, task)).toBe(true);
    });

    test("role mismatch is ineligible", () => {
      const agent = createAgent({ name: "researcher-1", isLead: false, status: "idle" });
      updateAgentProfile(agent.id, { role: "researcher" });
      const researcherAgent = getAgentById(agent.id)!;
      const task = createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });
      expect(isAgentEligibleForTask(researcherAgent, task)).toBe(false);
    });

    test("missing role on the agent is ineligible — no fail-open", () => {
      const agent = createAgent({ name: "no-role-agent-2", isLead: false, status: "idle" });
      const task = createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });
      expect(isAgentEligibleForTask(agent, task)).toBe(false);
    });

    test("missing role on the task's affinity (capabilities-only) is ineligible for a non-owner — no fail-open", () => {
      const agent = createAgent({ name: "coder-2", isLead: false, status: "idle" });
      updateAgentProfile(agent.id, { role: "coder" });
      const coderAgent = getAgentById(agent.id)!;
      const task = createTaskExtended("Capability-only task", {
        routingAffinity: affinity({ capabilities: ["datadog"] }),
      });
      expect(isAgentEligibleForTask(coderAgent, task)).toBe(false);
    });

    test("capability subset: missing a required capability is ineligible", () => {
      const agent = createAgent({ name: "coder-3", isLead: false, status: "idle" });
      updateAgentProfile(agent.id, { role: "coder", capabilities: ["typescript"] });
      const coderAgent = getAgentById(agent.id)!;
      const task = createTaskExtended("Needs datadog", {
        routingAffinity: affinity({ role: "coder", capabilities: ["datadog"] }),
      });
      expect(isAgentEligibleForTask(coderAgent, task)).toBe(false);
    });

    test("capability subset: a superset of required capabilities is eligible", () => {
      const agent = createAgent({ name: "coder-4", isLead: false, status: "idle" });
      updateAgentProfile(agent.id, { role: "coder", capabilities: ["typescript", "datadog"] });
      const coderAgent = getAgentById(agent.id)!;
      const task = createTaskExtended("Needs datadog", {
        routingAffinity: affinity({ role: "coder", capabilities: ["datadog"] }),
      });
      expect(isAgentEligibleForTask(coderAgent, task)).toBe(true);
    });

    test("kill-switch: POOL_AFFINITY_ENFORCEMENT=0 makes every task eligible", () => {
      const previous = process.env.POOL_AFFINITY_ENFORCEMENT;
      process.env.POOL_AFFINITY_ENFORCEMENT = "0";
      try {
        const agent = createAgent({ name: "researcher-2", isLead: false, status: "idle" });
        updateAgentProfile(agent.id, { role: "researcher" });
        const researcherAgent = getAgentById(agent.id)!;
        const task = createTaskExtended("Coding task", {
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
    test("rejects an ineligible agent and logs task_claim_rejected_affinity", () => {
      const researcher = createAgent({ name: "researcher-3", isLead: false, status: "idle" });
      updateAgentProfile(researcher.id, { role: "researcher" });
      const task = createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const result = claimTask(task.id, researcher.id);
      expect(result).toBeNull();

      const stillUnassigned = getTaskById(task.id);
      expect(stillUnassigned?.status).toBe("unassigned");

      const log = getDb()
        .query("SELECT eventType FROM agent_log WHERE taskId = ? ORDER BY createdAt DESC LIMIT 1")
        .get(task.id) as { eventType: string } | null;
      expect(log?.eventType).toBe("task_claim_rejected_affinity");
    });

    test("an eligible agent can claim after an ineligible agent was rejected", () => {
      const researcher = createAgent({ name: "researcher-4", isLead: false, status: "idle" });
      updateAgentProfile(researcher.id, { role: "researcher" });
      const coder = createAgent({ name: "coder-5", isLead: false, status: "idle" });
      updateAgentProfile(coder.id, { role: "coder" });
      const task = createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      expect(claimTask(task.id, researcher.id)).toBeNull();

      const claimed = claimTask(task.id, coder.id);
      expect(claimed).not.toBeNull();
      expect(claimed?.status).toBe("in_progress");
      expect(claimed?.agentId).toBe(coder.id);
    });

    test("only one of two eligible agents wins a race for the same task", () => {
      const coderA = createAgent({ name: "coder-6a", isLead: false, status: "idle" });
      updateAgentProfile(coderA.id, { role: "coder" });
      const coderB = createAgent({ name: "coder-6b", isLead: false, status: "idle" });
      updateAgentProfile(coderB.id, { role: "coder" });
      const task = createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const first = claimTask(task.id, coderA.id);
      const second = claimTask(task.id, coderB.id);

      expect([first, second].filter((r) => r !== null).length).toBe(1);
    });

    test("own sourceAgentId can reclaim its own affinity-tagged task", () => {
      const agent = createAgent({ name: "owner-2", isLead: false, status: "idle" });
      updateAgentProfile(agent.id, { role: "researcher" });
      const task = createTaskExtended("Own resumed work", {
        routingAffinity: affinity({ sourceAgentId: agent.id, role: "coder" }),
      });

      const claimed = claimTask(task.id, agent.id);
      expect(claimed).not.toBeNull();
      expect(claimed?.agentId).toBe(agent.id);
    });
  });

  // ==========================================================================
  // assignUnassignedTaskPending eligibility gate
  // ==========================================================================

  describe("assignUnassignedTaskPending", () => {
    test("rejects an ineligible agent (defense in depth)", () => {
      const researcher = createAgent({ name: "researcher-5", isLead: false, status: "idle" });
      updateAgentProfile(researcher.id, { role: "researcher" });
      const task = createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const result = assignUnassignedTaskPending(task.id, researcher.id);
      expect(result).toBeNull();
      expect(getTaskById(task.id)?.status).toBe("unassigned");
    });

    test("assigns an eligible agent", () => {
      const coder = createAgent({ name: "coder-7", isLead: false, status: "idle" });
      updateAgentProfile(coder.id, { role: "coder" });
      const task = createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const result = assignUnassignedTaskPending(task.id, coder.id);
      expect(result?.status).toBe("pending");
      expect(result?.agentId).toBe(coder.id);
    });
  });

  // ==========================================================================
  // getUnassignedTaskIdsForAgent ordering + filtering
  // ==========================================================================

  describe("getUnassignedTaskIdsForAgent", () => {
    test("filters out ineligible tasks and preserves priority/creation ordering", () => {
      const coder = createAgent({ name: "coder-8", isLead: false, status: "idle" });
      updateAgentProfile(coder.id, { role: "coder" });

      const researchTask = createTaskExtended("Research task", {
        routingAffinity: affinity({ role: "researcher" }),
        priority: 90,
      });
      const lowPriorityCoderTask = createTaskExtended("Low priority coding task", {
        routingAffinity: affinity({ role: "coder" }),
        priority: 10,
      });
      const highPriorityCoderTask = createTaskExtended("High priority coding task", {
        routingAffinity: affinity({ role: "coder" }),
        priority: 80,
      });
      const untaggedTask = createTaskExtended("Untagged task", { priority: 50 });

      const ids = getUnassignedTaskIdsForAgent(coder.id, 10);

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

    test("returns an empty list for an unknown agent", () => {
      createTaskExtended("Untagged task");
      expect(getUnassignedTaskIdsForAgent("00000000-0000-0000-0000-000000000000", 10)).toEqual([]);
    });
  });

  // ==========================================================================
  // autoAssignPoolTasks (via codeLevelTriage) — per-task eligibility filtering
  // ==========================================================================

  describe("autoAssignPoolTasks eligibility", () => {
    test("skips an ineligible idle worker and leaves the task queued", async () => {
      const researcher = createAgent({ name: "idle-researcher", isLead: false, status: "idle" });
      updateAgentProfile(researcher.id, { role: "researcher" });
      const task = createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const findings = await codeLevelTriage();

      expect(findings.autoAssigned.length).toBe(0);
      expect(getTaskById(task.id)?.status).toBe("unassigned");
    });

    test("assigns to the eligible worker, skipping an ineligible one that sorts first", async () => {
      const researcher = createAgent({ name: "idle-researcher-2", isLead: false, status: "idle" });
      updateAgentProfile(researcher.id, { role: "researcher" });
      const coder = createAgent({ name: "idle-coder", isLead: false, status: "idle" });
      updateAgentProfile(coder.id, { role: "coder" });
      const task = createTaskExtended("Coding task", {
        routingAffinity: affinity({ role: "coder" }),
      });

      const findings = await codeLevelTriage();

      expect(findings.autoAssigned.length).toBe(1);
      expect(findings.autoAssigned[0]!.agentId).toBe(coder.id);
      expect(getTaskById(task.id)?.agentId).toBe(coder.id);
    });

    test("untagged tasks are unaffected — assigned to any idle worker", async () => {
      const worker = createAgent({ name: "idle-any", isLead: false, status: "idle" });
      const task = createTaskExtended("Untagged pool task");

      const findings = await codeLevelTriage();

      expect(findings.autoAssigned.length).toBe(1);
      expect(findings.autoAssigned[0]!.agentId).toBe(worker.id);
      expect(getTaskById(task.id)?.agentId).toBe(worker.id);
    });
  });
});
