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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createWorkflow,
  getDb,
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
import { dispatchScheduleTarget, startScheduler, stopScheduler } from "../scheduler/scheduler";
import type { Workflow, WorkflowDefinition } from "../types";
import { InProcessEventBus } from "../workflows/event-bus";
import { BaseExecutor, type ExecutorResult } from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { interpolate } from "../workflows/template";

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

function makeWorkflow(def: WorkflowDefinition, overrides: { enabled?: boolean } = {}): Workflow {
  const wf = createWorkflow({
    name: `target-type-test-wf-${crypto.randomUUID()}`,
    definition: def,
    createdByAgentId: agentId,
  });
  if (overrides.enabled === false) {
    return updateWorkflow(wf.id, { enabled: false }) ?? wf;
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

  const agent = createAgent({ name: "schedule-target-type-agent", isLead: true, status: "idle" });
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
  test("defaults to targetType='agent-task' and preserves back-compat rows", () => {
    const schedule = createScheduledTask({
      name: `db-default-${crypto.randomUUID()}`,
      taskTemplate: "Do the thing",
      intervalMs: 60_000,
    });
    expect(schedule.targetType).toBe("agent-task");
    expect(schedule.workflowId).toBeUndefined();
    expect(schedule.scriptName).toBeUndefined();
  });

  test("persists targetType='workflow' with workflowId, no taskTemplate required", () => {
    const wf = makeWorkflow({ nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] });
    const schedule = createScheduledTask({
      name: `db-workflow-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: wf.id,
    });
    expect(schedule.targetType).toBe("workflow");
    expect(schedule.workflowId).toBe(wf.id);
    expect(schedule.taskTemplate).toBeUndefined();

    const reloaded = getScheduledTaskById(schedule.id);
    expect(reloaded?.targetType).toBe("workflow");
    expect(reloaded?.workflowId).toBe(wf.id);
  });

  test("persists targetType='script' with scriptName + scriptArgs", () => {
    const schedule = createScheduledTask({
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

  test("the recreated table's CHECK constraint rejects targetType='workflow' with no workflowId", () => {
    expect(() =>
      getDb().run(
        `INSERT INTO scheduled_tasks (id, name, targetType, scheduleType, intervalMs, createdAt, lastUpdatedAt)
         VALUES (?, ?, 'workflow', 'recurring', 60000, ?, ?)`,
        [
          crypto.randomUUID(),
          `raw-insert-${crypto.randomUUID()}`,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      ),
    ).toThrow();
  });

  test("updateScheduledTask can switch targetType and clear the previous target field", () => {
    const wf = makeWorkflow({ nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] });
    const schedule = createScheduledTask({
      name: `db-switch-${crypto.randomUUID()}`,
      taskTemplate: "Original template",
      intervalMs: 60_000,
    });
    updateScheduledTask(schedule.id, { targetType: "workflow", workflowId: wf.id });
    const updated = getScheduledTaskById(schedule.id);
    expect(updated?.targetType).toBe("workflow");
    expect(updated?.workflowId).toBe(wf.id);
    // taskTemplate isn't auto-cleared by the DB layer (callers control that);
    // confirm it round-trips unchanged when not explicitly patched.
    expect(updated?.taskTemplate).toBe("Original template");
  });
});

describe("dispatchScheduleTarget — workflow target", () => {
  test("triggers the workflow directly and returns its run ID (no implicit-binding lookup)", async () => {
    const wf = makeWorkflow({ nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] });
    const schedule = createScheduledTask({
      name: `dispatch-workflow-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: wf.id,
    });

    const result = await dispatchScheduleTarget(schedule);
    expect(result.triggeredWorkflows).toBe(true);
    expect(result.workflowRunIds?.length).toBe(1);

    const run = getWorkflowRun(result.workflowRunIds![0]!);
    expect(run?.workflowId).toBe(wf.id);
  });

  test("throws when the target workflow is disabled", async () => {
    const wf = makeWorkflow(
      { nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] },
      { enabled: false },
    );
    const schedule = createScheduledTask({
      name: `dispatch-workflow-disabled-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: wf.id,
    });

    await expect(dispatchScheduleTarget(schedule)).rejects.toThrow("disabled");
  });

  test("throws when workflowId does not resolve to a real workflow", async () => {
    const schedule = createScheduledTask({
      name: `dispatch-workflow-missing-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: crypto.randomUUID(),
    });

    await expect(dispatchScheduleTarget(schedule)).rejects.toThrow("not found");
  });
});

describe("dispatchScheduleTarget — script target", () => {
  test("runs the catalog script directly with no agent/task created", async () => {
    await saveGlobalScript(
      "schedule-target-type-echo",
      `export default async (args) => ({ received: args });`,
    );
    const schedule = createScheduledTask({
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

  test("throws a clear error when the script does not exist", async () => {
    const schedule = createScheduledTask({
      name: `dispatch-script-missing-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "script",
      scriptName: "does-not-exist-anywhere",
      createdByAgentId: agentId,
    });

    await expect(dispatchScheduleTarget(schedule)).rejects.toThrow("not found");
  });

  test("propagates a non-zero exit as a thrown error", async () => {
    await saveGlobalScript(
      "schedule-target-type-throws",
      `export default async () => { throw new Error("boom"); };`,
    );
    const schedule = createScheduledTask({
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
    const wf = makeWorkflow({ nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] });
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
    const schedule = createScheduledTask({
      name: `http-put-wf-missing-${crypto.randomUUID()}`,
      taskTemplate: "Original",
      intervalMs: 60_000,
    });
    const { status, json } = await putSchedule(schedule.id, { targetType: "workflow" });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("workflowId");
  });

  test("accepts switching to targetType='workflow' with a valid workflowId", async () => {
    const wf = makeWorkflow({ nodes: [{ id: "n1", type: "echo", config: { value: "hi" } }] });
    const schedule = createScheduledTask({
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
});
