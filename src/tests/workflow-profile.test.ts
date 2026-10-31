// `profile` on workflow agent-task nodes (plan phase 6): save rejects a static
// profile that is unknown, sits beside model/modelTier, or fails the check for
// a static agentId (foreach bodies too); a node run creates its task with the
// profile; an interpolated profile that fails the check fails the node.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as db from "../be/db";
import {
  closeDb,
  createAgent,
  createSwarmRepo,
  createWorkflow,
  getTaskByWorkflowRunStepId,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { updateAgentCredStatus } from "../be/db/agents";
import { createModelProfile } from "../be/db/model-profiles";
import { reloadModelsCatalog } from "../be/model-catalog-store";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import { registerUpdateWorkflowTool } from "../tools/workflows/update-workflow";
import type { AgentCredStatus, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { workflowModelErrors } from "../workflows/model-validation";
import { interpolate } from "../workflows/template";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-workflow-profile.sqlite";
const oldEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;

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
  process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
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
  if (oldEncryptionKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = oldEncryptionKey;
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

// A workflow update that only moves the workflow to another repo still judges
// its stored definition: a static profile's credential allowlist now checks
// against that repo's pool (repo > agent), on both the HTTP and MCP paths.
describe("workflow repo change", () => {
  let server: Server;
  let baseUrl = "";
  let updateTool: (args: Record<string, unknown>) => Promise<unknown>;
  let repoAgentId = "";

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      const handled = await handleWorkflows(
        req,
        res,
        getPathSegments(req.url || ""),
        parseQueryParams(req.url || ""),
        req.headers["x-agent-id"] as string | undefined,
      );
      if (!handled) {
        res.writeHead(404);
        res.end("{}");
      }
    });
    baseUrl = `http://localhost:${await listenOnFreePort(server)}`;

    const mcp = new McpServer({ name: "test-workflow-profile", version: "1.0.0" });
    registerUpdateWorkflowTool(mcp);
    const tools = (mcp as unknown as Record<string, unknown>)._registeredTools as Record<
      string,
      { handler: (args: unknown, extra: unknown) => Promise<unknown> }
    >;
    updateTool = (args) =>
      tools["update-workflow"]!.handler(args, {
        sessionId: "session-test",
        requestInfo: { headers: { "x-agent-id": "agent-test" } },
      });

    await createModelProfile({
      name: "wp-claude-repo-key",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["22222"] },
    });
    repoAgentId = (
      await createAgent({
        name: "wp-claude-repo",
        isLead: false,
        status: "idle",
        harnessProvider: "claude",
      })
    ).id;
    await updateAgentCredStatus(repoAgentId, READY);
    const secret = { isSecret: true, exportToEnv: true, key: "CLAUDE_CODE_OAUTH_TOKEN" };
    await upsertSwarmConfig({
      ...secret,
      scope: "agent",
      scopeId: repoAgentId,
      value: "sk-ant-oat01-secret-material-bbbbbbbb-22222",
    });
    const repo = await createSwarmRepo({
      url: "https://github.com/acme/wp-widgets",
      name: "wp-widgets",
    });
    await upsertSwarmConfig({
      ...secret,
      scope: "repo",
      scopeId: repo.id,
      value: "sk-ant-oat01-secret-material-aaaaaaaa-11111",
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function profiledWorkflow() {
    counter++;
    const definition = agentTaskDef({ agentId: repoAgentId, profile: "wp-claude-repo-key" });
    expect(await workflowModelErrors(definition)).toEqual([]);
    return await createWorkflow({ name: `workflow-profile-repo-${counter}`, definition });
  }

  test("PUT /api/workflows/{id} with only vcsRepo re-judges the stored definition", async () => {
    const workflow = await profiledWorkflow();
    const put = (body: unknown) =>
      fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Agent-ID": crypto.randomUUID() },
        body: JSON.stringify(body),
      });

    const moved = await put({ vcsRepo: "acme/wp-widgets" });
    expect(moved.status).toBe(400);
    expect(JSON.stringify(await moved.json())).toContain("credential-allowlist");
    expect((await getWorkflow(workflow.id))?.vcsRepo ?? null).toBeNull();

    // Control: an update that leaves the repo alone does not re-judge.
    const renamed = await put({ description: "still in no repo" });
    expect(renamed.status).toBe(200);
  });

  test("update-workflow with only vcsRepo re-judges the stored definition", async () => {
    const workflow = await profiledWorkflow();
    const result = (await updateTool({ id: workflow.id, vcsRepo: "acme/wp-widgets" })) as {
      structuredContent?: { success: boolean; message: string };
    };
    expect(result.structuredContent?.success).toBe(false);
    expect(result.structuredContent?.message).toContain("credential-allowlist");
    expect((await getWorkflow(workflow.id))?.vcsRepo ?? null).toBeNull();
  });
});
