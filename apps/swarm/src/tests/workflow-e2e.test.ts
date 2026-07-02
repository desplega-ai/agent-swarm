import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createWorkflow,
  getDb,
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import type { Workflow, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { SwarmScriptExecutor } from "../workflows/executors/swarm-script";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-e2e.sqlite";
const API_KEY = "test-workflow-e2e-key-1234567890";

const noOpEmbeddingProvider = {
  name: "test/noop-workflow-e2e-embedding",
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

let savedEnv: NodeJS.ProcessEnv;
let agentId: string;
let eventBus: InProcessEventBus;
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
  return createWorkflow({
    name: `workflow-e2e-${crypto.randomUUID()}`,
    definition: def,
    createdByAgentId: agentId,
  });
}

async function saveScript(name: string, source: string) {
  return upsertScriptByName({
    name,
    scope: "agent",
    scopeId: agentId,
    source,
    description: `${name} e2e script`,
    intent: "workflow swarm-script e2e fixture",
    signatureJson,
    agentId,
    typeChecked: true,
  });
}

async function waitForRunStatus(runId: string, status: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (getWorkflowRun(runId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for workflow run ${runId} to reach ${status}`);
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);

  const agent = createAgent({ name: "workflow-e2e-agent", isLead: true, status: "idle" });
  agentId = agent.id;

  eventBus = new InProcessEventBus();
  const db = await import("../be/db");
  const deps: ExecutorDependencies = {
    db,
    eventBus,
    interpolate: (template, ctx) => interpolate(template, ctx).result,
  };
  registry = new ExecutorRegistry();
  registry.register(new SwarmScriptExecutor(deps));
  registry.register(new AgentTaskExecutor(deps));
  setupWorkflowResumeListener(eventBus, registry);
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
  getDb().run("DELETE FROM agent_tasks");
  getDb().run("DELETE FROM workflows");
});

describe("workflow e2e swarm-script", () => {
  test("swarm-script full workflow run executes through the engine", async () => {
    await saveScript(
      "square",
      `export default async (args: { value: number }) => ({ squared: args.value * args.value });`,
    );
    const workflow = makeWorkflow({
      nodes: [
        {
          id: "script",
          type: "swarm-script",
          config: { scriptName: "square", args: { value: 4 } },
        },
      ],
    });

    const runId = await startWorkflowExecution(workflow, {}, registry);
    const run = getWorkflowRun(runId);
    const steps = getWorkflowRunStepsByRunId(runId);

    expect(run?.status).toBe("completed");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.output).toMatchObject({ result: { squared: 16 } });
  });

  test("swarm-script  agent-task interleave", async () => {
    await saveScript(
      "first-script",
      `export default async (args: { value: number }) => ({ value: args.value + 1 });`,
    );
    await saveScript(
      "second-script",
      `export default async (args: { value: string }) => ({ final: Number(args.value) + 1 });`,
    );
    const workflow = makeWorkflow({
      nodes: [
        {
          id: "first",
          type: "swarm-script",
          config: { scriptName: "first-script", args: { value: 1 } },
          next: "task",
        },
        {
          id: "task",
          type: "agent-task",
          inputs: { first: "first.result.value" },
          config: { template: "Use {{first}}" },
          next: "second",
        },
        {
          id: "second",
          type: "swarm-script",
          inputs: { taskValue: "task.taskOutput.value" },
          config: { scriptName: "second-script", args: { value: "{{taskValue}}" } },
        },
      ],
    });

    const runId = await startWorkflowExecution(workflow, {}, registry);
    expect(getWorkflowRun(runId)?.status).toBe("waiting");

    const waitingSteps = getWorkflowRunStepsByRunId(runId);
    const taskStep = waitingSteps.find((step) => step.nodeId === "task");
    expect(taskStep?.status).toBe("waiting");
    const task = getTaskByWorkflowRunStepId(taskStep!.id);
    expect(task?.task).toBe("Use 2");

    eventBus.emit("task.completed", {
      taskId: task!.id,
      output: JSON.stringify({ value: 41 }),
      workflowRunId: runId,
      workflowRunStepId: taskStep!.id,
    });

    await waitForRunStatus(runId, "completed");
    const completedSteps = getWorkflowRunStepsByRunId(runId);
    expect(completedSteps).toHaveLength(3);
    expect(completedSteps.find((step) => step.nodeId === "first")?.status).toBe("completed");
    expect(completedSteps.find((step) => step.nodeId === "task")?.status).toBe("completed");
    expect(completedSteps.find((step) => step.nodeId === "second")?.output).toMatchObject({
      result: { final: 42 },
    });
  });
});
