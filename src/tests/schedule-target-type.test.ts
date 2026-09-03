/**
 * Coverage for the schedule `targetType` discriminator (agent-task | workflow | script).
 *
 * Covers:
 * - DB round-trip: targetType/workflowId/scriptName/scriptArgs persist correctly,
 *   taskTemplate is nullable, migration 103's CHECK constraint enforces the
 *   target-specific field.
 * - `dispatchScheduleTarget()` — the scheduler-level switch: 'workflow' triggers a
 *   real workflow run directly (no implicit-binding lookup), 'script' runs a real
 *   catalog script via the scripts-runtime, 'agent-task' (default) is unaffected
 *   (already covered by scheduled-tasks.test.ts).
 * - HTTP route cross-field validation (create + update) for workflow/script targets.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  type AutomationSetupStates,
  preflightAutomation,
  renderAutomationTokens,
} from "../be/automation-preflight";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createUser,
  createWorkflow,
  deleteUser,
  getDbClient,
  getScheduledTaskById,
  getWorkflowRun,
  initDb,
  updateScheduledTask,
  updateWorkflow,
} from "../be/db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handleSchedules } from "../http/schedules";
import { getPathSegments, parseQueryParams } from "../http/utils";
import {
  dispatchScheduleTarget,
  executeSchedule,
  renderScheduledTaskParams,
  startScheduler,
  stopScheduler,
} from "../scheduler/scheduler";
import type { Workflow, WorkflowDefinition } from "../types";
import { InProcessEventBus } from "../workflows/event-bus";
import { BaseExecutor, type ExecutorResult } from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { interpolate } from "../workflows/template";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

const skip = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

const TEST_DB_PATH = "./test-schedule-target-type.sqlite";
const API_KEY = "test-schedule-target-type-key-1234567890";

const noOpEmbeddingProvider = {
  name: "test/noop-schedule-target-type-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

class EchoExecutor extends BaseExecutor<typeof EchoExecutor.schema, typeof EchoExecutor.outSchema> {
  static readonly schema = z.object({ value: z.string().default("ok") });
  static readonly outSchema = z.object({ value: z.string() });

  readonly type = "echo";
  readonly mode = "instant" as const;
  readonly configSchema = EchoExecutor.schema;
  readonly outputSchema = EchoExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof EchoExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof EchoExecutor.outSchema>>> {
    return { status: "success", output: { value: config.value } };
  }
}

let savedEnv: NodeJS.ProcessEnv;
let agentId: string;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function makeWorkflow(
  def: WorkflowDefinition,
  overrides: { enabled?: boolean } = {},
): Promise<Workflow> {
  const wf = await createWorkflow({
    name: `target-type-test-wf-${crypto.randomUUID()}`,
    definition: def,
    createdByAgentId: agentId,
  });
  if (overrides.enabled === false) {
    return (await updateWorkflow(wf.id, { enabled: false })) ?? wf;
  }
  return wf;
}

async function saveGlobalScript(name: string, source: string) {
  return upsertScriptByName({
    name,
    scope: "global",
    source,
    description: `${name} test script`,
    intent: "schedule-target-type test fixture",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
    agentId,
    typeChecked: true,
  });
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);

  const agent = await createAgent({
    name: "schedule-target-type-agent",
    isLead: true,
    status: "idle",
  });
  agentId = agent.id;

  // Wire the module-private executorRegistry used by dispatchScheduleTarget's
  // 'workflow' branch — same registry the production boot passes to
  // startScheduler(). A huge interval + immediate stopScheduler() means the
  // poller never actually fires; tests call dispatchScheduleTarget directly.
  const eventBus = new InProcessEventBus();
  const db = await import("../be/db");
  const registry = new ExecutorRegistry();
  registry.register(
    new EchoExecutor({
      db,
      eventBus,
      interpolate: (template, ctx) => interpolate(template, ctx).result,
    }),
  );
  startScheduler(registry, 999_999_999);
  stopScheduler();
});

afterAll(async () => {
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  await removeDbFiles();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("scheduled_tasks DB layer — targetType", () => {
  test("automation migrations gate legacy template rows and preserve custom rows", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE scheduled_tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          taskTemplate TEXT,
          timezone TEXT DEFAULT 'UTC'
        );
        CREATE TABLE workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          definition TEXT NOT NULL
        );
        INSERT INTO scheduled_tasks VALUES
          ('legacy-dependabot', 'weekly-dependabot-triage', 1, 'Review owner/repo and notify the configured channel or thread', 'UTC'),
          ('legacy-health', 'weekly-code-health-reports', 1, 'Clone https://github.com/OWNER/REPO.git as my-repo and publish <PAGE_ID>; Default branch: \`main\`; Path scope: \`src\`; BRANCH=main SCOPE_PATH=src', 'UTC'),
          ('legacy-dora', 'weekly-dora-metrics', 1, 'Clone https://github.com/OWNER/REPO.git as my-repo and publish <PAGE_ID>; Default branch: \`main\`; Release tag pattern: \`v*\`; BRANCH=main TAG_PATTERN=''v*''', 'UTC'),
          ('legacy-hn', 'daily-hn-briefing', 1, 'From lead@agent-swarm.dev To: the configured recipient list for this briefing', 'UTC'),
          ('legacy-gtm', 'gtm-weekly-review', 1, 'Inspect owner/repo and example.com docs.example.com', 'UTC'),
          ('custom-schedule', 'my-team-triage', 1, 'Review owner/repo example.com my-repo', 'UTC');
        INSERT INTO workflows VALUES
          ('legacy-autopilot', 'autopilot', 1, '{"task":"Work in {{repoUrl}} and {{trigger.repoUrl}}"}'),
          ('legacy-linear', 'linear-drain-loop', 1, '{"task":"Drain {{projectId}} and {{trigger.projectId}}"}'),
          ('custom-workflow', 'my-team-autopilot', 1, '{}');
      `);
      db.exec(
        await Bun.file(
          new URL("../be/migrations/141_scheduled_task_automation_preflight.sql", import.meta.url),
        ).text(),
      );
      db.exec(
        await Bun.file(
          new URL("../be/migrations/142_workflow_automation_preflight.sql", import.meta.url),
        ).text(),
      );

      const legacySchedule = db
        .query<
          {
            params: string;
            requiredParams: string;
            requires: string;
            taskTemplate: string;
            timezone: string;
          },
          []
        >(
          "SELECT params, requiredParams, requires, taskTemplate, timezone FROM scheduled_tasks WHERE id = 'legacy-dependabot'",
        )
        .get()!;
      expect(JSON.parse(legacySchedule.requiredParams)).toEqual([
        "REPO_URL",
        "SLACK_CHANNEL_ID",
        "TIMEZONE",
      ]);
      expect(JSON.parse(legacySchedule.requires)).toEqual(["github", "slack"]);
      expect(legacySchedule.taskTemplate).toBe(
        "Review {{REPO_URL}} and notify {{SLACK_CHANNEL_ID}}",
      );
      expect(legacySchedule.timezone).toBe("{{TIMEZONE}}");
      expect(
        renderAutomationTokens(legacySchedule.taskTemplate, {
          REPO_URL: "acme/widgets",
          SLACK_CHANNEL_ID: "C123",
        }),
      ).toBe("Review acme/widgets and notify C123");

      const tokenizedBodies = db
        .query<{ id: string; taskTemplate: string }, []>(
          "SELECT id, taskTemplate FROM scheduled_tasks WHERE id IN ('legacy-dora', 'legacy-gtm', 'legacy-health', 'legacy-hn') ORDER BY id",
        )
        .all();
      expect(tokenizedBodies).toEqual([
        {
          id: "legacy-dora",
          taskTemplate:
            "Clone {{REPO_URL}} as {{REPORT_NAME}} and publish {{PAGE_ID}}; Default branch: `{{BRANCH}}`; Release tag pattern: `{{TAG_PATTERN}}`; BRANCH={{BRANCH}} TAG_PATTERN={{TAG_PATTERN}}",
        },
        {
          id: "legacy-gtm",
          taskTemplate: "Inspect {{REPO_URL}} and {{GSC_PROPERTY}}",
        },
        {
          id: "legacy-health",
          taskTemplate:
            "Clone {{REPO_URL}} as {{REPORT_NAME}} and publish {{PAGE_ID}}; Default branch: `{{BRANCH}}`; Path scope: `{{SCOPE_PATH}}`; BRANCH={{BRANCH}} SCOPE_PATH={{SCOPE_PATH}}",
        },
        {
          id: "legacy-hn",
          taskTemplate: "From the configured reporting inbox To: {{REPORT_EMAIL}}",
        },
      ]);

      const setup: AutomationSetupStates = {
        slack: "unverified",
        github: "unverified",
        linear: "verified",
        jira: "verified",
        gsc: "verified",
        agentmail: "verified",
        agentfs: "verified",
      };
      const gated = preflightAutomation(
        {
          id: "legacy-dependabot",
          name: "weekly-dependabot-triage",
          kind: "schedule",
          params: JSON.parse(legacySchedule.params),
          requiredParams: JSON.parse(legacySchedule.requiredParams),
          requires: JSON.parse(legacySchedule.requires),
        },
        setup,
      );
      expect(gated.state).toBe("needs_setup");
      expect(gated.missing.params).toEqual(["REPO_URL", "SLACK_CHANNEL_ID", "TIMEZONE"]);

      const legacyWorkflows = db
        .query<{ id: string; definition: string; requiredParams: string; requires: string }, []>(
          "SELECT id, definition, requiredParams, requires FROM workflows WHERE id IN ('legacy-autopilot', 'legacy-linear') ORDER BY id",
        )
        .all();
      expect(legacyWorkflows).toEqual([
        {
          id: "legacy-autopilot",
          definition: '{"task":"Work in {{REPO_URL}} and {{REPO_URL}}"}',
          requiredParams: '["REPO_URL"]',
          requires: '["github"]',
        },
        {
          id: "legacy-linear",
          definition: '{"task":"Drain {{LINEAR_PROJECT_ID}} and {{LINEAR_PROJECT_ID}}"}',
          requiredParams: '["LINEAR_PROJECT_ID"]',
          requires: '["linear"]',
        },
      ]);

      for (const [table, id] of [
        ["scheduled_tasks", "custom-schedule"],
        ["workflows", "custom-workflow"],
      ] as const) {
        const custom = db
          .query<{ requiredParams: string; requires: string }, []>(
            `SELECT requiredParams, requires FROM ${table} WHERE id = '${id}'`,
          )
          .get()!;
        expect([custom.requiredParams, custom.requires]).toEqual(["[]", "[]"]);
      }
      expect(
        db
          .query<{ taskTemplate: string }, []>(
            "SELECT taskTemplate FROM scheduled_tasks WHERE id = 'custom-schedule'",
          )
          .get()!.taskTemplate,
      ).toBe("Review owner/repo example.com my-repo");
    } finally {
      db.close();
    }
  });

  test("defaults to targetType='agent-task' and preserves back-compat rows", async () => {
    const schedule = await createScheduledTask({
      name: `db-default-${crypto.randomUUID()}`,
      taskTemplate: "Do the thing",
      intervalMs: 60_000,
    });
    expect(schedule.targetType).toBe("agent-task");
    expect(schedule.workflowId).toBeUndefined();
    expect(schedule.scriptName).toBeUndefined();
  });

  test("persists targetType='workflow' with workflowId, no taskTemplate required", async () => {
    const wf = await makeWorkflow({ nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] });
    const schedule = await createScheduledTask({
      name: `db-workflow-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: wf.id,
    });
    expect(schedule.targetType).toBe("workflow");
    expect(schedule.workflowId).toBe(wf.id);
    expect(schedule.taskTemplate).toBeUndefined();

    const reloaded = await getScheduledTaskById(schedule.id);
    expect(reloaded?.targetType).toBe("workflow");
    expect(reloaded?.workflowId).toBe(wf.id);
  });

  test("persists targetType='script' with scriptName + scriptArgs", async () => {
    const schedule = await createScheduledTask({
      name: `db-script-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "script",
      scriptName: "my-catalog-script",
      scriptArgs: { foo: "bar" },
    });
    expect(schedule.targetType).toBe("script");
    expect(schedule.scriptName).toBe("my-catalog-script");
    expect(schedule.scriptArgs).toEqual({ foo: "bar" });
  });

  test("persists automation params and setup requirements", async () => {
    const schedule = await createScheduledTask({
      name: `db-preflight-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      taskTemplate: "Inspect {{REPO_URL}}",
      params: { REPO_URL: "acme/widgets" },
      requiredParams: ["REPO_URL"],
      requires: ["github"],
    });

    expect(schedule.params).toEqual({ REPO_URL: "acme/widgets" });
    expect(schedule.requiredParams).toEqual(["REPO_URL"]);
    expect(schedule.requires).toEqual(["github"]);
  });

  test("the recreated table's CHECK constraint rejects targetType='workflow' with no workflowId", async () => {
    await expect(
      getDbClient().run(
        `INSERT INTO scheduled_tasks (id, name, targetType, scheduleType, intervalMs, createdAt, lastUpdatedAt)
         VALUES (?, ?, 'workflow', 'recurring', 60000, ?, ?)`,
        [
          crypto.randomUUID(),
          `raw-insert-${crypto.randomUUID()}`,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      ),
    ).rejects.toThrow();
  });

  test("updateScheduledTask can switch targetType and clear the previous target field", async () => {
    const wf = await makeWorkflow({ nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] });
    const schedule = await createScheduledTask({
      name: `db-switch-${crypto.randomUUID()}`,
      taskTemplate: "Original template",
      intervalMs: 60_000,
    });
    await updateScheduledTask(schedule.id, { targetType: "workflow", workflowId: wf.id });
    const updated = await getScheduledTaskById(schedule.id);
    expect(updated?.targetType).toBe("workflow");
    expect(updated?.workflowId).toBe(wf.id);
    // taskTemplate isn't auto-cleared by the DB layer (callers control that);
    // confirm it round-trips unchanged when not explicitly patched.
    expect(updated?.taskTemplate).toBe("Original template");
  });
});

describe("dispatchScheduleTarget — workflow target", () => {
  test("triggers the workflow directly and returns its run ID (no implicit-binding lookup)", async () => {
    const wf = await makeWorkflow({ nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] });
    const requester = await createUser({ name: "Workflow Schedule Requester" });
    const schedule = await createScheduledTask({
      name: `dispatch-workflow-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: wf.id,
      createdBy: requester.id,
    });

    const result = await dispatchScheduleTarget(schedule);
    expect(result.triggeredWorkflows).toBe(true);
    expect(result.workflowRunIds?.length).toBe(1);

    const run = await getWorkflowRun(result.workflowRunIds![0]!);
    expect(run?.workflowId).toBe(wf.id);
    expect(run?.createdBy).toBe(requester.id);
  });

  test("runs an implicitly bound workflow without dangling attribution after owner deletion", async () => {
    const requester = await createUser({ name: "Deleted Schedule Requester" });
    const schedule = await createScheduledTask({
      name: `dispatch-deleted-owner-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      taskTemplate: "Fallback task that should not run",
      createdBy: requester.id,
    });
    const wf = await createWorkflow({
      name: `implicit-schedule-workflow-${crypto.randomUUID()}`,
      definition: { nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] },
      triggers: [{ type: "schedule", scheduleId: schedule.id }],
      createdByAgentId: agentId,
    });

    expect(await deleteUser(requester.id)).toBe(true);
    // Simulate an orphan created before deleteUser learned to clean audit
    // columns whose FK was dropped by migration 103.
    await getDbClient().run("UPDATE scheduled_tasks SET created_by = ? WHERE id = ?", [
      requester.id,
      schedule.id,
    ]);
    const reloaded = (await getScheduledTaskById(schedule.id))!;
    expect(reloaded.createdBy).toBe(requester.id);

    const result = await dispatchScheduleTarget(reloaded);
    expect(result.triggeredWorkflows).toBe(true);
    expect(result.task).toBeUndefined();
    expect(result.workflowRunIds).toHaveLength(1);
    const run = await getWorkflowRun(result.workflowRunIds![0]!);
    expect(run?.workflowId).toBe(wf.id);
    expect(run?.createdBy).toBeUndefined();
  });

  test("throws when the target workflow is disabled", async () => {
    const wf = await makeWorkflow(
      { nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] },
      { enabled: false },
    );
    const schedule = await createScheduledTask({
      name: `dispatch-workflow-disabled-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: wf.id,
    });

    await expect(dispatchScheduleTarget(schedule)).rejects.toThrow("disabled");
  });

  test("throws when workflowId does not resolve to a real workflow", async () => {
    const schedule = await createScheduledTask({
      name: `dispatch-workflow-missing-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: crypto.randomUUID(),
    });

    await expect(dispatchScheduleTarget(schedule)).rejects.toThrow("not found");
  });

  test("a workflow needs_setup run is a failed schedule fire without task creation or backoff", async () => {
    const wf = await createWorkflow({
      name: `workflow-needs-setup-${crypto.randomUUID()}`,
      definition: {
        nodes: [{ id: "n1", type: "echo", config: { value: "{{REPO_URL}}" } }],
      },
      requiredParams: ["REPO_URL"],
      params: {},
    });
    const schedule = await createScheduledTask({
      name: `schedule-workflow-needs-setup-${crypto.randomUUID()}`,
      intervalMs: 86_400_000,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      targetType: "workflow",
      workflowId: wf.id,
    });
    const before = await getDbClient().get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_tasks",
    );

    await executeSchedule(schedule);

    const updated = await getScheduledTaskById(schedule.id);
    const after = await getDbClient().get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_tasks",
    );
    expect(after?.count).toBe(before?.count);
    expect(updated?.enabled).toBe(true);
    expect(updated?.lastRunAt).toBeUndefined();
    expect(updated?.consecutiveErrors).toBe(0);
    expect(updated?.lastErrorMessage).toBe("needs_setup: params=[REPO_URL] integrations=[]");
    expect(new Date(updated!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("dispatchScheduleTarget — automation preflight", () => {
  test("renders every runtime-consumed schedule field and preserves argument value types", async () => {
    const schedule = await createScheduledTask({
      name: `schedule-render-fields-${crypto.randomUUID()}`,
      cronExpression: "0 9 * * *",
      timezone: "{{TIMEZONE}}",
      taskTemplate: "Review {{REPO_URL}}",
      scriptArgs: { competitors: "{{COMPETITORS}}", repo: "{{REPO_URL}}" },
      targetAgentId: "{{TARGET_AGENT_ID}}",
      params: {
        TIMEZONE: "America/New_York",
        REPO_URL: "acme/widgets",
        COMPETITORS: ["one", "two"],
        TARGET_AGENT_ID: agentId,
      },
      requiredParams: ["TIMEZONE", "REPO_URL", "COMPETITORS", "TARGET_AGENT_ID"],
    });

    expect(renderScheduledTaskParams(schedule)).toMatchObject({
      timezone: "America/New_York",
      taskTemplate: "Review acme/widgets",
      scriptArgs: { competitors: ["one", "two"], repo: "acme/widgets" },
      targetAgentId: agentId,
    });
  });

  test("renders configured parameters before creating an agent task", async () => {
    const schedule = await createScheduledTask({
      name: `dispatch-render-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      taskTemplate: "Review {{REPO_URL}} while preserving {{trigger.ref}}",
      params: { REPO_URL: "acme/widgets" },
      requiredParams: ["REPO_URL"],
    });

    const result = await dispatchScheduleTarget(schedule);
    expect(result.task?.task).toBe("Review acme/widgets while preserving {{trigger.ref}}");
  });

  test("dedupes the same needs_setup record per UTC day and keeps normal cadence", async () => {
    const schedule = await createScheduledTask({
      name: `dispatch-needs-setup-${crypto.randomUUID()}`,
      intervalMs: 86_400_000,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      taskTemplate: "Review {{REPO_URL}}",
      params: {},
      requiredParams: ["REPO_URL"],
    });
    const before = await getDbClient().get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_tasks",
    );

    await executeSchedule(schedule);
    const first = (await getScheduledTaskById(schedule.id))!;
    await executeSchedule(first);
    const second = (await getScheduledTaskById(schedule.id))!;
    const after = await getDbClient().get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_tasks",
    );

    expect(after?.count).toBe(before?.count);
    expect(second.lastErrorAt).toBe(first.lastErrorAt);
    expect(second.lastErrorMessage).toBe("needs_setup: params=[REPO_URL] integrations=[]");
    expect(second.consecutiveErrors).toBe(0);
    expect(second.enabled).toBe(true);
    expect(second.lastRunAt).toBeUndefined();
    expect(new Date(second.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  test("advances a cron schedule while its required timezone is still unset", async () => {
    const schedule = await createScheduledTask({
      name: `dispatch-needs-timezone-${crypto.randomUUID()}`,
      cronExpression: "40 3 * * 0",
      timezone: "{{TIMEZONE}}",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      taskTemplate: "Review {{REPO_URL}}",
      params: {},
      requiredParams: ["REPO_URL", "TIMEZONE"],
    });

    await executeSchedule(schedule);

    const updated = (await getScheduledTaskById(schedule.id))!;
    expect(updated.lastErrorMessage).toBe(
      "needs_setup: params=[REPO_URL,TIMEZONE] integrations=[]",
    );
    expect(new Date(updated.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("dispatchScheduleTarget — script target", () => {
  skip("runs the catalog script directly with no agent/task created", async () => {
    await saveGlobalScript(
      "schedule-target-type-echo",
      `export default async (args) => ({ received: args });`,
    );
    const schedule = await createScheduledTask({
      name: `dispatch-script-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "script",
      scriptName: "schedule-target-type-echo",
      scriptArgs: { hello: "world" },
      createdByAgentId: agentId,
    });

    const result = await dispatchScheduleTarget(schedule);
    expect(result.triggeredWorkflows).toBe(false);
    expect(result.task).toBeUndefined();
  }, 15_000);

  skip("scheduled script runs receive ctx.api and ctx.mcp connections", async () => {
    const { upsertScriptConnection } = await import("../be/script-connections");
    await upsertScriptConnection({
      slug: "schedgql",
      kind: "graphql",
      scope: "global",
      baseUrl: "https://gql.vendor.test/graphql",
      allowedHosts: ["gql.vendor.test"],
      agentId,
    });
    const mcpRow = {
      id: crypto.randomUUID(),
      serverId: crypto.randomUUID(),
      runtime: { slug: "schedmcp", kind: "mcp", connectionId: "", tools: [{ name: "ping" }] },
    };
    mcpRow.runtime.connectionId = mcpRow.id;
    await getDbClient().run(
      `INSERT INTO mcp_servers (id, name, transport, scope, url, createdAt, lastUpdatedAt)
       VALUES (?, ?, 'http', 'global', 'http://mcp.invalid.test/mcp', datetime('now'), datetime('now'))`,
      [mcpRow.serverId, `sched-mcp-${mcpRow.serverId.slice(0, 8)}`],
    );
    await getDbClient().run(
      `INSERT INTO script_connections
         (id, slug, kind, scope, allowed_hosts_json, mcp_server_id, generated_runtime_json)
       VALUES (?, 'schedmcp', 'mcp', 'global', '[]', ?, ?)`,
      [mcpRow.id, mcpRow.serverId, JSON.stringify(mcpRow.runtime)],
    );

    await saveGlobalScript(
      "schedule-target-type-ctx-connections",
      `export default async (args, ctx) => {
        if (!ctx.api || !("schedgql" in ctx.api)) throw new Error("ctx.api missing schedgql");
        if (!ctx.mcp || !("schedmcp" in ctx.mcp)) throw new Error("ctx.mcp missing schedmcp");
        return { ok: true };
      };`,
    );
    const schedule = await createScheduledTask({
      name: `dispatch-script-ctx-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "script",
      scriptName: "schedule-target-type-ctx-connections",
      createdByAgentId: agentId,
    });

    const result = await dispatchScheduleTarget(schedule);
    expect(result.triggeredWorkflows).toBe(false);
  }, 15_000);

  test("throws a clear error when the script does not exist", async () => {
    const schedule = await createScheduledTask({
      name: `dispatch-script-missing-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "script",
      scriptName: "does-not-exist-anywhere",
      createdByAgentId: agentId,
    });

    await expect(dispatchScheduleTarget(schedule)).rejects.toThrow("not found");
  });

  skip("propagates a non-zero exit as a thrown error", async () => {
    await saveGlobalScript(
      "schedule-target-type-throws",
      `export default async () => { throw new Error("boom"); };`,
    );
    const schedule = await createScheduledTask({
      name: `dispatch-script-throws-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "script",
      scriptName: "schedule-target-type-throws",
      createdByAgentId: agentId,
    });

    await expect(dispatchScheduleTarget(schedule)).rejects.toThrow();
  }, 15_000);
});

// ─── HTTP route cross-field validation ────────────────────────────────────────

function makeHttpReq(
  method: string,
  path: string,
  body: unknown,
  callerAgentId: string,
): IncomingMessage {
  const req = Readable.from(
    body !== undefined ? [Buffer.from(JSON.stringify(body))] : [],
  ) as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = { "x-agent-id": callerAgentId, "content-type": "application/json" };
  return req;
}

function makeHttpRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => text };
}

async function postSchedule(
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const path = "/api/schedules";
  const req = makeHttpReq("POST", path, body, agentId);
  const { res, status, body: text } = makeHttpRes();
  await handleSchedules(req, res, getPathSegments(path), parseQueryParams(path), agentId);
  return { status: status(), json: JSON.parse(text() || "{}") };
}

async function putSchedule(
  id: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const path = `/api/schedules/${id}`;
  const req = makeHttpReq("PUT", path, body, agentId);
  const { res, status, body: text } = makeHttpRes();
  await handleSchedules(req, res, getPathSegments(path), parseQueryParams(path), agentId);
  return { status: status(), json: JSON.parse(text() || "{}") };
}

describe("POST /api/schedules — targetType validation", () => {
  test("rejects targetType='workflow' with no workflowId", async () => {
    const { status, json } = await postSchedule({
      name: `http-wf-missing-id-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
    });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("workflowId");
  });

  test("rejects targetType='workflow' with an unknown workflowId", async () => {
    const { status, json } = await postSchedule({
      name: `http-wf-unknown-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: crypto.randomUUID(),
    });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("Workflow not found");
  });

  test("accepts targetType='workflow' with a real workflowId and no taskTemplate", async () => {
    const wf = await makeWorkflow({ nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] });
    const { status, json } = await postSchedule({
      name: `http-wf-ok-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: wf.id,
    });
    expect(status).toBe(201);
    expect(json.targetType).toBe("workflow");
    expect(json.workflowId).toBe(wf.id);
  });

  test("rejects targetType='script' with no scriptName", async () => {
    const { status, json } = await postSchedule({
      name: `http-script-missing-name-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "script",
    });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("scriptName");
  });

  test("rejects targetType='script' with an unknown scriptName", async () => {
    const { status, json } = await postSchedule({
      name: `http-script-unknown-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "script",
      scriptName: "totally-unknown-script",
    });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("Script not found");
  });

  test("rejects targetType='agent-task' (default) with no taskTemplate", async () => {
    const { status, json } = await postSchedule({
      name: `http-agent-task-missing-${crypto.randomUUID()}`,
      intervalMs: 60_000,
    });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("taskTemplate");
  });
});

describe("PUT /api/schedules/{id} — targetType validation", () => {
  test("rejects switching to targetType='workflow' without a workflowId", async () => {
    const schedule = await createScheduledTask({
      name: `http-put-wf-missing-${crypto.randomUUID()}`,
      taskTemplate: "Original",
      intervalMs: 60_000,
    });
    const { status, json } = await putSchedule(schedule.id, { targetType: "workflow" });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("workflowId");
  });

  test("accepts switching to targetType='workflow' with a valid workflowId", async () => {
    const wf = await makeWorkflow({ nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] });
    const schedule = await createScheduledTask({
      name: `http-put-wf-ok-${crypto.randomUUID()}`,
      taskTemplate: "Original",
      intervalMs: 60_000,
    });
    const { status, json } = await putSchedule(schedule.id, {
      targetType: "workflow",
      workflowId: wf.id,
    });
    expect(status).toBe(200);
    expect(json.targetType).toBe("workflow");
    expect(json.workflowId).toBe(wf.id);
  });

  test("persists automation setup fields", async () => {
    const schedule = await createScheduledTask({
      name: `http-put-preflight-${crypto.randomUUID()}`,
      taskTemplate: "Inspect {{REPO_URL}}",
      intervalMs: 60_000,
    });
    const { status, json } = await putSchedule(schedule.id, {
      params: { REPO_URL: "acme/widgets" },
      requiredParams: ["REPO_URL"],
      requires: ["github"],
    });

    expect(status).toBe(200);
    expect(json.params).toEqual({ REPO_URL: "acme/widgets" });
    expect(json.requiredParams).toEqual(["REPO_URL"]);
    expect(json.requires).toEqual(["github"]);
  });
});
