import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createAgent,
  createWorkflow,
  getDb,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import type { Workflow, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import {
  SWARM_SCRIPT_DEFAULT_TIMEOUT_MS,
  SWARM_SCRIPT_MAX_TIMEOUT_MS,
  SWARM_SCRIPT_MIN_TIMEOUT_MS,
  SwarmScriptConfigSchema,
  SwarmScriptExecutor,
} from "../workflows/executors/swarm-script";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-swarm-script.sqlite";
const API_KEY = "test-workflow-swarm-script-key-1234567890";

const noOpEmbeddingProvider = {
  name: "test/noop-workflow-script-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

const signatureJson = JSON.stringify({
  args: { type: "object" },
  result: { type: "object" },
});

class EchoExecutor extends BaseExecutor<typeof EchoExecutor.schema, typeof EchoExecutor.outSchema> {
  static readonly schema = z.object({ value: z.string() });
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
let deps: ExecutorDependencies;
let registry: ExecutorRegistry;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function makeWorkflow(def: WorkflowDefinition): Workflow {
  const wf = createWorkflow({
    name: `swarm-script-test-${crypto.randomUUID()}`,
    definition: def,
    createdByAgentId: agentId,
  });
  return wf;
}

async function saveScript(name: string, source: string) {
  return upsertScriptByName({
    name,
    scope: "agent",
    scopeId: agentId,
    source,
    description: `${name} test script`,
    intent: "workflow-swarm-script test fixture",
    signatureJson,
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

  const agent = createAgent({ name: "workflow-script-agent", isLead: true, status: "idle" });
  agentId = agent.id;

  const eventBus = new InProcessEventBus();
  const db = await import("../be/db");
  deps = {
    db,
    eventBus,
    interpolate: (template, ctx) => interpolate(template, ctx).result,
  };
  registry = new ExecutorRegistry();
  registry.register(new EchoExecutor(deps));
  registry.register(new SwarmScriptExecutor(deps));
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

beforeEach(() => {
  getDb().run("DELETE FROM workflow_run_steps");
  getDb().run("DELETE FROM workflow_runs");
  getDb().run("DELETE FROM scripts");
  getDb().run("DELETE FROM workflows");
});

describe("SwarmScriptExecutor", () => {
  test("config schema validates timeoutMs bounds and applies the runtime default", () => {
    expect(SwarmScriptConfigSchema.parse({ scriptName: "quick" }).timeoutMs).toBe(
      SWARM_SCRIPT_DEFAULT_TIMEOUT_MS,
    );

    expect(
      SwarmScriptConfigSchema.safeParse({
        scriptName: "quick",
        timeoutMs: SWARM_SCRIPT_MIN_TIMEOUT_MS - 1,
      }).success,
    ).toBe(false);
    expect(
      SwarmScriptConfigSchema.safeParse({
        scriptName: "quick",
        timeoutMs: SWARM_SCRIPT_MAX_TIMEOUT_MS + 1,
      }).success,
    ).toBe(false);

    expect(
      SwarmScriptConfigSchema.parse({
        scriptName: "quick",
        timeoutMs: SWARM_SCRIPT_MIN_TIMEOUT_MS,
      }).timeoutMs,
    ).toBe(SWARM_SCRIPT_MIN_TIMEOUT_MS);
    expect(
      SwarmScriptConfigSchema.parse({
        scriptName: "quick",
        timeoutMs: SWARM_SCRIPT_MAX_TIMEOUT_MS,
      }).timeoutMs,
    ).toBe(SWARM_SCRIPT_MAX_TIMEOUT_MS);
  });

  test("A workflow with one swarm-script node resolves by name + runs + returns result", async () => {
    await saveScript(
      "add-one",
      `export default async (args: { value: number }) => ({ value: args.value + 1 });`,
    );

    const executor = new SwarmScriptExecutor(deps);
    const wf = makeWorkflow({ nodes: [] });
    const result = await executor.run({
      config: { scriptName: "add-one", args: { value: 6 } },
      context: {},
      meta: {
        runId: crypto.randomUUID(),
        stepId: crypto.randomUUID(),
        nodeId: "script",
        workflowId: wf.id,
        dryRun: false,
      },
    });

    expect(result.status).toBe("success");
    expect(result.output?.result).toEqual({ value: 7 });
    expect(result.output?.scriptName).toBe("add-one");
  });

  test("pinHash correctly resolves to a historic script_versions row", async () => {
    const first = await saveScript("versioned", `export default async () => ({ version: "old" });`);
    await saveScript("versioned", `export default async () => ({ version: "new" });`);

    const executor = new SwarmScriptExecutor(deps);
    const wf = makeWorkflow({ nodes: [] });
    const result = await executor.run({
      config: { scriptName: "versioned", pinHash: first.script.contentHash },
      context: {},
      meta: {
        runId: crypto.randomUUID(),
        stepId: crypto.randomUUID(),
        nodeId: "script",
        workflowId: wf.id,
        dryRun: false,
      },
    });

    expect(result.status).toBe("success");
    expect(result.output?.result).toEqual({ version: "old" });
    expect(result.output?.contentHash).toBe(first.script.contentHash);
    expect(result.output?.version).toBe(1);
  });

  test("inputs mapping from a predecessor node correctly populates args", async () => {
    await saveScript(
      "from-input",
      `export default async (args: { value: string }) => ({ seen: args.value });`,
    );
    const wf = makeWorkflow({
      nodes: [
        { id: "source", type: "echo", config: { value: "mapped-value" }, next: "script" },
        {
          id: "script",
          type: "swarm-script",
          inputs: { sourceValue: "source.value" },
          config: { scriptName: "from-input", args: { value: "{{sourceValue}}" } },
        },
      ],
    });

    const runId = await startWorkflowExecution(wf, {}, registry);
    const run = getWorkflowRun(runId);
    const steps = getWorkflowRunStepsByRunId(runId);
    const scriptStep = steps.find((step) => step.nodeId === "script");

    expect(run?.status).toBe("completed");
    expect(scriptStep?.status).toBe("completed");
    expect(scriptStep?.output).toMatchObject({ result: { seen: "mapped-value" } });
  });

  test("exact object token outside swarm-script args is still stringified", async () => {
    const wf = makeWorkflow({
      nodes: [
        {
          id: "echo",
          type: "echo",
          config: { value: "{{trigger.payload}}" },
        },
      ],
    });

    const runId = await startWorkflowExecution(wf, { payload: { a: 1 } }, registry);
    const run = getWorkflowRun(runId);
    const steps = getWorkflowRunStepsByRunId(runId);
    const echoStep = steps.find((step) => step.nodeId === "echo");

    expect(run?.status).toBe("completed");
    expect(echoStep?.status).toBe("completed");
    expect(echoStep?.output).toEqual({ value: '{"a":1}' });
  });

  test("{{path}} args: object arg is injected as raw object, not JSON string", async () => {
    await saveScript(
      "echo-obj",
      `export default async (args: { data: Record<string, unknown> }) => ({ isObject: typeof args.data === "object" && !Array.isArray(args.data), keys: Object.keys(args.data ?? {}) });`,
    );
    const wf = makeWorkflow({
      nodes: [
        {
          id: "script",
          type: "swarm-script",
          config: {
            scriptName: "echo-obj",
            args: { data: "{{trigger.payload}}" },
          },
        },
      ],
    });

    const runId = await startWorkflowExecution(wf, { payload: { a: 1, b: 2 } }, registry);
    const run = getWorkflowRun(runId);
    const steps = getWorkflowRunStepsByRunId(runId);
    const scriptStep = steps.find((step) => step.nodeId === "script");

    expect(run?.status).toBe("completed");
    expect(scriptStep?.status).toBe("completed");
    expect(scriptStep?.output).toMatchObject({ result: { isObject: true, keys: ["a", "b"] } });
  });

  test("{{path}} args: array arg is injected as raw array, not JSON string", async () => {
    await saveScript(
      "echo-arr",
      `export default async (args: { items: string[] }) => ({ isArray: Array.isArray(args.items), length: args.items.length });`,
    );
    const wf = makeWorkflow({
      nodes: [
        {
          id: "script",
          type: "swarm-script",
          config: {
            scriptName: "echo-arr",
            args: { items: "{{trigger.list}}" },
          },
        },
      ],
    });

    const runId = await startWorkflowExecution(wf, { list: ["x", "y", "z"] }, registry);
    const run = getWorkflowRun(runId);
    const steps = getWorkflowRunStepsByRunId(runId);
    const scriptStep = steps.find((step) => step.nodeId === "script");

    expect(run?.status).toBe("completed");
    expect(scriptStep?.status).toBe("completed");
    expect(scriptStep?.output).toMatchObject({ result: { isArray: true, length: 3 } });
  });

  test("{{path}} args: empty array is injected as raw empty array with length 0, not '[]' string", async () => {
    await saveScript(
      "echo-empty-arr",
      `export default async (args: { items: string[] }) => ({ isArray: Array.isArray(args.items), length: args.items.length });`,
    );
    const wf = makeWorkflow({
      nodes: [
        {
          id: "script",
          type: "swarm-script",
          config: {
            scriptName: "echo-empty-arr",
            args: { items: "{{trigger.empty}}" },
          },
        },
      ],
    });

    const runId = await startWorkflowExecution(wf, { empty: [] }, registry);
    const run = getWorkflowRun(runId);
    const steps = getWorkflowRunStepsByRunId(runId);
    const scriptStep = steps.find((step) => step.nodeId === "script");

    expect(run?.status).toBe("completed");
    expect(scriptStep?.status).toBe("completed");
    expect(scriptStep?.output).toMatchObject({ result: { isArray: true, length: 0 } });
  });

  test("{{path}} args: string scalar arg is injected as the string value", async () => {
    await saveScript(
      "echo-str",
      `export default async (args: { name: string }) => ({ isString: typeof args.name === "string", value: args.name });`,
    );
    const wf = makeWorkflow({
      nodes: [
        {
          id: "script",
          type: "swarm-script",
          config: {
            scriptName: "echo-str",
            args: { name: "{{trigger.ruleName}}" },
          },
        },
      ],
    });

    const runId = await startWorkflowExecution(
      wf,
      { ruleName: "local-rules/cognitive-complexity" },
      registry,
    );
    const run = getWorkflowRun(runId);
    const steps = getWorkflowRunStepsByRunId(runId);
    const scriptStep = steps.find((step) => step.nodeId === "script");

    expect(run?.status).toBe("completed");
    expect(scriptStep?.status).toBe("completed");
    expect(scriptStep?.output).toMatchObject({
      result: { isString: true, value: "local-rules/cognitive-complexity" },
    });
  });

  test("{{path}} args: number scalar arg is injected as a number, not a string", async () => {
    await saveScript(
      "echo-num",
      `export default async (args: { count: number }) => ({ isNumber: typeof args.count === "number", value: args.count });`,
    );
    const wf = makeWorkflow({
      nodes: [
        {
          id: "script",
          type: "swarm-script",
          config: {
            scriptName: "echo-num",
            args: { count: "{{trigger.maxFiles}}" },
          },
        },
      ],
    });

    const runId = await startWorkflowExecution(wf, { maxFiles: 3 }, registry);
    const run = getWorkflowRun(runId);
    const steps = getWorkflowRunStepsByRunId(runId);
    const scriptStep = steps.find((step) => step.nodeId === "script");

    expect(run?.status).toBe("completed");
    expect(scriptStep?.status).toBe("completed");
    expect(scriptStep?.output).toMatchObject({ result: { isNumber: true, value: 3 } });
  });

  test("{{path}} args: boolean scalar arg is injected as a boolean, not a string", async () => {
    await saveScript(
      "echo-bool",
      `export default async (args: { enabled: boolean }) => ({ isBoolean: typeof args.enabled === "boolean", value: args.enabled });`,
    );
    const wf = makeWorkflow({
      nodes: [
        {
          id: "script",
          type: "swarm-script",
          config: {
            scriptName: "echo-bool",
            args: { enabled: "{{trigger.enabled}}" },
          },
        },
      ],
    });

    const runId = await startWorkflowExecution(wf, { enabled: false }, registry);
    const run = getWorkflowRun(runId);
    const steps = getWorkflowRunStepsByRunId(runId);
    const scriptStep = steps.find((step) => step.nodeId === "script");

    expect(run?.status).toBe("completed");
    expect(scriptStep?.status).toBe("completed");
    expect(scriptStep?.output).toMatchObject({ result: { isBoolean: true, value: false } });
  });

  test("{{path}} args: mixed string template still produces a string via interpolation", async () => {
    await saveScript(
      "echo-mixed",
      `export default async (args: { label: string }) => ({ isString: typeof args.label === "string", value: args.label });`,
    );
    const wf = makeWorkflow({
      nodes: [
        {
          id: "script",
          type: "swarm-script",
          config: {
            scriptName: "echo-mixed",
            args: { label: "rule-{{trigger.ruleName}}" },
          },
        },
      ],
    });

    const runId = await startWorkflowExecution(wf, { ruleName: "no-explicit-any" }, registry);
    const run = getWorkflowRun(runId);
    const steps = getWorkflowRunStepsByRunId(runId);
    const scriptStep = steps.find((step) => step.nodeId === "script");

    expect(run?.status).toBe("completed");
    expect(scriptStep?.status).toBe("completed");
    expect(scriptStep?.output).toMatchObject({
      result: { isString: true, value: "rule-no-explicit-any" },
    });
  });

  test("fsMode workspace-rw is rejected at config validation with a clear error message", async () => {
    await saveScript("noop", `export default async () => ({ ok: true });`);
    const executor = new SwarmScriptExecutor(deps);
    const wf = makeWorkflow({ nodes: [] });
    const result = await executor.run({
      config: { scriptName: "noop", fsMode: "workspace-rw" },
      context: {},
      meta: {
        runId: crypto.randomUUID(),
        stepId: crypto.randomUUID(),
        nodeId: "script",
        workflowId: wf.id,
        dryRun: false,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("workspace-rw");

    const success = await executor.run({
      config: { scriptName: "noop", fsMode: "none" },
      context: {},
      meta: {
        runId: crypto.randomUUID(),
        stepId: crypto.randomUUID(),
        nodeId: "script",
        workflowId: wf.id,
        dryRun: false,
      },
    });
    expect(success.status).toBe("success");
  });

  test("timeoutMs not set — script completes with the default 30s window", async () => {
    await saveScript("quick", `export default async () => ({ done: true });`);
    const executor = new SwarmScriptExecutor(deps);
    const wf = makeWorkflow({ nodes: [] });
    const result = await executor.run({
      config: { scriptName: "quick" },
      context: {},
      meta: {
        runId: crypto.randomUUID(),
        stepId: crypto.randomUUID(),
        nodeId: "script",
        workflowId: wf.id,
        dryRun: false,
      },
    });

    expect(result.status).toBe("success");
    expect(result.output?.result).toEqual({ done: true });
  });

  test("timeoutMs set — a long-running script is killed before it finishes", async () => {
    await saveScript(
      "sleeper",
      `export default async () => { await new Promise(r => setTimeout(r, 3000)); return { done: true }; };`,
    );
    const executor = new SwarmScriptExecutor(deps);
    const wf = makeWorkflow({ nodes: [] });
    const result = await executor.run({
      config: { scriptName: "sleeper", timeoutMs: 300 },
      context: {},
      meta: {
        runId: crypto.randomUUID(),
        stepId: crypto.randomUUID(),
        nodeId: "script",
        workflowId: wf.id,
        dryRun: false,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.output?.exitCode).not.toBe(0);
  });

  test("Failure in the script surfaces as a workflow-node failure", async () => {
    await saveScript("throws", `export default async () => { throw new Error("boom"); };`);
    const executor = new SwarmScriptExecutor(deps);
    const wf = makeWorkflow({ nodes: [] });
    const result = await executor.run({
      config: { scriptName: "throws" },
      context: {},
      meta: {
        runId: crypto.randomUUID(),
        stepId: crypto.randomUUID(),
        nodeId: "script",
        workflowId: wf.id,
        dryRun: false,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("boom");
    expect(result.output?.exitCode).not.toBe(0);
  });
});
