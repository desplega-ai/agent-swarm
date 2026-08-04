import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { z } from "zod";
import * as db from "../be/db";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  createWorkflowRun,
  deleteSwarmConfigByKey,
  failTask,
  getDb,
  getScheduledTaskByName,
  getTaskByWorkflowRunStepId,
  getWorkflowByName,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  updateAgentProfile,
  upsertSwarmConfig,
} from "../be/db";
import { assertAddonReferences, runAllSeeders } from "../be/seed/registry";
import dreamApply from "../be/seed-scripts/catalog/dream-apply";
import dreamGather from "../be/seed-scripts/catalog/dream-gather";
import { renderDreamReceipt } from "../be/seed-scripts/catalog/dream-receipt";
import ghPrSnapshot from "../be/seed-scripts/catalog/gh-pr-snapshot";
import { DREAM_WORKFLOW_DEFINITION } from "../be/seed-workflows/dream";
import type { ExecutorMeta } from "../types";
import { validateDefinition } from "../workflows/definition";
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { CodeMatchExecutor } from "../workflows/executors/code-match";
import { ForeachExecutor } from "../workflows/executors/foreach";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { validateJsonSchema } from "../workflows/json-schema-validator";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-dream.sqlite";
setDefaultTimeout(30_000);

const DreamScriptConfigSchema = z.object({
  scriptName: z.string(),
  agentId: z.string().optional(),
  args: z.record(z.string(), z.unknown()).default({}),
  scope: z.enum(["global", "agent"]).optional(),
});
const DreamScriptOutputSchema = z.object({ result: z.unknown() });

class DreamScriptExecutor extends BaseExecutor<
  typeof DreamScriptConfigSchema,
  typeof DreamScriptOutputSchema
> {
  readonly type = "swarm-script";
  readonly mode = "instant" as const;
  readonly configSchema = DreamScriptConfigSchema;
  readonly outputSchema = DreamScriptOutputSchema;

  calls: Array<{ scriptName: string; agentId?: string; args: Record<string, unknown> }> = [];
  rotationAvailable = true;

  protected async execute(
    config: z.infer<typeof DreamScriptConfigSchema>,
    _context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof DreamScriptOutputSchema>>> {
    this.calls.push({
      scriptName: config.scriptName,
      ...(config.agentId ? { agentId: config.agentId } : {}),
      args: config.args,
    });

    if (config.scriptName === "dream-gather") {
      const enabledRow = db.getResolvedConfig().find((entry) => entry.key === "DREAMING_ENABLED");
      const normalized = enabledRow?.value.trim().toLowerCase();
      const enabled = !(normalized === "false" || normalized === "0");
      const slim = (reason: "disabled" | "no-activity" | "no-lead") => ({
        enabled: false,
        hasActivity: false,
        agents: [],
        leadAgentId: null,
        insights: null,
        blockers: [],
        reason,
      });
      if (!enabled) return { status: "success", output: { result: slim("disabled") } };
      const activity = getDb()
        .prepare<{ completedTasks: number; failedTasks: number; memoryWrites: number }, []>(
          `SELECT
             (SELECT count(*) FROM agent_tasks WHERE status = 'completed') AS completedTasks,
             (SELECT count(*) FROM agent_tasks WHERE status = 'failed') AS failedTasks,
             (SELECT count(*) FROM agent_memory) AS memoryWrites`,
        )
        .get() ?? { completedTasks: 0, failedTasks: 0, memoryWrites: 0 };
      if (!Object.values(activity).some((count) => count > 0)) {
        return { status: "success", output: { result: slim("no-activity") } };
      }
      const roster = getDb()
        .prepare<{ id: string; name: string; isLead: number }, []>(
          "SELECT id, name, isLead FROM agents WHERE status IN ('idle', 'busy') ORDER BY isLead DESC, name",
        )
        .all();
      const lead = roster.find((agent) => agent.isLead === 1);
      if (!lead) return { status: "success", output: { result: slim("no-lead") } };
      if (config.args.preflightOnly === true) {
        return {
          status: "success",
          output: {
            result: {
              enabled: true,
              hasActivity: true,
              agents: roster.map(({ id, name }) => ({ id, name })),
              agentIds: roster.map(({ id }) => id),
              leadAgentId: lead.id,
              insights: null,
              blockers: [],
              reason: "ready",
            },
          },
        };
      }
      return {
        status: "success",
        output: {
          result: {
            enabled,
            hasActivity: Object.values(activity).some((count) => count > 0),
            agents: roster.map(({ id, name }) => ({ id, name })),
            agentIds: roster.map(({ id }) => id),
            leadAgentId: lead.id,
            insights: { compound: {}, activity, skills: [], profileEvidence: [] },
            blockers: {
              heartbeatClaims: [],
              stuckOrFailedTasks: [],
              awaitingUserReply: [],
              rotation: {
                namespace: "dreaming",
                key: "rotation-cursor",
                cursor: 0,
                target: this.rotationAvailable ? { repo: "owner/repo", number: 42 } : null,
                available: this.rotationAvailable,
                snapshotArgs: this.rotationAvailable
                  ? { repo: "owner/repo", number: 42, skipIfMissing: true }
                  : { skipIfMissing: true },
              },
            },
          },
        },
      };
    }

    if (config.scriptName === "gh-pr-snapshot") {
      return { status: "success", output: { result: { skipped: true } } };
    }
    if (config.scriptName === "dream-apply") {
      return {
        status: "success",
        output: { result: { applied: config.args.deltas, held: [], deferred: [] } },
      };
    }
    if (config.scriptName === "dream-receipt") {
      return { status: "success", output: { result: { written: true } } };
    }
    return { status: "failed", error: `unexpected script ${config.scriptName}` };
  }
}

let savedEnv: NodeJS.ProcessEnv;
let bus: InProcessEventBus;
let registry: ExecutorRegistry;
let scripts: DreamScriptExecutor;

beforeAll(async () => {
  savedEnv = { ...process.env };
  process.env.AGENT_SWARM_API_KEY = "test-workflow-dream-key";
  delete process.env.API_KEY;
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  await runAllSeeders();
});

afterAll(async () => {
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

beforeEach(() => {
  getDb().run("DELETE FROM agent_tasks");
  getDb().run("DELETE FROM workflow_run_steps");
  getDb().run("DELETE FROM workflow_runs");
  getDb().run("UPDATE agents SET status = 'offline'");
  deleteSwarmConfigByKey("global", null, "DREAMING_ENABLED");

  bus = new InProcessEventBus();
  const deps: ExecutorDependencies = {
    db,
    eventBus: bus,
    interpolate: (template, context) => interpolate(template, context).result,
  };
  scripts = new DreamScriptExecutor(deps);
  registry = new ExecutorRegistry();
  registry.register(scripts);
  registry.register(new CodeMatchExecutor(deps));
  registry.register(new ForeachExecutor(deps));
  registry.register(new AgentTaskExecutor(deps));
  setupWorkflowResumeListener(bus, registry);
});

describe("Dreaming seeded workflow", () => {
  test("real shipped add-on references resolve", () => {
    expect(() => assertAddonReferences()).not.toThrow();
  });

  test("runAllSeeders ships an enabled dream workflow and a DISABLED daily schedule", () => {
    const workflow = getWorkflowByName("dream");
    const schedule = getScheduledTaskByName("dream-daily");

    // The workflow seeds enabled so it is inspectable and can be triggered by hand...
    expect(workflow?.enabled).toBe(true);
    // ...but nothing fires on its own until an operator opts in. Dreaming edits profiles,
    // memories and skills; a fresh install must not acquire that silently. Flipping the
    // shipped default is the staged-rollout switch (see ADDONS in src/be/seed/addons.ts).
    expect(schedule).toMatchObject({
      enabled: false,
      targetType: "workflow",
      workflowId: workflow?.id,
      cronExpression: "10 2 * * *",
      timezone: "UTC",
    });
    expect(schedule?.nextRunAt ?? null).toBeNull();
    expect(validateDefinition(workflow!.definition)).toEqual({ valid: true, errors: [] });
  });

  test("gather uses real time boundaries and supplies bounded fence-safe profile evidence", async () => {
    const lead = createAgent({
      name: "Gather Lead",
      isLead: true,
      status: "idle",
    });
    updateAgentProfile(lead.id, {
      soulMd: "## Real anchor\nKeep this text.\n\n```md\n## Fenced example\n```",
    });
    const oldTask = createTaskExtended("old completed work", { agentId: lead.id });
    completeTask(oldTask.id, "done");
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const oldSameDay = new Date(
      Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate(), 0, 0, 1),
    );
    expect(oldSameDay.getTime()).toBeLessThan(cutoff.getTime());
    getDb()
      .prepare("UPDATE agent_tasks SET finishedAt = ?, lastUpdatedAt = ? WHERE id = ?")
      .run(oldSameDay.toISOString(), oldSameDay.toISOString(), oldTask.id);
    const recentTask = createTaskExtended("recent completed work", { agentId: lead.id });
    completeTask(recentTask.id, "done");

    const result = await runRealGather();

    expect(result.enabled).toBe(true);
    expect(result.hasActivity).toBe(true);
    expect(result.leadAgentId).toBe(lead.id);
    expect(result.blockers.rotation.available).toBe(false);
    expect(result.insights.profileEvidence[0].files.SOUL).toEqual({
      excerpt: "## Real anchor\nKeep this text.\n\n```md\n## Fenced example\n```",
      h2Anchors: ["## Real anchor"],
    });
  });

  test("the activity gate ignores Dreaming's own task output", async () => {
    const lead = createAgent({ name: "Gate Lead", isLead: true, status: "idle" });
    const workflow = getWorkflowByName("dream");
    const run = createWorkflowRun({ id: crypto.randomUUID(), workflowId: workflow!.id });

    // Yesterday's run: a completed reflection lane and a failed one, both inside today's
    // one-day window. Counting them would make the gate self-sustaining — the swarm would
    // fan out every night forever off nothing but its own dreaming.
    const reflected = createTaskExtended("reflect on your day", { agentId: lead.id });
    completeTask(reflected.id, "proposed 2 deltas");
    const brokenLane = createTaskExtended("reflect on your day", { agentId: lead.id });
    failTask(brokenLane.id, "lane crashed");
    getDb()
      .prepare("UPDATE agent_tasks SET workflowRunId = ? WHERE id IN (?, ?)")
      .run(run.id, reflected.id, brokenLane.id);

    expect(await runRealGather()).toMatchObject({ hasActivity: false, reason: "no-activity" });

    // One task the swarm actually did re-opens the gate.
    const realWork = createTaskExtended("ship the thing", { agentId: lead.id });
    completeTask(realWork.id, "shipped");

    expect(await runRealGather()).toMatchObject({ hasActivity: true });
  });

  test("skill and hygiene lanes reject deltas of the wrong kind", () => {
    const skillsSchema = nodeOutputSchema("skills");
    const hygieneSchema = nodeOutputSchema("hygiene");

    expect(
      validateJsonSchema(skillsSchema, {
        deltas: [{ kind: "memory", agentId: "worker", action: "write", content: "wrong lane" }],
      }),
    ).not.toEqual([]);
    expect(
      validateJsonSchema(hygieneSchema, {
        deltas: [{ kind: "skill", action: "create", content: "wrong lane" }],
      }),
    ).not.toEqual([]);
    expect(
      validateJsonSchema(skillsSchema, {
        deltas: [{ kind: "skill", action: "create", content: "valid skill proposal" }],
      }),
    ).toEqual([]);
  });

  test("profile mutation audit entries identify and hash the applied change", async () => {
    const result = await dreamApply(
      {
        deltas: [
          {
            kind: "profile-op",
            agentId: "audit-agent",
            file: "CLAUDE",
            op: "append-under",
            anchor: "## Notes",
            content: "  Evidence-backed addition.\n",
            reason: "daily evidence",
          },
        ],
      },
      {
        swarm: {
          async db_query() {
            return { success: true, data: { rows: [["## Notes\nExisting.\n"]] } };
          },
          async profile_update() {
            return { success: true, data: { success: true } };
          },
        },
      },
    );

    expect(result.applied).toEqual([
      {
        kind: "profile-op",
        agentId: "audit-agent",
        file: "CLAUDE",
        anchor: "## Notes",
        op: "append-under",
        contentHash: await sha256Text("Evidence-backed addition."),
        reason: "daily evidence",
      },
    ]);
    expect(result.applied[0]).not.toHaveProperty("content");
    const receipt = renderDreamReceipt(result, "2026-08-04");
    expect(receipt).toContain("file=CLAUDE, anchor=## Notes, op=append-under");
    expect(receipt).toContain(`contentHash=${await sha256Text("Evidence-backed addition.")}`);
  });

  test("the PR snapshot script skips an absent rotation target before touching GitHub", async () => {
    await expect(ghPrSnapshot({ skipIfMissing: true }, {})).resolves.toEqual({
      skipped: true,
      reason: "no pull request rotation target",
    });
  });

  test("fans out two reflections, critiques, applies as Lead, writes a receipt, and completes", async () => {
    const lead = createAgent({
      name: "Dream Lead",
      isLead: true,
      status: "idle",
    });
    updateAgentProfile(lead.id, {
      soulMd: "## Operating principles\nEvidence first.",
      heartbeatMd: "## Pull request rotation\nReview one active pull request each day.",
    });
    const worker = createAgent({
      name: "Dream Worker",
      status: "idle",
    });
    updateAgentProfile(worker.id, { soulMd: "## Working style\nKeep changes small." });
    const activityTask = createTaskExtended("completed before the dream", { agentId: worker.id });
    completeTask(activityTask.id, "done");

    const workflow = getWorkflowByName("dream")!;
    const runId = await startWorkflowExecution(workflow, {}, registry);
    await waitFor(
      () =>
        reflectionSteps(runId).length === 2 &&
        stepByNode(runId, "skills")?.status === "waiting" &&
        stepByNode(runId, "hygiene")?.status === "waiting",
      () =>
        getWorkflowRunStepsByRunId(runId)
          .map((step) => `${step.nodeId}:${step.status}:${step.error ?? ""}`)
          .join(", "),
    );

    for (const step of reflectionSteps(runId)) {
      const agentId = step.nodeId.slice("reflect#".length);
      await finishStep(runId, step.id, {
        deltas: [
          {
            kind: "memory",
            agentId,
            action: "write",
            content: `Evidence-backed learning for ${agentId}`,
          },
        ],
      });
    }
    await finishNode(runId, "skills", {
      deltas: [{ kind: "skill", action: "create", content: "A proposed reusable skill." }],
    });
    const hygieneDelta = {
      kind: "hygiene",
      agentId: lead.id,
      op: "append-under",
      anchor: "## Pull request rotation",
      content: "Reviewed owner/repo#42.",
      rotationCursorKey: "rotation-cursor",
      rotationCursorNamespace: "dreaming",
      rotationCursorBy: 1,
    };
    await finishNode(runId, "hygiene", { deltas: [hygieneDelta] });
    await waitFor(() => stepByNode(runId, "critique")?.status === "waiting");

    const approved = {
      deltas: [
        hygieneDelta,
        {
          kind: "memory",
          agentId: worker.id,
          action: "write",
          content: "Keep integration evidence attached to workflow changes.",
        },
      ],
    };
    await finishNode(runId, "critique", approved);
    await waitFor(() => getWorkflowRun(runId)?.status === "completed");

    expect(reflectionSteps(runId)).toHaveLength(2);
    expect(stepByNode(runId, "hygiene-snapshot")?.status).toBe("completed");
    expect(stepByNode(runId, "apply")?.status).toBe("completed");
    expect(stepByNode(runId, "receipt")?.status).toBe("completed");
    expect(getWorkflowRun(runId)?.status).toBe("completed");

    const gathers = scripts.calls.filter((call) => call.scriptName === "dream-gather");
    // Both gathers carry this run's id — the activity gate excludes the dream
    // workflow's own tasks by durable workflow ID, surviving a rename.
    expect(gathers).toEqual([
      { scriptName: "dream-gather", args: { days: 1, preflightOnly: true, runId } },
      { scriptName: "dream-gather", agentId: lead.id, args: { days: 1, runId } },
    ]);
    const apply = scripts.calls.find((call) => call.scriptName === "dream-apply");
    const receipt = scripts.calls.find((call) => call.scriptName === "dream-receipt");
    // The apply gets the idempotency runId and the gathered roster for its guards.
    expect(apply).toMatchObject({
      agentId: lead.id,
      args: { deltas: approved, runId, agentIds: [lead.id, worker.id] },
    });
    expect(receipt).toMatchObject({
      agentId: lead.id,
      args: { apply: { applied: approved, held: [], deferred: [] } },
    });
  });

  test("an active day with no rotation target bypasses the PR snapshot cleanly", async () => {
    const lead = createAgent({ name: "No Rotation Lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "No Rotation Worker", status: "idle" });
    const activityTask = createTaskExtended("completed before no-target dream", {
      agentId: worker.id,
    });
    completeTask(activityTask.id, "done");
    scripts.rotationAvailable = false;

    const runId = await startWorkflowExecution(getWorkflowByName("dream")!, {}, registry);
    await waitFor(
      () =>
        reflectionSteps(runId).length === 2 &&
        stepByNode(runId, "skills")?.status === "waiting" &&
        stepByNode(runId, "hygiene")?.status === "waiting",
    );
    expect(stepByNode(runId, "hygiene-snapshot")?.status).toBe("completed");
    expect(scripts.calls.find((call) => call.scriptName === "gh-pr-snapshot")?.args).toEqual({
      skipIfMissing: true,
    });

    for (const step of reflectionSteps(runId)) {
      const agentId = step.nodeId.slice("reflect#".length);
      await finishStep(runId, step.id, {
        deltas: [
          {
            kind: "memory",
            agentId,
            action: "write",
            content: `No-target evidence for ${agentId}`,
          },
        ],
      });
    }
    await finishNode(runId, "skills", { deltas: [] });
    await finishNode(runId, "hygiene", { deltas: [] });
    await waitFor(() => stepByNode(runId, "critique")?.status === "waiting");
    await finishNode(runId, "critique", { deltas: [] });
    await waitFor(() => getWorkflowRun(runId)?.status === "completed");

    expect(stepByNode(runId, "apply")?.status).toBe("completed");
    expect(stepByNode(runId, "receipt")?.status).toBe("completed");
    expect(scripts.calls.find((call) => call.scriptName === "dream-apply")?.agentId).toBe(lead.id);
  });

  test("a failed async lane still converges through critique and writes a receipt", async () => {
    const lead = createAgent({ name: "Partial Dream Lead", isLead: true, status: "idle" });
    const worker = createAgent({ name: "Partial Dream Worker", status: "idle" });
    const activityTask = createTaskExtended("completed before partial dream", {
      agentId: worker.id,
    });
    completeTask(activityTask.id, "done");

    const runId = await startWorkflowExecution(getWorkflowByName("dream")!, {}, registry);
    await waitFor(
      () =>
        reflectionSteps(runId).length === 2 &&
        stepByNode(runId, "skills")?.status === "waiting" &&
        stepByNode(runId, "hygiene")?.status === "waiting",
    );

    for (const step of reflectionSteps(runId)) {
      await finishStep(runId, step.id, { deltas: [] });
    }
    await failNode(runId, "skills", "skill lane unavailable");
    await finishNode(runId, "hygiene", { deltas: [] });
    await waitFor(() => stepByNode(runId, "critique")?.status === "waiting");
    await finishNode(runId, "critique", { deltas: [] });
    await waitFor(() => getWorkflowRun(runId)?.status === "completed");

    expect(stepByNode(runId, "skills")?.output).toMatchObject({
      taskOutput: expect.stringContaining("[FAILED:"),
    });
    expect(stepByNode(runId, "receipt")?.status).toBe("completed");
    expect(scripts.calls.find((call) => call.scriptName === "dream-receipt")).toMatchObject({
      agentId: lead.id,
      args: { apply: { applied: { deltas: [] }, held: [], deferred: [] } },
    });
  });

  test("DREAMING_ENABLED=false short-circuits after the one gather script execution", async () => {
    createAgent({ name: "Dream Lead", isLead: true, status: "idle" });
    upsertSwarmConfig({ scope: "global", key: "DREAMING_ENABLED", value: "false" });

    const runId = await startWorkflowExecution(getWorkflowByName("dream")!, {}, registry);

    expect(getWorkflowRun(runId)?.status).toBe("completed");
    expect(scripts.calls.map((call) => call.scriptName)).toEqual(["dream-gather"]);
    expect(getWorkflowRunStepsByRunId(runId).map((step) => step.nodeId)).toEqual([
      "gather",
      "proceed",
      "done",
    ]);
  });

  test("zero activity short-circuits after the one gather script execution", async () => {
    createAgent({ name: "Dream Lead", isLead: true, status: "idle" });

    const runId = await startWorkflowExecution(getWorkflowByName("dream")!, {}, registry);

    expect(getWorkflowRun(runId)?.status).toBe("completed");
    expect(scripts.calls.map((call) => call.scriptName)).toEqual(["dream-gather"]);
    expect(getWorkflowRunStepsByRunId(runId).map((step) => step.nodeId)).toEqual([
      "gather",
      "proceed",
      "done",
    ]);
  });
});

function reflectionSteps(runId: string) {
  return getWorkflowRunStepsByRunId(runId).filter((step) => step.nodeId.startsWith("reflect#"));
}

function stepByNode(runId: string, nodeId: string) {
  return getWorkflowRunStepsByRunId(runId).find((step) => step.nodeId === nodeId);
}

function nodeOutputSchema(nodeId: string): Record<string, unknown> {
  const node = DREAM_WORKFLOW_DEFINITION.nodes.find((candidate) => candidate.id === nodeId);
  const schema = (node?.config as { outputSchema?: Record<string, unknown> })?.outputSchema;
  if (!schema) throw new Error(`Missing output schema for ${nodeId}`);
  return schema;
}

async function runRealGather(): Promise<any> {
  return dreamGather(
    { days: 1 },
    {
      swarm: {
        script_run: async () => ({ success: true, data: { exitCode: 0, result: { days: 1 } } }),
        db_query: async ({ sql, params = [] }: { sql: string; params?: unknown[] }) => ({
          success: true,
          data: {
            columns: [],
            rows: getDb()
              .query(sql)
              .all(...params),
          },
        }),
        config_get: async () => ({ success: true, data: { configs: [] } }),
        skill_list: async () => ({ success: true, data: { skills: [] } }),
        kv_getOrNull: async () => null,
      },
    },
  );
}

async function finishNode(runId: string, nodeId: string, output: unknown): Promise<void> {
  const step = stepByNode(runId, nodeId);
  if (!step) throw new Error(`Missing workflow step ${nodeId}`);
  await finishStep(runId, step.id, output);
}

async function finishStep(runId: string, stepId: string, output: unknown): Promise<void> {
  const task = getTaskByWorkflowRunStepId(stepId);
  if (!task) throw new Error(`Missing task for workflow step ${stepId}`);
  const serialized = JSON.stringify(output);
  completeTask(task.id, serialized);
  bus.emit("task.completed", {
    taskId: task.id,
    output: serialized,
    workflowRunId: runId,
    workflowRunStepId: stepId,
  });
  await waitFor(() => {
    const status = getWorkflowRunStepsByRunId(runId).find((step) => step.id === stepId)?.status;
    return status === "completed";
  });
}

async function failNode(runId: string, nodeId: string, reason: string): Promise<void> {
  const step = stepByNode(runId, nodeId);
  if (!step) throw new Error(`Missing workflow step ${nodeId}`);
  const task = getTaskByWorkflowRunStepId(step.id);
  if (!task) throw new Error(`Missing task for workflow step ${step.id}`);
  failTask(task.id, reason);
  bus.emit("task.failed", {
    taskId: task.id,
    failureReason: reason,
    workflowRunId: runId,
    workflowRunStepId: step.id,
  });
  await waitFor(() => stepByNode(runId, nodeId)?.status === "completed");
}

async function waitFor(predicate: () => boolean, details?: () => string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(
    `Timed out waiting for Dreaming workflow state${details ? `: ${details()}` : ""}`,
  );
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
