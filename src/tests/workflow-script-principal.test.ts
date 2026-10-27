import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createScheduledTask,
  createWorkflow,
  getDbClient,
  initDb,
  listWorkflows,
} from "../be/db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import * as runCredential from "../be/scripts/run-credential";
import { runSeeder } from "../be/seed";
import { createWorkflowsSeeder } from "../be/seed/workflows-seeder";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import { dispatchScheduleTarget } from "../scheduler/scheduler";
import { registerTriggerWorkflowTool } from "../tools/workflows/trigger-workflow";
import type { Workflow } from "../types";
import {
  getExecutorRegistry,
  initWorkflows,
  stopRetryPoller,
  workflowEventBus,
} from "../workflows";
import { handleEventTrigger } from "../workflows/triggers";
import { listenOnFreePort } from "./test-net";

// A creator-less workflow (the seeded `dreaming`) runs its `swarm-script` nodes as
// the agent the server stamped on the run. `trigger.agentId` is caller data: a
// worker that triggers `dreaming` with the lead's id must not get the lead's
// script credential. The script runner is stubbed; each call records the agent
// it was asked to run as.

const TEST_DB_PATH = "./test-workflow-script-principal.sqlite";

type ScriptCall = { agentId: string; args: Record<string, unknown> };
let calls: ScriptCall[] = [];
const QUIET_GATHER = { ok: true, agents: [], dryRun: true };
let scriptResult: Record<string, unknown> = QUIET_GATHER;
let runnerSpy: ReturnType<typeof spyOn>;
let leadId: string;
let workerId: string;
let dreaming: Workflow;
let server: Server;
let port = 0;
let callTrigger: (args: Record<string, unknown>, agentId: string) => Promise<unknown>;

/** The agents the `gather` node (the entry node, `dreaming-gather`) ran as. */
const gatherPrincipals = () =>
  calls.filter((c) => c.args.minTasks !== undefined).map((c) => c.agentId);

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // absent
    }
  }
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  await initWorkflows();
  leadId = (await createAgent({ name: "principal-lead", isLead: true, status: "idle" })).id;
  workerId = (await createAgent({ name: "principal-worker", isLead: false, status: "idle" })).id;

  await runSeeder(createWorkflowsSeeder(), { quiet: true });
  // The runner is stubbed, so the entry node only needs its global row to resolve.
  setScriptEmbeddingProviderForTests({
    name: "test/noop-principal-embedding",
    dimensions: 1,
    async embed() {
      return null;
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => null);
    },
  });
  for (const name of ["dreaming-gather", "dreaming-reports-check"]) {
    await upsertScriptByName({
      name,
      scope: "global",
      source: "export default async () => ({ ok: true });",
      description: "principal test stub",
      intent: "workflow-script-principal test fixture",
      signatureJson: "{}",
      agentId: leadId,
      typeChecked: true,
    });
  }
  const seeded = (await listWorkflows()).find((w) => w.name === "dreaming");
  if (!seeded) throw new Error("dreaming was not seeded");
  expect(seeded.createdByAgentId).toBeUndefined();
  dreaming = seeded;

  runnerSpy = spyOn(runCredential, "runScriptWithRunCredential").mockImplementation(
    async (input) => {
      calls.push({ agentId: input.agentId, args: input.args as Record<string, unknown> });
      // By default gather reports no agents, so the run takes the quiet branch
      // and parks on the publish agent-task: only the principal matters there.
      return {
        result: scriptResult,
        stdout: "",
        stderr: "",
        truncated: { stdout: false, stderr: false },
        durationMs: 1,
        exitCode: 0,
      } as Awaited<ReturnType<typeof runCredential.runScriptWithRunCredential>>;
    },
  );

  const mcp = new McpServer({ name: "test-workflow-script-principal", version: "1.0.0" });
  registerTriggerWorkflowTool(mcp);
  const tools = (mcp as unknown as Record<string, unknown>)._registeredTools as Record<
    string,
    { handler: (args: unknown, extra: unknown) => Promise<unknown> }
  >;
  callTrigger = (args, agentId) =>
    tools["trigger-workflow"]!.handler(args, {
      sessionId: "session-test",
      requestInfo: { headers: { "x-agent-id": agentId } },
    });

  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
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
      res.end();
    }
  });
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  runnerSpy.mockRestore();
  setScriptEmbeddingProviderForTests(null);
  stopRetryPoller();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles();
});

beforeEach(() => {
  // Dreaming has no cooldown, so earlier runs (parked on an agent-task) do not
  // block the next trigger.
  calls = [];
  scriptResult = QUIET_GATHER;
});

describe("swarm-script principal for a creator-less workflow", () => {
  test("a worker triggering seeded dreaming with {agentId: lead} runs its scripts as itself (MCP)", async () => {
    await callTrigger(
      { id: dreaming.id, triggerData: { agentId: leadId, dryRun: true } },
      workerId,
    );
    expect(gatherPrincipals()).toEqual([workerId]);
    expect(calls.some((c) => c.agentId === leadId)).toBe(false);
  });

  test("the same forgery through the REST trigger route runs as the X-Agent-ID caller", async () => {
    const res = await fetch(`http://localhost:${port}/api/workflows/${dreaming.id}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": workerId },
      body: JSON.stringify({ agentId: leadId, dryRun: true }),
    });
    expect(res.status).toBe(201);
    expect(gatherPrincipals()).toEqual([workerId]);
  });

  test("an event payload naming the lead runs with no agent (the workflow sentinel)", async () => {
    await createWorkflow({
      name: `principal-event-${crypto.randomUUID()}`,
      definition: dreaming.definition,
      triggers: [{ type: "event", eventName: "principal.test" }],
    });
    await handleEventTrigger("principal.test", { agentId: leadId }, getExecutorRegistry());
    expect(gatherPrincipals()).toEqual(["workflow"]);
  });

  test("a sub-workflow child runs as the parent's principal, not an agentId in its inputs", async () => {
    const parent = await createWorkflow({
      name: `principal-parent-${crypto.randomUUID()}`,
      createdByAgentId: workerId,
      definition: {
        nodes: [
          {
            id: "child",
            type: "sub-workflow",
            config: { workflowId: dreaming.id, inputs: { agentId: leadId, dryRun: true } },
          },
        ],
      },
    });
    await callTrigger({ id: parent.id }, workerId);
    await Bun.sleep(50);
    expect(gatherPrincipals()).toEqual([workerId]);
  });

  test("a schedule runs as its creator, not as the targetAgentId it names", async () => {
    const forged = await createScheduledTask({
      name: `principal-forged-${crypto.randomUUID().slice(0, 8)}`,
      cronExpression: "0 0 1 1 *",
      targetType: "workflow",
      workflowId: dreaming.id,
      targetAgentId: leadId,
      createdByAgentId: workerId,
    });
    await dispatchScheduleTarget(forged);
    expect(gatherPrincipals()).toEqual([workerId]);
  });

  test("control: a schedule the lead created fires its scripts as the lead", async () => {
    const schedule = await createScheduledTask({
      name: `principal-lead-${crypto.randomUUID().slice(0, 8)}`,
      cronExpression: "0 0 1 1 *",
      targetType: "workflow",
      workflowId: dreaming.id,
      createdByAgentId: leadId,
    });
    await dispatchScheduleTarget(schedule);
    expect(gatherPrincipals()).toEqual([leadId]);
  });

  test("control: a workflow with a creator still runs as its creator", async () => {
    const owned = await createWorkflow({
      name: `principal-owned-${crypto.randomUUID()}`,
      definition: dreaming.definition,
      createdByAgentId: leadId,
    });
    await callTrigger({ id: owned.id, triggerData: { agentId: workerId } }, workerId);
    expect(gatherPrincipals()).toEqual([leadId]);
  });

  test("control: the seeded schedule's fire (a worker triggers with no data) runs the *-lead nodes on the lead", async () => {
    // dreaming-daily makes a pool task; the worker that claims it calls
    // trigger-workflow with no triggerData. Scripts run as that worker, while
    // synthesize and apply-lead target gather's leadAgentId.
    scriptResult = {
      ok: true,
      agents: [{ id: workerId, name: "principal-worker" }],
      leadAgentId: leadId,
      dryRun: true,
      caps: {},
      retry: [],
      reports: [],
    };
    const res: any = await callTrigger({ id: dreaming.id }, workerId);
    const runId = res.structuredContent.runId as string;
    const outputs: Record<string, unknown> = {
      reports: {
        agentId: workerId,
        summary: "quiet day",
        repeatedProcedures: [],
        skillFriction: [],
        scriptCandidates: [],
        identityOps: [],
        memoryOps: [],
      },
      synthesize: { headline: "nothing to change", actions: [], rejected: [] },
    };
    const assigned = new Map<string, string | null>();
    for (let round = 0; round < 20 && !assigned.has("apply-lead"); round++) {
      const open = await getDbClient().query<{
        id: string;
        agentId: string | null;
        stepId: string;
        nodeId: string;
      }>(
        `SELECT t.id, t.agentId, t.workflowRunStepId AS stepId, s.nodeId FROM agent_tasks t
           JOIN workflow_run_steps s ON s.id = t.workflowRunStepId
          WHERE t.workflowRunId = ? AND t.status NOT IN ('completed', 'failed', 'cancelled')`,
        [runId],
      );
      for (const task of open) {
        const node = task.nodeId.split("#")[0] as string;
        assigned.set(node, task.agentId);
        if (node === "apply-lead") continue;
        const output = JSON.stringify(outputs[node] ?? { ok: true });
        await completeTask(task.id, output);
        workflowEventBus.emit("task.completed", {
          taskId: task.id,
          output,
          workflowRunId: runId,
          workflowRunStepId: task.stepId,
        });
      }
      await Bun.sleep(20);
    }
    expect(gatherPrincipals()).toEqual([workerId]);
    expect(assigned.get("synthesize")).toBe(leadId);
    expect(assigned.get("apply-lead")).toBe(leadId);
  });
});
