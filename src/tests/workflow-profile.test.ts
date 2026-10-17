// `profile` on workflow agent-task nodes (plan phase 6): save rejects a static
// profile that is unknown, sits beside model/modelTier, or fails the check for
// a static agentId (foreach bodies too); a node run creates its task with the
// profile; an interpolated profile that fails the check fails the node.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import * as db from "../be/db";
import {
  closeDb,
  createAgent,
  createWorkflow,
  getTaskByWorkflowRunStepId,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import { updateAgentCredStatus } from "../be/db/agents";
import { createModelProfile } from "../be/db/model-profiles";
import { reloadModelsCatalog } from "../be/model-catalog-store";
import type { AgentCredStatus, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { workflowModelErrors } from "../workflows/model-validation";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-profile.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => undefined);
  }
}

const READY: AgentCredStatus = {
  ready: true,
  missing: [],
  satisfiedBy: "env",
  hint: null,
  liveTest: null,
  latestModel: null,
  reportedAt: Date.now(),
  reportKind: "boot",
  bedrock: null,
  acp: null,
};

const deps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: workflowEventBus,
  interpolate: (template, ctx) => interpolate(template, ctx).result,
};

let registry: ExecutorRegistry;
let claudeId = "";
let codexId = "";

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  await reloadModelsCatalog();
  registry = new ExecutorRegistry();
  registry.register(new AgentTaskExecutor(deps));
  claudeId = (
    await createAgent({
      name: "wp-claude",
      isLead: false,
      status: "idle",
      harnessProvider: "claude",
    })
  ).id;
  await updateAgentCredStatus(claudeId, READY);
  codexId = (
    await createAgent({ name: "wp-codex", isLead: false, status: "idle", harnessProvider: "codex" })
  ).id;
  await updateAgentCredStatus(codexId, READY);
  await createModelProfile({ name: "wp-claude-opus", harness: "claude", model: "opus" });
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

function agentTaskDef(config: Record<string, unknown>): WorkflowDefinition {
  return {
    nodes: [{ id: "work", type: "agent-task", config: { template: "do it", ...config } }],
  } as unknown as WorkflowDefinition;
}

describe("workflow save (workflowModelErrors)", () => {
  test("rejects a static unknown profile", async () => {
    const errors = await workflowModelErrors(agentTaskDef({ profile: "wp-no-such-profile" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Node "work" config.profile');
    expect(errors[0]).toContain('Unknown model profile "wp-no-such-profile"');
  });

  test("rejects a harness mismatch with a static agentId", async () => {
    const errors = await workflowModelErrors(
      agentTaskDef({ agentId: codexId, profile: "wp-claude-opus" }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Node "work" config.profile');
    expect(errors[0]).toContain('Model profile "wp-claude-opus" fails harness');
  });

  test("rejects profile beside model or modelTier", async () => {
    for (const extra of [{ model: "opus" }, { modelTier: "smart" }]) {
      const errors = await workflowModelErrors(
        agentTaskDef({ agentId: claudeId, profile: "wp-claude-opus", ...extra }),
      );
      expect(errors.some((e) => e.includes("config.profile") && e.includes("not both"))).toBe(true);
    }
  });

  test("judges a foreach body", async () => {
    const definition = {
      nodes: [
        {
          id: "each",
          type: "foreach",
          config: {
            items: "{{trigger.items}}",
            body: {
              type: "agent-task",
              config: { template: "x", agentId: codexId, profile: "wp-claude-opus" },
            },
          },
        },
      ],
    } as unknown as WorkflowDefinition;
    const errors = await workflowModelErrors(definition);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Node "each" config.body.config.profile');
  });

  test("accepts a passing profile, a pool node, and an interpolated profile", async () => {
    expect(
      await workflowModelErrors(agentTaskDef({ agentId: claudeId, profile: "wp-claude-opus" })),
    ).toEqual([]);
    expect(await workflowModelErrors(agentTaskDef({ profile: "wp-claude-opus" }))).toEqual([]);
    expect(
      await workflowModelErrors(agentTaskDef({ agentId: codexId, profile: "{{trigger.p}}" })),
    ).toEqual([]);
  });
});

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let counter = 0;
async function run(config: Record<string, unknown>, trigger: Record<string, unknown> = {}) {
  counter++;
  const workflow = await createWorkflow({
    name: `workflow-profile-${counter}-${Date.now()}`,
    definition: agentTaskDef(config),
  });
  return await startWorkflowExecution(workflow, trigger, registry);
}

describe("node run", () => {
  test("creates the task with the node's profile", async () => {
    const runId = await run({ agentId: claudeId, profile: "wp-claude-opus" });
    const step = await waitFor(async () => {
      const steps = await getWorkflowRunStepsByRunId(runId);
      return steps.find((s) => s.nodeId === "work");
    }, "work step");
    const task = await waitFor(() => getTaskByWorkflowRunStepId(step.id), "node task");
    expect(task.profile).toBe("wp-claude-opus");
    expect(task.agentId).toBe(claudeId);
  });

  test("an interpolated profile that fails the check fails the node", async () => {
    const runId = await run(
      { agentId: codexId, profile: "{{trigger.profile}}" },
      { profile: "wp-claude-opus" },
    );
    const failed = await waitFor(async () => {
      const steps = await getWorkflowRunStepsByRunId(runId);
      const step = steps.find((s) => s.nodeId === "work");
      return step?.status === "failed" ? step : null;
    }, "failed step");
    expect(failed.error).toContain('Model profile "wp-claude-opus" fails harness');
    expect(await getTaskByWorkflowRunStepId(failed.id)).toBeFalsy();
    expect((await getWorkflowRun(runId))?.status).toBe("failed");
  });
});
