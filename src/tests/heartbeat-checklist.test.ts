import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  initDb,
  startTask,
  updateAgentProfile,
} from "../be/db";
import {
  checkHeartbeatChecklist,
  createBootTriageTask,
  gatherSystemStatus,
  isEffectivelyEmpty,
  runRebootSweep,
} from "../heartbeat/heartbeat";

// Side-effect import: register heartbeat templates (also done by heartbeat.ts,
// but other test files may call clearTemplateDefinitions() in parallel)
import "../heartbeat/templates";

const TEST_DB_PATH = "./test-heartbeat-checklist.sqlite";

describe("Heartbeat Checklist", () => {
  beforeAll(async () => {
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await unlink(TEST_DB_PATH).catch(() => {});
    await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
    await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  });

  beforeEach(async () => {
    getDb().run("DELETE FROM agent_tasks");
    getDb().run("DELETE FROM agents");
    // Re-register heartbeat templates — other test files (prompt-template-resolver,
    // prompt-template-session) call clearTemplateDefinitions() in parallel
    await import(`../heartbeat/templates?t=${Date.now()}`);
  });

  // ==========================================================================
  // isEffectivelyEmpty()
  // ==========================================================================

  describe("isEffectivelyEmpty", () => {
    test("returns true for empty string", () => {
      expect(isEffectivelyEmpty("")).toBe(true);
    });

    test("returns true for whitespace-only", () => {
      expect(isEffectivelyEmpty("   \n  \n  ")).toBe(true);
    });

    test("returns true for headers-only", () => {
      expect(isEffectivelyEmpty("# Title\n## Subtitle")).toBe(true);
    });

    test("returns true for HTML comments only", () => {
      expect(isEffectivelyEmpty("<!-- comment -->")).toBe(true);
    });

    test("returns true for multi-line HTML comments", () => {
      expect(isEffectivelyEmpty("<!-- start\nsome content\nend -->")).toBe(true);
    });

    test("returns true for mix of headers + comments + empty items", () => {
      const content = `# Heartbeat Checklist

<!-- Keep this section empty -->
## Section

- [ ]
-
<!-- Another comment -->`;
      expect(isEffectivelyEmpty(content)).toBe(true);
    });

    test("returns true for the default lead template", () => {
      const content = `# Heartbeat Checklist

<!-- Keep this section empty to skip periodic heartbeat checks (no LLM cost). -->
<!-- Add actionable items below when you want periodic checks. -->
<!-- The lead agent reads this every 30 minutes and acts on any items found. -->

<!-- Examples (uncomment to activate):
- Check Slack for unaddressed requests older than 1 hour
- Review active tasks for any that seem stuck or blocked
- If idle workers exist and unassigned tasks are available, investigate why auto-assignment didn't handle them
- Post a daily summary to #agent-status at 5pm
-->`;
      expect(isEffectivelyEmpty(content)).toBe(true);
    });

    test("returns false for content with real list items", () => {
      expect(isEffectivelyEmpty("- Check Slack for messages")).toBe(false);
    });

    test("returns false for content with plain text paragraphs", () => {
      expect(isEffectivelyEmpty("Review the task queue every hour")).toBe(false);
    });

    test("returns false for headers + real content", () => {
      const content = `# Heartbeat Checklist
- Check if any tasks are stuck`;
      expect(isEffectivelyEmpty(content)).toBe(false);
    });
  });

  // ==========================================================================
  // gatherSystemStatus()
  // ==========================================================================

  describe("gatherSystemStatus", () => {
    test("returns markdown string", () => {
      const status = gatherSystemStatus();
      expect(typeof status).toBe("string");
      expect(status.length).toBeGreaterThan(0);
    });

    test("includes task stats section with [auto-generated] label", () => {
      const status = gatherSystemStatus();
      expect(status).toContain("## Task Overview [auto-generated]");
    });

    test("includes agent status section with [auto-generated] label", () => {
      const status = gatherSystemStatus();
      expect(status).toContain("## Agent Status [auto-generated]");
    });

    test("handles empty DB gracefully", () => {
      const status = gatherSystemStatus();
      expect(status).toContain("In Progress: 0");
      expect(status).toContain("Offline: 0");
    });

    test("reflects actual task and agent counts", () => {
      const agent = createAgent({ name: "test-worker", isLead: false, status: "busy" });
      createTaskExtended("Test task 1", { agentId: agent.id });
      createTaskExtended("Test task 2");

      const status = gatherSystemStatus();
      // One task assigned (pending), one unassigned
      expect(status).toContain("Pending: 1");
      expect(status).toContain("Unassigned: 1");
      expect(status).toContain("1 busy");
    });

    test("shows stalled tasks section when stalled tasks exist", () => {
      const agent = createAgent({ name: "stall-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Stalled task", { agentId: agent.id });
      startTask(task.id);

      // Make task stale (45 min)
      const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [oldTime, task.id]);

      const status = gatherSystemStatus();
      expect(status).toContain("## Stalled Tasks [auto-generated]");
    });
  });

  // ==========================================================================
  // checkHeartbeatChecklist()
  // ==========================================================================

  describe("checkHeartbeatChecklist", () => {
    test("skips when no lead agent registered", async () => {
      createAgent({ name: "worker", isLead: false, status: "idle" });

      await checkHeartbeatChecklist();

      const tasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'")
        .all();
      expect(tasks.length).toBe(0);
    });

    test("skips when heartbeatMd is NULL", async () => {
      createAgent({ name: "lead", isLead: true, status: "idle" });

      await checkHeartbeatChecklist();

      const tasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'")
        .all();
      expect(tasks.length).toBe(0);
    });

    test("skips when heartbeatMd is effectively empty (all comments/headers)", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
      updateAgentProfile(lead.id, {
        heartbeatMd: "# Heartbeat Checklist\n\n<!-- No items yet -->\n",
      });

      await checkHeartbeatChecklist();

      const tasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'")
        .all();
      expect(tasks.length).toBe(0);
    });

    test("creates task when heartbeatMd has real content", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
      updateAgentProfile(lead.id, {
        heartbeatMd: "# Heartbeat Checklist\n\n- Check if any tasks are stuck\n",
      });

      await checkHeartbeatChecklist();

      const tasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'")
        .all() as Array<{ id: string; task: string; agentId: string; priority: number }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.agentId).toBe(lead.id);
      expect(tasks[0]!.priority).toBe(60);
    });

    test("dedup: skips when active heartbeat-checklist task exists for lead", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
      updateAgentProfile(lead.id, {
        heartbeatMd: "- Check tasks\n",
      });

      // First call — creates task
      await checkHeartbeatChecklist();

      // Second call — should skip (dedup)
      await checkHeartbeatChecklist();

      const tasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'")
        .all();
      expect(tasks.length).toBe(1);
    });

    test("created task includes system status with [auto-generated] labels", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
      updateAgentProfile(lead.id, {
        heartbeatMd: "- Review stalled tasks\n",
      });

      await checkHeartbeatChecklist();

      const tasks = getDb()
        .query("SELECT task FROM agent_tasks WHERE taskType = 'heartbeat-checklist'")
        .all() as Array<{ task: string }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.task).toContain("[auto-generated]");
      expect(tasks[0]!.task).toContain("Task Overview");
    });

    test("created task includes HEARTBEAT.md content", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
      updateAgentProfile(lead.id, {
        heartbeatMd: "- Check Slack for unaddressed requests\n- Review blocked tasks\n",
      });

      await checkHeartbeatChecklist();

      const tasks = getDb()
        .query("SELECT task FROM agent_tasks WHERE taskType = 'heartbeat-checklist'")
        .all() as Array<{ task: string }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.task).toContain("Check Slack for unaddressed requests");
      expect(tasks[0]!.task).toContain("Review blocked tasks");
    });

    test("created task has correct tags", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
      updateAgentProfile(lead.id, {
        heartbeatMd: "- Check tasks\n",
      });

      await checkHeartbeatChecklist();

      const tasks = getDb()
        .query("SELECT tags FROM agent_tasks WHERE taskType = 'heartbeat-checklist'")
        .all() as Array<{ tags: string }>;
      expect(tasks.length).toBe(1);
      const tags = JSON.parse(tasks[0]!.tags);
      expect(tags).toContain("checklist");
      expect(tags).toContain("auto-generated");
      // Must NOT contain "heartbeat" tag (would be filtered by default listing)
      expect(tags).not.toContain("heartbeat");
    });
  });

  // ==========================================================================
  // createBootTriageTask()
  // ==========================================================================

  describe("createBootTriageTask", () => {
    test("skips when no lead agent registered", async () => {
      createAgent({ name: "worker", isLead: false, status: "idle" });

      await createBootTriageTask();

      const tasks = getDb().query("SELECT * FROM agent_tasks WHERE taskType = 'boot-triage'").all();
      expect(tasks.length).toBe(0);
    });

    test("creates boot-triage task for lead", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE taskType = 'boot-triage'")
        .all() as Array<{ id: string; agentId: string; priority: number; task: string }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.agentId).toBe(lead.id);
      expect(tasks[0]!.priority).toBe(70);
    });

    test("boot-triage task includes reboot context", async () => {
      createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = getDb()
        .query("SELECT task FROM agent_tasks WHERE taskType = 'boot-triage'")
        .all() as Array<{ task: string }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.task).toContain("Boot Triage");
      expect(tasks[0]!.task).toContain("just restarted");
      expect(tasks[0]!.task).toContain("Boot Event");
    });

    test("boot-triage task includes system status", async () => {
      createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = getDb()
        .query("SELECT task FROM agent_tasks WHERE taskType = 'boot-triage'")
        .all() as Array<{ task: string }>;
      expect(tasks[0]!.task).toContain("Task Overview [auto-generated]");
      expect(tasks[0]!.task).toContain("Agent Status [auto-generated]");
    });

    test("shows fallback text when heartbeatMd is empty", async () => {
      createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = getDb()
        .query("SELECT task FROM agent_tasks WHERE taskType = 'boot-triage'")
        .all() as Array<{ task: string }>;
      expect(tasks[0]!.task).toContain("No standing orders configured");
    });

    test("includes heartbeatMd content when available", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
      updateAgentProfile(lead.id, {
        heartbeatMd: "- Check Slack for unaddressed requests\n",
      });

      await createBootTriageTask();

      const tasks = getDb()
        .query("SELECT task FROM agent_tasks WHERE taskType = 'boot-triage'")
        .all() as Array<{ task: string }>;
      expect(tasks[0]!.task).toContain("Check Slack for unaddressed requests");
    });

    test("dedup: skips when active boot-triage task exists", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
      updateAgentProfile(lead.id, {
        heartbeatMd: "- Check tasks\n",
      });

      await createBootTriageTask();
      await createBootTriageTask();

      const tasks = getDb().query("SELECT * FROM agent_tasks WHERE taskType = 'boot-triage'").all();
      expect(tasks.length).toBe(1);
    });

    test("boot-triage has correct tags", async () => {
      createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = getDb()
        .query("SELECT tags FROM agent_tasks WHERE taskType = 'boot-triage'")
        .all() as Array<{ tags: string }>;
      const tags = JSON.parse(tasks[0]!.tags);
      expect(tags).toContain("boot");
      expect(tags).toContain("triage");
      expect(tags).toContain("auto-generated");
    });

    test("boot-triage and heartbeat-checklist are independent (different taskTypes)", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "idle" });
      updateAgentProfile(lead.id, {
        heartbeatMd: "- Check tasks\n",
      });

      await createBootTriageTask();
      await checkHeartbeatChecklist();

      const bootTasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE taskType = 'boot-triage'")
        .all();
      const checklistTasks = getDb()
        .query("SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'")
        .all();
      expect(bootTasks.length).toBe(1);
      expect(checklistTasks.length).toBe(1);
    });
  });

  // ==========================================================================
  // gatherSystemStatus() — boot triage sections
  // ==========================================================================

  describe("gatherSystemStatus boot triage", () => {
    test("isBootTriage includes Reboot-Interrupted Work section after reboot sweep", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Important feature work", { agentId: agent.id });
      startTask(task.id);

      // Backdate so reboot sweep picks it up
      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      const status = gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("## Reboot-Interrupted Work [auto-generated, ACTION REQUIRED]");
      expect(status).toContain("auto-failed and a retry task created");
      expect(status).toContain("You MUST triage each task above");
    });

    test("isBootTriage shows full task IDs (not truncated)", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Test task for ID check", { agentId: agent.id });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      const status = gatherSystemStatus({ isBootTriage: true });
      // Full UUID (36 chars) should appear, not truncated to 8 chars
      expect(status).toContain(task.id);
    });

    test("isBootTriage shows retry task ID when retry was created", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Retryable task", { agentId: agent.id });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      const status = gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("→ retry created:");
    });

    test("isBootTriage shows 'no retry (system task)' for system tasks", async () => {
      const lead = createAgent({ name: "lead", isLead: true, status: "busy" });
      const task = createTaskExtended("Heartbeat check", {
        agentId: lead.id,
        taskType: "heartbeat-checklist",
      });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      const status = gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("→ no retry (system task)");
    });

    test("isBootTriage includes Orphaned Tasks for pending tasks on offline agents", () => {
      const offlineAgent = createAgent({
        name: "offline-worker",
        isLead: false,
        status: "offline",
      });
      createTaskExtended("Orphaned pending task", { agentId: offlineAgent.id });

      const status = gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("## Orphaned Tasks [auto-generated, NEEDS ATTENTION]");
      expect(status).toContain("Orphaned pending task");
      expect(status).toContain("offline-worker");
    });

    test("non-boot mode does NOT include reboot or orphan sections", async () => {
      const agent = createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = createTaskExtended("Some task", { agentId: agent.id });
      startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      getDb().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [past, task.id]);

      await runRebootSweep();

      // Regular status (no isBootTriage flag)
      const status = gatherSystemStatus();
      expect(status).not.toContain("Reboot-Interrupted Work");
      expect(status).not.toContain("Orphaned Tasks");
    });

    test("orphaned tasks note about re-registering workers is included", () => {
      const offlineAgent = createAgent({
        name: "recovering-worker",
        isLead: false,
        status: "offline",
      });
      createTaskExtended("Waiting task", { agentId: offlineAgent.id });

      const status = gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("Some workers may appear offline briefly while re-registering");
    });
  });
});
