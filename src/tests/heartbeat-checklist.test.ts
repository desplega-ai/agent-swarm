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
  deletePromptTemplate,
  getDbClient,
  getKv,
  getRecentFailedTasks,
  initDb,
  startTask,
  updateAgentProfile,
  upsertPromptTemplate,
  upsertSwarmConfig,
} from "../be/db";
import { getScript, upsertScriptByName } from "../be/scripts/db";
import * as savedScriptRunner from "../be/scripts/run-saved";
import { runSavedScriptAsAgent } from "../be/scripts/run-saved";
import {
  checkHeartbeatChecklist,
  createBootTriageTask,
  defaultChecklistGateRunner,
  gatherSystemStatus,
  getBootTriageFindings,
  isEffectivelyEmpty,
  runRebootSweep,
  setChecklistGateRunnerForTests,
  setChecklistGateTimeoutMsForTests,
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

    test("receipt stores exactly the ten rendered full IDs from twelve failures", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, { heartbeatMd: "- Check failures" });
      for (let i = 0; i < 12; i++) {
        const task = await createTaskExtended(`receipt failure ${i}`, { agentId: lead.id });
        await getDbClient().run(
          "UPDATE agent_tasks SET status = 'failed', failureReason = ?, finishedAt = ? WHERE id = ?",
          [`receipt reason ${i}`, new Date(Date.now() - (i + 1) * 60e3).toISOString(), task.id],
        );
      }
      const failures = await getRecentFailedTasks(6);
      const before = Date.now();
      await checkHeartbeatChecklist();
      const checklist = await getDbClient().get<{ id: string; task: string }>(
        "SELECT id, task FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      );
      expect(checklist).toBeDefined();
      const receipt = await getKv("heartbeat-checklist:reported-failures", checklist!.id);
      expect(receipt?.value).toEqual(failures.slice(0, 10).map((task) => task.id));
      expect(receipt?.expiresAt).toBeGreaterThanOrEqual(before + 7 * 24 * 3600e3);
      expect(receipt?.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 24 * 3600e3);
      for (const failure of failures.slice(0, 10)) {
        expect(checklist!.task).toContain(`[${failure.id.slice(0, 8)}]`);
      }
      for (const failure of failures.slice(10)) {
        expect(checklist!.task).not.toContain(`[${failure.id.slice(0, 8)}]`);
      }
    });

    test("receipt excludes failures when the global checklist template omits system status", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, { heartbeatMd: "- Check standing orders" });
      const failure = await createTaskExtended("Unrendered failure", { agentId: lead.id });
      await getDbClient().run(
        "UPDATE agent_tasks SET status = 'failed', failureReason = ?, finishedAt = ? WHERE id = ?",
        ["boom", new Date(Date.now() - 1000).toISOString(), failure.id],
      );
      const template = upsertPromptTemplate({
        eventType: "heartbeat.checklist",
        scope: "global",
        state: "enabled",
        body: "Review standing orders:\n{{heartbeat_content}}",
      });
      try {
        await checkHeartbeatChecklist();
        const checklist = await getDbClient().get<{ id: string; task: string }>(
          "SELECT id, task FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
        );
        expect(checklist?.task).toBe("Review standing orders:\n- Check standing orders");
        expect(
          (await getKv("heartbeat-checklist:reported-failures", checklist!.id))?.value,
        ).toEqual([]);
      } finally {
        await deletePromptTemplate(template.id);
      }
    });

    test("receipt write errors log and preserve the created checklist", async () => {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, { heartbeatMd: "- Check failures" });
      await getDbClient().run(`CREATE TRIGGER reject_heartbeat_receipt
        BEFORE INSERT ON kv_entries
        WHEN NEW.namespace = 'heartbeat-checklist:reported-failures'
        BEGIN SELECT RAISE(FAIL, 'receipt unavailable'); END`);
      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        await checkHeartbeatChecklist();
        const checklist = await getDbClient().get<{ id: string }>(
          "SELECT id FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
        );
        expect(checklist).toBeDefined();
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(
            `Failed to save reported failures for checklist ${checklist!.id}`,
          ),
          expect.any(Error),
        );
      } finally {
        log.mockRestore();
        await getDbClient().run("DROP TRIGGER reject_heartbeat_receipt");
      }
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
  // checkHeartbeatChecklist() gate script
  // ==========================================================================

  describe("checklist gate script", () => {
    const calls: Array<{ scriptName: string; leadAgentId: string }> = [];

    function useGate(result: unknown | (() => never)) {
      setChecklistGateRunnerForTests(async (scriptName, leadAgentId) => {
        calls.push({ scriptName, leadAgentId });
        return typeof result === "function" ? (result as () => never)() : result;
      });
    }

    async function checklistTasks() {
      const rows = await getDbClient().query<{ task: string; tags: string }>(
        "SELECT task, tags FROM agent_tasks WHERE taskType = 'heartbeat-checklist'",
      );
      return rows.map((row) => ({ task: row.task, tags: JSON.parse(row.tags) as string[] }));
    }

    async function seedLead() {
      const lead = await createAgent({ name: "lead", isLead: true, status: "idle" });
      await updateAgentProfile(lead.id, { heartbeatMd: "- Check tasks\n" });
      return lead;
    }

    beforeEach(() => {
      calls.length = 0;
      process.env.HEARTBEAT_CHECKLIST_GATE_SCRIPT = "quiet-gate";
      delete process.env.HEARTBEAT_CHECKLIST_GATE_MODE;
    });

    afterEach(() => {
      setChecklistGateRunnerForTests(null);
      setChecklistGateTimeoutMsForTests(null);
      delete process.env.HEARTBEAT_CHECKLIST_GATE_SCRIPT;
      delete process.env.HEARTBEAT_CHECKLIST_GATE_MODE;
    });

    test("no gate script configured: gate never runs and the task carries no gate tag", async () => {
      delete process.env.HEARTBEAT_CHECKLIST_GATE_SCRIPT;
      useGate({ quiet: true });
      await seedLead();

      await checkHeartbeatChecklist();

      expect(calls).toHaveLength(0);
      const tasks = await checklistTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.tags.some((tag) => tag.startsWith("heartbeat-gate:"))).toBe(false);
    });

    describe("default Jev gate", () => {
      async function setGlobal(key: string, value: string) {
        await upsertSwarmConfig({ scope: "global", key, value, isSecret: true });
      }

      beforeEach(() => {
        delete process.env.HEARTBEAT_CHECKLIST_GATE_SCRIPT;
      });

      afterEach(async () => {
        await getDbClient().run("DELETE FROM swarm_config");
        delete process.env.OPENROUTER_BASE_URL;
        delete process.env.HEARTBEAT_JEV_GATE_PROVIDER;
      });

      test("unset script with a TypeSafe key runs heartbeat-jev-gate in shadow", async () => {
        await setGlobal("TYPESAFE_API_KEY", "ts-test-key");
        useGate({ quiet: true });
        const lead = await seedLead();

        await checkHeartbeatChecklist();

        expect(calls).toEqual([{ scriptName: "heartbeat-jev-gate", leadAgentId: lead.id }]);
        const tasks = await checklistTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.tags).toContain("heartbeat-gate:quiet");
      });

      test("unset script with an OpenRouter key runs heartbeat-jev-gate", async () => {
        await setGlobal("OPENROUTER_API_KEY", "or-test-key");
        useGate({ quiet: false });
        await seedLead();

        await checkHeartbeatChecklist();

        expect(calls.map((call) => call.scriptName)).toEqual(["heartbeat-jev-gate"]);
      });

      test("unset script with a Cloudflare token and account id runs heartbeat-jev-gate", async () => {
        await setGlobal("CLOUDFLARE_API_TOKEN", "cf-test-token");
        await setGlobal("CLOUDFLARE_ACCOUNT_ID", "0123456789abcdef0123456789abcdef");
        useGate({ quiet: true });
        await seedLead();

        await checkHeartbeatChecklist();

        expect(calls.map((call) => call.scriptName)).toEqual(["heartbeat-jev-gate"]);
      });

      test("CLOUDFLARE_API_KEY counts as the Cloudflare token", async () => {
        await setGlobal("CLOUDFLARE_API_KEY", "cf-test-key");
        await setGlobal("CLOUDFLARE_ACCOUNT_ID", "0123456789abcdef0123456789abcdef");
        process.env.HEARTBEAT_JEV_GATE_PROVIDER = "cloudflare";
        useGate({ quiet: true });
        await seedLead();

        await checkHeartbeatChecklist();

        expect(calls.map((call) => call.scriptName)).toEqual(["heartbeat-jev-gate"]);
      });

      test("a Cloudflare token without an account id leaves the gate off", async () => {
        await setGlobal("CLOUDFLARE_API_TOKEN", "cf-test-token");
        useGate({ quiet: true });
        await seedLead();

        await checkHeartbeatChecklist();

        expect(calls).toHaveLength(0);
      });

      test("unset script and no Jev key: gate stays off", async () => {
        await setGlobal("ANTHROPIC_API_KEY", "unrelated");
        useGate({ quiet: true });
        await seedLead();

        await checkHeartbeatChecklist();

        expect(calls).toHaveLength(0);
      });

      test("an OpenRouter key behind a gateway base URL does not turn the gate on", async () => {
        await setGlobal("OPENROUTER_API_KEY", "gateway-token");
        process.env.OPENROUTER_BASE_URL = "https://gateway.example/v1";
        useGate({ quiet: true });
        await seedLead();

        await checkHeartbeatChecklist();

        expect(calls).toHaveLength(0);
      });

      test("a provider pin with no key for that provider leaves the gate off", async () => {
        await setGlobal("OPENROUTER_API_KEY", "or-test-key");
        process.env.HEARTBEAT_JEV_GATE_PROVIDER = "typesafe";
        useGate({ quiet: true });
        await seedLead();

        await checkHeartbeatChecklist();

        expect(calls).toHaveLength(0);
      });

      for (const value of ["", "  ", "off", "OFF"]) {
        test(`script set to ${JSON.stringify(value)} keeps the gate off with a key present`, async () => {
          await setGlobal("TYPESAFE_API_KEY", "ts-test-key");
          process.env.HEARTBEAT_CHECKLIST_GATE_SCRIPT = value;
          useGate({ quiet: true });
          await seedLead();

          await checkHeartbeatChecklist();

          expect(calls).toHaveLength(0);
          const tasks = await checklistTasks();
          expect(tasks).toHaveLength(1);
          expect(tasks[0]!.tags.some((tag) => tag.startsWith("heartbeat-gate:"))).toBe(false);
        });
      }

      test("the default never turns on enforce: a quiet verdict still creates the task", async () => {
        await setGlobal("TYPESAFE_API_KEY", "ts-test-key");
        useGate({ quiet: true });
        await seedLead();

        await checkHeartbeatChecklist();

        expect(await checklistTasks()).toHaveLength(1);
      });
    });

    for (const quiet of [true, false]) {
      test(`healthy probe preserves the saved gate quiet=${quiet} verdict`, async () => {
        process.env.HEARTBEAT_CHECKLIST_GATE_MODE = "enforce";
        await saveGlobalGateScript("quiet-gate", "export default () => ({ quiet: true });");
        const saved = spyOn(savedScriptRunner, "runSavedScriptAsAgent").mockResolvedValue({
          exitCode: 0,
          result: { quiet, reason: "existing verdict" },
          stdout: "",
          stderr: "",
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        });
        try {
          setChecklistGateRunnerForTests((name, agentId, signal) =>
            defaultChecklistGateRunner(name, agentId, signal, { probe: async () => null }),
          );
          await seedLead();
          await checkHeartbeatChecklist();
          expect(saved).toHaveBeenCalledTimes(1);
          const tasks = await checklistTasks();
          expect(tasks).toHaveLength(quiet ? 0 : 1);
          if (!quiet) expect(tasks[0]!.tags).toContain("heartbeat-gate:wake");
        } finally {
          saved.mockRestore();
        }
      });
    }

    for (const mode of ["shadow", "enforce"] as const) {
      test(`${mode}: an unhealthy probe produces a wake checklist`, async () => {
        process.env.HEARTBEAT_CHECKLIST_GATE_MODE = mode;
        setChecklistGateRunnerForTests((name, agentId, signal) =>
          defaultChecklistGateRunner(name, agentId, signal, {
            probe: async () => ({ quiet: false, reason: "script-runner-unhealthy: timeout" }),
          }),
        );
        await seedLead();
        await checkHeartbeatChecklist();
        const tasks = await checklistTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.tags).toContain("heartbeat-gate:wake");
      });
    }

    test("a bug in the probe produces wake rather than error", async () => {
      process.env.HEARTBEAT_CHECKLIST_GATE_MODE = "enforce";
      setChecklistGateRunnerForTests((name, agentId, signal) =>
        defaultChecklistGateRunner(name, agentId, signal, {
          probe: async () => {
            throw new Error("probe bug");
          },
        }),
      );
      await seedLead();
      await checkHeartbeatChecklist();
      const tasks = await checklistTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.tags).toContain("heartbeat-gate:wake");
    });

    test("shadow mode (default): a quiet verdict still creates the task, tagged quiet", async () => {
      useGate({ quiet: true, reason: "no change", summary: "nothing moved" });
      const lead = await seedLead();

      await checkHeartbeatChecklist();

      expect(calls).toEqual([{ scriptName: "quiet-gate", leadAgentId: lead.id }]);
      const tasks = await checklistTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.tags).toContain("heartbeat-gate:quiet");
      expect(tasks[0]!.task).not.toContain("Gate Findings");
    });

    test("shadow mode leaves a wake summary out of the prompt", async () => {
      useGate({ quiet: false, summary: "prStates moved" });
      await seedLead();

      await checkHeartbeatChecklist();

      const tasks = await checklistTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.tags).toContain("heartbeat-gate:wake");
      expect(tasks[0]!.task).not.toContain("prStates moved");
    });

    test("enforce mode: a quiet verdict skips the task", async () => {
      process.env.HEARTBEAT_CHECKLIST_GATE_MODE = "enforce";
      useGate({ quiet: true });
      await seedLead();

      await checkHeartbeatChecklist();

      expect(calls).toHaveLength(1);
      expect(await checklistTasks()).toHaveLength(0);
    });

    test("enforce mode: a wake verdict creates the task with the gate summary attached", async () => {
      process.env.HEARTBEAT_CHECKLIST_GATE_MODE = "enforce";
      useGate({ quiet: false, reason: "2 sections moved", summary: "prStates moved" });
      await seedLead();

      await checkHeartbeatChecklist();

      const tasks = await checklistTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.tags).toContain("heartbeat-gate:wake");
      expect(tasks[0]!.task).toContain("## Gate Findings [auto-generated]");
      expect(tasks[0]!.task).toContain("prStates moved");
    });

    test("enforce mode: a throwing gate fails open", async () => {
      process.env.HEARTBEAT_CHECKLIST_GATE_MODE = "enforce";
      useGate(() => {
        throw new Error("gate exploded");
      });
      await seedLead();

      await checkHeartbeatChecklist();

      const tasks = await checklistTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.tags).toContain("heartbeat-gate:error");
    });

    test("enforce mode: a result without a boolean quiet field fails open", async () => {
      process.env.HEARTBEAT_CHECKLIST_GATE_MODE = "enforce";
      useGate({ changed: false, quiet: "true" });
      await seedLead();

      await checkHeartbeatChecklist();

      const tasks = await checklistTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.tags).toContain("heartbeat-gate:error");
    });

    test("enforce mode: a missing global script fails open through the real runner", async () => {
      process.env.HEARTBEAT_CHECKLIST_GATE_MODE = "enforce";
      process.env.HEARTBEAT_CHECKLIST_GATE_SCRIPT = "no-such-gate-script";
      setChecklistGateRunnerForTests((name, agentId, signal) =>
        defaultChecklistGateRunner(name, agentId, signal, { probe: async () => null }),
      );
      await seedLead();

      await checkHeartbeatChecklist();

      const tasks = await checklistTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.tags).toContain("heartbeat-gate:error");
    });

    async function saveGlobalGateScript(name: string, source: string) {
      await upsertScriptByName({
        name,
        scope: "global",
        source,
        description: "Heartbeat checklist gate fixture",
        intent: "Exercise the checklist gate deadline",
        signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
        typeChecked: true,
        embeddingMode: "skip",
      });
    }

    for (const mode of ["shadow", "enforce"] as const) {
      test(`${mode} mode: stalled credential setup hits the deadline and still creates the checklist`, async () => {
        process.env.HEARTBEAT_CHECKLIST_GATE_MODE = mode;
        process.env.HEARTBEAT_CHECKLIST_GATE_SCRIPT = "stalled-setup-gate";
        await saveGlobalGateScript(
          "stalled-setup-gate",
          "export default function run() { return { quiet: true }; }",
        );
        setChecklistGateTimeoutMsForTests(200);
        let releaseSetup: () => void = () => {};
        const setupStarted = Promise.withResolvers<void>();
        let run: Promise<unknown> | undefined;
        setChecklistGateRunnerForTests((scriptName, leadAgentId, signal) => {
          run = defaultChecklistGateRunner(scriptName, leadAgentId, signal, {
            probe: async () => null,
            buildCredentials: () => {
              setupStarted.resolve();
              return new Promise((resolve) => {
                releaseSetup = () =>
                  resolve({ egressSecrets: [], failedBindings: [], userConfig: {} });
              });
            },
          });
          return run;
        });
        await seedLead();

        const started = Date.now();
        await checkHeartbeatChecklist();

        expect(Date.now() - started).toBeLessThan(5_000);
        await setupStarted.promise;
        const tasks = await checklistTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.tags).toContain("heartbeat-gate:error");

        // Setup finishing after the deadline must not start the script.
        releaseSetup();
        await expect(run!).rejects.toThrow("killed");
      });
    }

    test("a script aborted during credential setup never starts", async () => {
      await saveGlobalGateScript(
        "never-starts-gate",
        "export default function run() { return { quiet: true }; }",
      );
      const lead = await seedLead();
      const script = (await getScript({ name: "never-starts-gate", scope: "global" }))!;
      const controller = new AbortController();

      const output = await runSavedScriptAsAgent(
        { script, input: {}, agentId: lead.id, signal: controller.signal },
        {
          buildCredentials: async () => {
            controller.abort();
            return { egressSecrets: [], failedBindings: [], userConfig: {} };
          },
        },
      );

      expect(output.error).toBe("killed");
      expect(output.stderr).toBe("aborted before execution started");
      expect(output.durationMs).toBe(0);
    });

    test("enforce mode: a script that outlives the deadline fails open through the real runner", async () => {
      process.env.HEARTBEAT_CHECKLIST_GATE_MODE = "enforce";
      process.env.HEARTBEAT_CHECKLIST_GATE_SCRIPT = "slow-gate";
      await saveGlobalGateScript(
        "slow-gate",
        "export default async function run() { await new Promise((r) => setTimeout(r, 30_000)); return { quiet: true }; }",
      );
      setChecklistGateTimeoutMsForTests(1_500);
      setChecklistGateRunnerForTests((name, agentId, signal) =>
        defaultChecklistGateRunner(name, agentId, signal, { probe: async () => null }),
      );
      await seedLead();

      const started = Date.now();
      await checkHeartbeatChecklist();

      expect(Date.now() - started).toBeLessThan(15_000);
      const tasks = await checklistTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.tags).toContain("heartbeat-gate:error");
    });

    test("enforce mode: the real probe passes with no swarm API key, using the Lead's run token", async () => {
      process.env.HEARTBEAT_CHECKLIST_GATE_MODE = "enforce";
      await saveGlobalGateScript("quiet-gate", "export default () => ({ quiet: true });");
      const savedKeys = { swarm: process.env.AGENT_SWARM_API_KEY, legacy: process.env.API_KEY };
      process.env.AGENT_SWARM_API_KEY = "";
      process.env.API_KEY = "";
      try {
        await seedLead();
        await checkHeartbeatChecklist();
        expect(await checklistTasks()).toHaveLength(0);
      } finally {
        for (const [name, value] of [
          ["AGENT_SWARM_API_KEY", savedKeys.swarm],
          ["API_KEY", savedKeys.legacy],
        ] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
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
      expect(await getKv("heartbeat-checklist:reported-failures", tasks[0]!.id)).toBeNull();
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
