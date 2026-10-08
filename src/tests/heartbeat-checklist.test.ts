import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  initDb,
  startTask,
  updateAgentProfile,
} from "../be/db";
import {
  checkHeartbeatChecklist,
  createBootTriageTask,
  gatherSystemStatus,
  getBootTriageFindings,
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
    await getDbClient().run("DELETE FROM agent_tasks");
    await getDbClient().run("DELETE FROM agents");
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
    test("returns markdown string", async () => {
      const status = await gatherSystemStatus();
      expect(typeof status).toBe("string");
      expect(status.length).toBeGreaterThan(0);
    });

    test("includes task stats section with [auto-generated] label", async () => {
      const status = await gatherSystemStatus();
      expect(status).toContain("## Task Overview [auto-generated]");
    });

    test("includes agent status section with [auto-generated] label", async () => {
      const status = await gatherSystemStatus();
      expect(status).toContain("## Agent Status [auto-generated]");
    });

    test("handles empty DB gracefully", async () => {
      const status = await gatherSystemStatus();
      expect(status).toContain("In Progress: 0");
      expect(status).toContain("Offline: 0");
    });

    test("reflects actual task and agent counts", async () => {
      const agent = await createAgent({ name: "test-worker", isLead: false, status: "busy" });
      await createTaskExtended("Test task 1", { agentId: agent.id });
      await createTaskExtended("Test task 2");

      const status = await gatherSystemStatus();
      // One task assigned (pending), one unassigned
      expect(status).toContain("Pending: 1");
      expect(status).toContain("Unassigned: 1");
      expect(status).toContain("1 busy");
    });

    test("shows stalled tasks section when stalled tasks exist", async () => {
      const agent = await createAgent({ name: "stall-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled task", { agentId: agent.id });
      await startTask(task.id);

      // Make task stale (45 min)
      const oldTime = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        oldTime,
        task.id,
      ]);

      const status = await gatherSystemStatus();
      expect(status).toContain("## Stalled Tasks [auto-generated]");
    });
  });

  // ==========================================================================
  // checkHeartbeatChecklist()
  // ==========================================================================

  describe("checkHeartbeatChecklist", () => {
    test("skips when no lead agent registered", async () => {
      await createAgent({ name: "worker", isLead: false, status: "idle" });

      await checkHeartbeatChecklist();

      const tasks = await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      );
      expect(tasks.length).toBe(0);
    });

    test("skips when heartbeatMd is NULL", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });

      await checkHeartbeatChecklist();

      const tasks = await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      );
      expect(tasks.length).toBe(0);
    });

    test("skips when heartbeatMd is effectively empty (all comments/headers)", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, {
        heartbeatMd: "# Heartbeat Checklist\n\n<!-- No items yet -->\n",
      });

      await checkHeartbeatChecklist();

      const tasks = await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      );
      expect(tasks.length).toBe(0);
    });

    test("creates task when heartbeatMd has real content", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, {
        heartbeatMd: "# Heartbeat Checklist\n\n- Check if any tasks are stuck\n",
      });

      await checkHeartbeatChecklist();

      const tasks = (await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      )) as Array<{ id: string; task: string; agentId: string; priority: number }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.agentId).toBe(lead.id);
      expect(tasks[0]!.priority).toBe(60);
    });

    test("dedup: skips when active heartbeat-checklist task exists for lead", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, {
        heartbeatMd: "- Check tasks\n",
      });

      // First call — creates task
      await checkHeartbeatChecklist();

      // Second call — should skip (dedup)
      await checkHeartbeatChecklist();

      const tasks = await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      );
      expect(tasks.length).toBe(1);
    });

    test("dedup: superseded heartbeat-checklist does not block a new task", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, { heartbeatMd: "- Check tasks\n" });
      await checkHeartbeatChecklist();
      const previous = await getDbClient().get<{ id: string }>(
        "SELECT id FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      );
      expect(previous).toBeDefined();
      await getDbClient().run("UPDATE agent_tasks SET status = 'superseded' WHERE id = ?", [
        previous!.id,
      ]);

      await checkHeartbeatChecklist();

      const tasks = await getDbClient().query<{ id: string; status: string }>(
        "SELECT id, status FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      );
      expect(tasks).toHaveLength(2);
      expect(tasks.find((task) => task.id === previous!.id)?.status).toBe("superseded");
      expect(tasks.find((task) => task.id !== previous!.id)?.status).toBe("pending");
    });

    test("created task includes system status with [auto-generated] labels", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, {
        heartbeatMd: "- Review stalled tasks\n",
      });

      await checkHeartbeatChecklist();

      const tasks = (await getDbClient().query(
        "SELECT task FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      )) as Array<{ task: string }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.task).toContain("[auto-generated]");
      expect(tasks[0]!.task).toContain("Task Overview");
    });

    test("created task includes HEARTBEAT.md content", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, {
        heartbeatMd: "- Check Slack for unaddressed requests\n- Review blocked tasks\n",
      });

      await checkHeartbeatChecklist();

      const tasks = (await getDbClient().query(
        "SELECT task FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      )) as Array<{ task: string }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.task).toContain("Check Slack for unaddressed requests");
      expect(tasks[0]!.task).toContain("Review blocked tasks");
    });

    test("created task enforces HEARTBEAT tracked-item cap and seeded audit call", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, {
        heartbeatMd: "- Watch PR #123 until 2026-06-07\n",
      });

      await checkHeartbeatChecklist();

      const tasks = (await getDbClient().query(
        "SELECT task FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      )) as Array<{ task: string }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.task).toContain("Active Blockers + Watch Items + Open Discussion");
      expect(tasks[0]!.task).toContain("≤10 items");
      expect(tasks[0]!.task).toContain("20 is the absolute max");
      expect(tasks[0]!.task).toContain("script-run");
      expect(tasks[0]!.task).toContain("schedule-health");
      expect(tasks[0]!.task).toContain("task-failure-audit");
      expect(tasks[0]!.task).not.toContain("Heartbeat Audit");
      expect(tasks[0]!.task).not.toMatch(/Rules? #\d/);
    });

    test("created task has correct tags", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, {
        heartbeatMd: "- Check tasks\n",
      });

      await checkHeartbeatChecklist();

      const tasks = (await getDbClient().query(
        "SELECT tags FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      )) as Array<{ tags: string }>;
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
    // These cases cover the task body; the clean-boot skip has its own block.
    beforeEach(() => {
      process.env.HEARTBEAT_BOOT_TRIAGE_ALWAYS = "true";
    });
    afterEach(() => {
      delete process.env.HEARTBEAT_BOOT_TRIAGE_ALWAYS;
    });

    test("skips when no lead agent registered", async () => {
      await createAgent({ name: "worker", isLead: false, status: "idle" });

      await createBootTriageTask();

      const tasks = await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE taskType = 'boot-triage'",
      );
      expect(tasks.length).toBe(0);
    });

    test("creates boot-triage task for lead", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = (await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE taskType = 'boot-triage'",
      )) as Array<{ id: string; agentId: string; priority: number; task: string }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.agentId).toBe(lead.id);
      expect(tasks[0]!.priority).toBe(70);
    });

    test("boot-triage task includes reboot context", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = (await getDbClient().query(
        "SELECT task FROM agent_tasks WHERE taskType = 'boot-triage'",
      )) as Array<{ task: string }>;
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.task).toContain("Boot Triage");
      expect(tasks[0]!.task).toContain("just restarted");
      expect(tasks[0]!.task).toContain("Boot Event");
    });

    test("boot-triage task includes system status", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = (await getDbClient().query(
        "SELECT task FROM agent_tasks WHERE taskType = 'boot-triage'",
      )) as Array<{ task: string }>;
      expect(tasks[0]!.task).toContain("Task Overview [auto-generated]");
      expect(tasks[0]!.task).toContain("Agent Status [auto-generated]");
    });

    test("shows fallback text when heartbeatMd is empty", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = (await getDbClient().query(
        "SELECT task FROM agent_tasks WHERE taskType = 'boot-triage'",
      )) as Array<{ task: string }>;
      expect(tasks[0]!.task).toContain("No standing orders configured");
    });

    test("includes heartbeatMd content when available", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, {
        heartbeatMd: "- Check Slack for unaddressed requests\n",
      });

      await createBootTriageTask();

      const tasks = (await getDbClient().query(
        "SELECT task FROM agent_tasks WHERE taskType = 'boot-triage'",
      )) as Array<{ task: string }>;
      expect(tasks[0]!.task).toContain("Check Slack for unaddressed requests");
    });

    test("boot-triage task enforces HEARTBEAT cap and seeded boot-triage call", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = (await getDbClient().query(
        "SELECT task FROM agent_tasks WHERE taskType = 'boot-triage'",
      )) as Array<{ task: string }>;
      expect(tasks[0]!.task).toContain("Active Blockers + Watch Items + Open Discussion");
      expect(tasks[0]!.task).toContain("≤10 items");
      expect(tasks[0]!.task).toContain("20 is the absolute max");
      expect(tasks[0]!.task).toContain("script-run");
      expect(tasks[0]!.task).toContain("boot-triage");
      expect(tasks[0]!.task).toContain("one read-only call");
    });

    test("dedup: skips when active boot-triage task exists", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, {
        heartbeatMd: "- Check tasks\n",
      });

      await createBootTriageTask();
      await createBootTriageTask();

      const tasks = await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE taskType = 'boot-triage'",
      );
      expect(tasks.length).toBe(1);
    });

    test("dedup: superseded boot-triage does not block a new task", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, { heartbeatMd: "- Check tasks\n" });
      await createBootTriageTask();
      const previous = await getDbClient().get<{ id: string }>(
        "SELECT id FROM agent_tasks WHERE taskType = 'boot-triage'",
      );
      expect(previous).toBeDefined();
      await getDbClient().run("UPDATE agent_tasks SET status = 'superseded' WHERE id = ?", [
        previous!.id,
      ]);

      await createBootTriageTask();

      const tasks = await getDbClient().query<{ id: string; status: string }>(
        "SELECT id, status FROM agent_tasks WHERE taskType = 'boot-triage'",
      );
      expect(tasks).toHaveLength(2);
      expect(tasks.find((task) => task.id === previous!.id)?.status).toBe("superseded");
      expect(tasks.find((task) => task.id !== previous!.id)?.status).toBe("pending");
    });

    test("boot-triage has correct tags", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });

      await createBootTriageTask();

      const tasks = (await getDbClient().query(
        "SELECT tags FROM agent_tasks WHERE taskType = 'boot-triage'",
      )) as Array<{ tags: string }>;
      const tags = JSON.parse(tasks[0]!.tags);
      expect(tags).toContain("boot");
      expect(tags).toContain("triage");
      expect(tags).toContain("auto-generated");
    });

    test("boot-triage and heartbeat-checklist are independent (different taskTypes)", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, {
        heartbeatMd: "- Check tasks\n",
      });

      await createBootTriageTask();
      await checkHeartbeatChecklist();

      const bootTasks = await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE taskType = 'boot-triage'",
      );
      const checklistTasks = await getDbClient().query(
        "SELECT * FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      );
      expect(bootTasks.length).toBe(1);
      expect(checklistTasks.length).toBe(1);
    });
  });

  // ==========================================================================
  // createBootTriageTask() — clean-boot skip
  // ==========================================================================

  describe("createBootTriageTask clean-boot skip", () => {
    const bootTriageCount = async () =>
      (
        await getDbClient().get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_tasks WHERE taskType = 'boot-triage'",
        )
      )?.n ?? 0;

    beforeEach(async () => {
      delete process.env.HEARTBEAT_BOOT_TRIAGE_ALWAYS;
      // Reset the module-level reboot findings left by earlier tests.
      await runRebootSweep();
    });

    afterEach(() => {
      delete process.env.HEARTBEAT_BOOT_TRIAGE_ALWAYS;
    });

    test("clean boot creates no Lead task", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });
      await createAgent({ name: "worker", isLead: false, status: "idle" });

      expect(await getBootTriageFindings()).toEqual({
        rebootInterrupted: 0,
        stalled: 0,
        orphaned: 0,
        supersededWithoutResume: 0,
      });
      await createBootTriageTask();

      expect(await bootTriageCount()).toBe(0);
    });

    test("a seeded orphan creates exactly one Lead task", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });
      const offline = await createAgent({ name: "gone", isLead: false, status: "offline" });
      await createTaskExtended("Orphaned work", { agentId: offline.id });

      expect((await getBootTriageFindings()).orphaned).toBe(1);
      await createBootTriageTask();
      await createBootTriageTask();

      expect(await bootTriageCount()).toBe(1);
    });

    test("reboot-interrupted work creates the Lead task", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Interrupted work", { agentId: agent.id });
      await startTask(task.id);
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        new Date(Date.now() - 1000).toISOString(),
        task.id,
      ]);
      await runRebootSweep();

      expect((await getBootTriageFindings()).rebootInterrupted).toBe(1);
      await createBootTriageTask();

      expect(await bootTriageCount()).toBe(1);
    });

    test("superseded task without a resume creates the Lead task", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });
      const worker = await createAgent({ name: "worker", isLead: false, status: "idle" });
      const task = await createTaskExtended("Lost resume", { agentId: worker.id });
      await getDbClient().run(
        "UPDATE agent_tasks SET status = 'superseded', finishedAt = ? WHERE id = ?",
        [new Date(Date.now() - 5 * 60 * 1000).toISOString(), task.id],
      );

      expect((await getBootTriageFindings()).supersededWithoutResume).toBe(1);
      await createBootTriageTask();

      expect(await bootTriageCount()).toBe(1);
    });

    test("stalled-only work creates the Lead task", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });
      const agent = await createAgent({ name: "stuck-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Stalled work", { agentId: agent.id });
      await startTask(task.id);
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        task.id,
      ]);

      expect(await getBootTriageFindings()).toEqual({
        rebootInterrupted: 0,
        stalled: 1,
        orphaned: 0,
        supersededWithoutResume: 0,
      });
      await createBootTriageTask();

      expect(await bootTriageCount()).toBe(1);
    });

    test("a persistent reader error still creates exactly one Lead task", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });
      const client = getDbClient();
      const query = client.query.bind(client);
      const failStalled = spyOn(client, "query").mockImplementation((sql, params) => {
        if (sql.includes("status = 'in_progress' AND lastUpdatedAt < ?")) {
          throw new Error("stalled read unavailable");
        }
        return query(sql, params);
      });
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        await createBootTriageTask();
        await createBootTriageTask();
      } finally {
        failStalled.mockRestore();
        errors.mockRestore();
      }

      expect(await bootTriageCount()).toBe(1);
      const task = await getDbClient().get<{ task: string }>(
        "SELECT task FROM agent_tasks WHERE taskType = 'boot-triage'",
      );
      expect(task?.task).toContain("System status unavailable");
      expect(task?.task).toContain("stalled read unavailable");
    });

    test("HEARTBEAT_BOOT_TRIAGE_ALWAYS creates the task on a clean boot", async () => {
      await createAgent({ name: "lead", isLead: true, status: "idle" });
      process.env.HEARTBEAT_BOOT_TRIAGE_ALWAYS = "true";

      await createBootTriageTask();

      expect(await bootTriageCount()).toBe(1);
    });
  });

  // ==========================================================================
  // gatherSystemStatus() — boot triage sections
  // ==========================================================================

  describe("gatherSystemStatus boot triage", () => {
    test("isBootTriage includes Reboot-Interrupted Work section after reboot sweep", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Important feature work", { agentId: agent.id });
      await startTask(task.id);

      // Backdate so reboot sweep picks it up
      const past = new Date(Date.now() - 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        past,
        task.id,
      ]);

      await runRebootSweep();

      const status = await gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("## Reboot-Interrupted Work [auto-generated, ACTION REQUIRED]");
      expect(status).toContain("auto-failed and a retry task created");
      expect(status).toContain("You MUST triage each task above");
    });

    test("isBootTriage shows full task IDs (not truncated)", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Test task for ID check", { agentId: agent.id });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        past,
        task.id,
      ]);

      await runRebootSweep();

      const status = await gatherSystemStatus({ isBootTriage: true });
      // Full UUID (36 chars) should appear, not truncated to 8 chars
      expect(status).toContain(task.id);
    });

    test("isBootTriage shows retry task ID when retry was created", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Retryable task", { agentId: agent.id });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        past,
        task.id,
      ]);

      await runRebootSweep();

      const status = await gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("→ retry created:");
    });

    test("isBootTriage shows 'no retry (system task)' for system tasks", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "busy" });
      const task = await createTaskExtended("Heartbeat check", {
        agentId: lead.id,
        taskType: "heartbeat-checklist",
      });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        past,
        task.id,
      ]);

      await runRebootSweep();

      const status = await gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("→ no retry (system task)");
    });

    test("isBootTriage includes Orphaned Tasks for pending tasks on offline agents", async () => {
      const offlineAgent = await createAgent({
        name: "offline-worker",
        isLead: false,
        status: "offline",
      });
      await createTaskExtended("Orphaned pending task", { agentId: offlineAgent.id });

      const status = await gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("## Orphaned Tasks [auto-generated, NEEDS ATTENTION]");
      expect(status).toContain("Orphaned pending task");
      expect(status).toContain("offline-worker");
    });

    test("isBootTriage includes Orphaned Tasks for offered tasks on offline offerees (#1190)", async () => {
      // 'offered' tasks carry their target in offeredTo, not agentId (agentId
      // is only populated once accepted) — this used to be skipped entirely.
      const offlineAgent = await createAgent({
        name: "offline-offeree",
        isLead: false,
        status: "offline",
      });
      await createTaskExtended("Orphaned offered task", { offeredTo: offlineAgent.id });

      const status = await gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("## Orphaned Tasks [auto-generated, NEEDS ATTENTION]");
      expect(status).toContain("Orphaned offered task");
      expect(status).toContain("offline-offeree");
    });

    test("isBootTriage does not flag an offered task whose offeree is online", async () => {
      const onlineAgent = await createAgent({
        name: "online-offeree",
        isLead: false,
        status: "idle",
      });
      await createTaskExtended("Healthy offered task", { offeredTo: onlineAgent.id });

      const status = await gatherSystemStatus({ isBootTriage: true });
      expect(status).not.toContain("Healthy offered task");
    });

    test("non-boot mode does NOT include reboot or orphan sections", async () => {
      const agent = await createAgent({ name: "dead-worker", isLead: false, status: "busy" });
      const task = await createTaskExtended("Some task", { agentId: agent.id });
      await startTask(task.id);

      const past = new Date(Date.now() - 1000).toISOString();
      await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
        past,
        task.id,
      ]);

      await runRebootSweep();

      // Regular status (no isBootTriage flag)
      const status = await gatherSystemStatus();
      expect(status).not.toContain("Reboot-Interrupted Work");
      expect(status).not.toContain("Orphaned Tasks");
    });

    test("orphaned tasks note about re-registering workers is included", async () => {
      const offlineAgent = await createAgent({
        name: "recovering-worker",
        isLead: false,
        status: "offline",
      });
      await createTaskExtended("Waiting task", { agentId: offlineAgent.id });

      const status = await gatherSystemStatus({ isBootTriage: true });
      expect(status).toContain("Some workers may appear offline briefly while re-registering");
    });
  });
});
