import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, createTaskExtended, getDb, initDb } from "../be/db";
import { createEdgeHandler } from "../be/edge-handlers-db";
import { getEventsByEvent } from "../be/events";
import { listTraceForTask } from "../be/routing-trace-db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { createTaskRouted } from "../tasks/create-task-routed";
import { sendTaskHandler } from "../tools/send-task";
import type { AgentTask } from "../types";

const TEST_DB_PATH = "./test-routing-vias.sqlite";
const API_KEY = "test-routing-vias-key-1234567890";

const noOpEmbeddingProvider = {
  name: "test/noop-routing-vias-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

let savedEnv: NodeJS.ProcessEnv;
let leadId: string;
let workerAId: string;
let workerBId: string;

function removeDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB_PATH + suffix);
    } catch {
      // Missing test DB files are expected.
    }
  }
}

async function saveRoutingScript(name: string, result: unknown): Promise<void> {
  await upsertScriptByName({
    name,
    scope: "global",
    source: `export default async function run() { return ${JSON.stringify(result)}; }`,
    description: `${name} routing test fixture`,
    intent: "routing vias test fixture",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
    agentId: leadId,
    typeChecked: true,
  });
}

async function registerHandler(args: {
  name: string;
  result: unknown;
  flavor?: "route" | "guard";
  mode?: "soft" | "hard";
  matcher: {
    via: "creation" | "delegation";
    slackChannelId?: string;
    agentId?: string;
    taskType?: string;
  };
}): Promise<void> {
  await saveRoutingScript(args.name, args.result);
  createEdgeHandler({
    name: args.name,
    edge: "task.before_assign",
    scriptName: args.name,
    flavor: args.flavor ?? "route",
    mode: args.mode ?? "hard",
    matcher: args.matcher,
    createdByAgentId: leadId,
  });
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  removeDbFiles();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  leadId = createAgent({
    name: "routing-vias-lead",
    isLead: true,
    status: "idle",
    maxTasks: 20,
  }).id;
  workerAId = createAgent({
    name: "routing-vias-worker-a",
    isLead: false,
    status: "idle",
    maxTasks: 20,
  }).id;
  workerBId = createAgent({
    name: "routing-vias-worker-b",
    isLead: false,
    status: "idle",
    maxTasks: 20,
  }).id;
});

afterEach(() => {
  getDb().run("DELETE FROM edge_handlers");
});

afterAll(() => {
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  removeDbFiles();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("routing creation and delegation vias", () => {
  test("creation hard-assigns Slack-shaped work, backfills trace, and emits applied", async () => {
    await registerHandler({
      name: "creation-slack-hard-assign",
      result: { assignTo: workerBId },
      matcher: { via: "creation", slackChannelId: "C-TEST" },
    });

    const { task } = await createTaskRouted("Slack-shaped routed creation", {
      agentId: workerAId,
      source: "slack",
      slackChannelId: "C-TEST",
      slackThreadTs: "123.456",
    });
    const trace = listTraceForTask(task.id);

    expect(task.agentId).toBe(workerBId);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      taskId: task.id,
      handlerName: "creation-slack-hard-assign",
      decisive: true,
    });
    expect(
      getEventsByEvent("routing.applied").some(
        (event) => event.data?.routingRunId === trace[0]?.routingRunId,
      ),
    ).toBe(true);
  });

  test("delegation continuity is resolved before a hard assignment override", async () => {
    const parent = createTaskExtended("delegation continuity parent", {
      agentId: workerAId,
      creatorAgentId: leadId,
    });
    await registerHandler({
      name: "delegation-hard-override",
      result: { assignTo: workerBId },
      matcher: { via: "delegation", agentId: workerAId, taskType: "delegation-override" },
    });

    const response = await sendTaskHandler(
      { kind: "owner", agentId: leadId, sourceTaskId: parent.id },
      {
        task: "delegated child with continuity",
        taskType: "delegation-override",
        offerMode: false,
        allowDuplicate: false,
        overrideSlackContext: false,
      },
    );
    const structured = response.structuredContent as {
      success: boolean;
      task?: AgentTask;
    };

    expect(structured.success).toBe(true);
    expect(structured.task).toMatchObject({
      agentId: workerBId,
      parentTaskId: parent.id,
    });
    expect(listTraceForTask(structured.task?.id ?? "")).toHaveLength(1);
  });

  test("creation block returns a Lead reroute-decision task instead of original work", async () => {
    await registerHandler({
      name: "creation-block",
      result: { block: { reason: "creation policy denied" } },
      flavor: "guard",
      matcher: { via: "creation", taskType: "blocked-create" },
    });

    const { task, blocked } = await createTaskRouted("original blocked creation", {
      agentId: workerAId,
      taskType: "blocked-create",
    });

    expect(blocked).toEqual({ reason: "creation policy denied" });
    expect(task).toMatchObject({
      agentId: leadId,
      taskType: "reroute-decision",
      status: "pending",
    });
    expect(task.tags).toContain("routing-blocked");
    expect(task.task).toContain("creation policy denied");
    expect(task.task).toContain("original blocked creation");
  });

  test("delegation block creates a Lead decision and returns the reason to the caller", async () => {
    const parent = createTaskExtended("delegation block parent", {
      agentId: workerAId,
      creatorAgentId: leadId,
    });
    await registerHandler({
      name: "delegation-block",
      result: { block: { reason: "delegation policy denied" } },
      flavor: "guard",
      matcher: { via: "delegation", taskType: "blocked-delegation" },
    });

    const response = await sendTaskHandler(
      { kind: "owner", agentId: leadId, sourceTaskId: parent.id },
      {
        task: "blocked delegated work",
        taskType: "blocked-delegation",
        offerMode: false,
        allowDuplicate: false,
        overrideSlackContext: false,
      },
    );
    const structured = response.structuredContent as {
      success: boolean;
      message: string;
      task?: AgentTask;
    };

    expect(structured.success).toBe(false);
    expect(structured.message).toContain("delegation policy denied");
    expect(structured.task).toMatchObject({
      agentId: leadId,
      taskType: "reroute-decision",
      parentTaskId: parent.id,
    });
  });

  test("soft assignment suggestion does not change creation assignment", async () => {
    await registerHandler({
      name: "creation-soft-suggestion",
      result: { assignTo: workerBId },
      mode: "soft",
      matcher: { via: "creation", taskType: "soft-suggestion" },
    });

    const { task } = await createTaskRouted("soft routed creation", {
      agentId: workerAId,
      taskType: "soft-suggestion",
    });

    expect(task.agentId).toBe(workerAId);
    expect(listTraceForTask(task.id)[0]).toMatchObject({
      suggestion: workerBId,
      decisive: false,
    });
  });
});
