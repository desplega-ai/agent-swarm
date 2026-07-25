import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getTaskById,
  initDb,
  updateTaskRoutingDirectives,
} from "../be/db";
import { createEdgeHandler } from "../be/edge-handlers-db";
import { getEventsByEvent } from "../be/events";
import { listTraceForTask } from "../be/routing-trace-db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handleRouting } from "../http/routing";
import "../prompts/session-templates";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { getBasePrompt } from "../prompts/base-prompt";
import { applyRoutingDecisionToOptions } from "../routing/apply";
import { runClaimRouting } from "../routing/claim";
import { createRoutingEngine, type RoutingScriptRunner } from "../routing/engine";
import type { RoutingCtx } from "../routing/types";
import { sendTaskHandler } from "../tools/send-task";
import { setApiKey } from "../utils/api-key";

const TEST_DB_PATH = "./test-routing-prompt-compose.sqlite";
let leadId: string;
let workerAId: string;
let workerBId: string;
let server: Server;
const TEST_PORT = 13067;
const BASE = `http://localhost:${TEST_PORT}`;

const noOpEmbeddingProvider = {
  name: "test/noop-routing-prompt-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

function removeDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB_PATH + suffix);
    } catch {
      // Missing test database files are expected.
    }
  }
}

function ctx(taskType: string): RoutingCtx {
  return {
    via: "prompt",
    task: { description: taskType, source: "mcp", taskType, tags: [], priority: 50 },
    candidates: [],
    continuity: { parent: null, chainDepth: 0 },
  };
}

function promptHandler(name: string, taskType: string, mode: "soft" | "hard" = "soft"): void {
  createEdgeHandler({
    name,
    edge: "prompt.compose",
    scriptName: name,
    flavor: "route",
    mode,
    matcher: { taskType, via: "prompt" },
  });
}

const savedApiKeyEnv = {
  AGENT_SWARM_API_KEY: process.env.AGENT_SWARM_API_KEY,
  API_KEY: process.env.API_KEY,
};

beforeAll(async () => {
  removeDbFiles();
  initDb(TEST_DB_PATH);
  leadId = createAgent({
    name: "routing-prompt-lead",
    isLead: true,
    status: "idle",
    maxTasks: 20,
  }).id;
  workerAId = createAgent({
    name: "routing-prompt-worker-a",
    isLead: false,
    status: "idle",
    maxTasks: 20,
  }).id;
  workerBId = createAgent({
    name: "routing-prompt-worker-b",
    isLead: false,
    status: "idle",
    maxTasks: 20,
  }).id;
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  setApiKey("routing-prompt-test-key");
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const handled = await handleRouting(
      req,
      res,
      getPathSegments(url),
      parseQueryParams(url),
      req.headers["x-agent-id"] as string | undefined,
    );
    if (!handled) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));
});

afterEach(() => {
  getDb().run("DELETE FROM edge_handlers");
  getDb().run("DELETE FROM routing_trace");
  getDb().run("DELETE FROM events");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setScriptEmbeddingProviderForTests(null);
  for (const [key, value] of Object.entries(savedApiKeyEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  removeDbFiles();
});

async function routingRequest(path: string, agentId: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "X-Agent-ID": agentId },
  });
}

describe("routing prompt composition", () => {
  test("prompt-compose scopes durable directives to the assigned agent", async () => {
    const task = createTaskExtended("prompt ownership", {
      agentId: workerAId,
      routingDirectives: {
        directives: ["Stay focused."],
        suggestions: [],
        routingRunId: "ownership-run",
      },
    });

    const assigned = await routingRequest(`/api/routing/prompt-compose/${task.id}`, workerAId);
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toMatchObject({
      routingDirectives: { directives: ["Stay focused."] },
    });

    const different = await routingRequest(`/api/routing/prompt-compose/${task.id}`, workerBId);
    expect(different.status).toBe(404);

    const unknown = await routingRequest(
      `/api/routing/prompt-compose/${crypto.randomUUID()}`,
      workerAId,
    );
    expect(unknown.status).toBe(404);
  });

  test("persists creation and claim directives", () => {
    const options = applyRoutingDecisionToOptions(
      { agentId: workerAId },
      {
        suggestions: [{ handlerName: "soft", assignTo: workerBId }],
        mutations: {},
        promptDirectives: ["Prefer the focused worker."],
        notes: [],
        routingRunId: "creation-run",
        trace: [],
      },
    );
    const created = createTaskExtended("creation directives", options);
    expect(getTaskById(created.id)?.routingDirectives).toEqual({
      directives: ["Prefer the focused worker."],
      suggestions: [{ handlerName: "soft", assignTo: workerBId }],
      routingRunId: "creation-run",
    });

    updateTaskRoutingDirectives(created.id, {
      directives: ["Claim-time guidance."],
      suggestions: [],
      routingRunId: "claim-run",
    });
    expect(getTaskById(created.id)?.routingDirectives).toMatchObject({
      directives: ["Claim-time guidance."],
      routingRunId: "claim-run",
    });
  });

  test("renders durable guidance through the base-prompt composition seam", async () => {
    const prompt = await getBasePrompt({
      role: "worker",
      agentId: workerAId,
      swarmUrl: "http://swarm.test",
      routingDirectives: {
        directives: ["Keep the task scoped."],
        suggestions: [{ handlerName: "soft", assignTo: workerBId }],
      },
    });
    expect(prompt).toContain("## Routing guidance");
    expect(prompt).toContain("- Keep the task scoped.");
    expect(prompt).toContain(`Routing suggested assigning this to ${workerBId}`);

    const withoutGuidance = await getBasePrompt({
      role: "worker",
      agentId: workerAId,
      swarmUrl: "http://swarm.test",
    });
    expect(withoutGuidance).not.toContain("## Routing guidance");
  });

  test("prompt.compose adds directives, ignores decisive results, and fails open", async () => {
    promptHandler("directive", "compose");
    promptHandler("decisive", "compose", "hard");
    promptHandler("error", "compose");
    const runner: RoutingScriptRunner = async ({ scriptName }) => {
      if (scriptName === "directive")
        return { result: { promptDirectives: ["Use the compact path."] }, stdout: "" };
      if (scriptName === "decisive") return { result: { assignTo: workerBId }, stdout: "" };
      throw new Error("prompt handler unavailable");
    };

    const decision = await createRoutingEngine(runner, "prompt.compose")(ctx("compose"));
    expect(decision.promptDirectives).toEqual(["Use the compact path."]);
    expect(decision.final).toBeUndefined();
    expect(decision.suggestions).toEqual([]);
    expect(decision.trace.find((trace) => trace.handlerName === "error")?.error).toContain(
      "prompt handler unavailable",
    );
  });

  test("records a Lead deviation only when a delegated child differs from a suggestion", async () => {
    const parent = createTaskExtended("parent with a soft suggestion", {
      agentId: workerAId,
      creatorAgentId: leadId,
      routingDirectives: {
        directives: [],
        suggestions: [{ handlerName: "continuity", assignTo: workerAId }],
        routingRunId: "parent-routing-run",
      },
    });
    const different = await sendTaskHandler(
      { kind: "owner", agentId: leadId, sourceTaskId: parent.id },
      {
        agentId: workerBId,
        task: "delegate elsewhere",
        offerMode: false,
        allowDuplicate: true,
        overrideSlackContext: false,
      },
    );
    const differentContent = different.structuredContent as { success: boolean; message: string };
    expect(differentContent.success).toBe(true);
    expect(getEventsByEvent("routing.lead_deviated")).toHaveLength(1);
    expect(listTraceForTask(parent.id).some((trace) => trace.deviated)).toBe(true);

    getDb().run("DELETE FROM events");
    getDb().run("DELETE FROM routing_trace");
    const same = await sendTaskHandler(
      { kind: "owner", agentId: leadId, sourceTaskId: parent.id },
      {
        agentId: workerAId,
        task: "delegate as suggested",
        offerMode: false,
        allowDuplicate: true,
        overrideSlackContext: false,
      },
    );
    expect((same.structuredContent as { success: boolean }).success).toBe(true);
    expect(getEventsByEvent("routing.lead_deviated")).toHaveLength(0);
  });

  test("repeated claim routing does not duplicate durable directives or suggestions", async () => {
    await upsertScriptByName({
      name: "claim-idempotent",
      scope: "global",
      source:
        'export default async function run() { return { assignTo: "' +
        workerBId +
        '", promptDirectives: ["Claim once."] }; }',
      description: "claim routing test fixture",
      intent: "test idempotent claim directive persistence",
      signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
      agentId: leadId,
      typeChecked: true,
    });
    createEdgeHandler({
      name: "claim-idempotent",
      edge: "task.before_assign",
      scriptName: "claim-idempotent",
      flavor: "route",
      mode: "soft",
      matcher: { via: "claim" },
    });
    const task = createTaskExtended("pooled claim idempotency", { creatorAgentId: leadId });

    await runClaimRouting(task, workerAId);
    const afterFirst = getTaskById(task.id)!;
    await runClaimRouting(afterFirst, workerAId);
    const afterSecond = getTaskById(task.id)!;

    expect(afterSecond.routingDirectives).toEqual(afterFirst.routingDirectives);
    expect(afterSecond.routingDirectives?.directives).toEqual(["Claim once."]);
    expect(afterSecond.routingDirectives?.suggestions).toEqual([
      { handlerName: "claim-idempotent", assignTo: workerBId },
    ]);
  });
});
