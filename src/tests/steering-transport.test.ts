import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createAgent,
  createSteeringMessage,
  createTaskExtended,
  getChildTasks,
  getPendingSteeringForTask,
  getSteeringMessageById,
  initDb,
  markSteeringDelivered,
  startTask,
} from "../be/db";
import { requestSteering } from "../be/steering";
import { createSteeringDispatchState, pollAndDispatchSteering } from "../commands/runner";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { getBasePrompt } from "../prompts/base-prompt";
import type { ProviderSession } from "../providers/types";
import { acceptSteerHandler } from "../tools/accept-steer";
import { finalizeSwarmToolResult } from "../tools/utils";
import type { SteeringMessage } from "../types";

const TEST_DB_PATH = `/tmp/agent-swarm-steering-transport-${process.pid}.sqlite`;
let server: Server;
let baseUrl: string;

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

function session(deliverSteering?: ProviderSession["deliverSteering"]): ProviderSession {
  return {
    sessionId: "steering-test-session",
    onEvent: () => {},
    waitForCompletion: async () => ({ exitCode: 0, isError: false }),
    abort: async () => {},
    ...(deliverSteering ? { deliverSteering } : {}),
  };
}

function pendingMessage(overrides: Partial<SteeringMessage> = {}): SteeringMessage {
  return {
    id: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    body: "change course",
    mode: "steer",
    status: "pending",
    source: "api",
    createdByKind: "system",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const originalSteeringEnabled = process.env.STEERING_ENABLED;

beforeAll(async () => {
  process.env.STEERING_ENABLED = "true";
  await removeTestDb();
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    const callerAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleTasks(req, res, pathSegments, query, callerAgentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (originalSteeringEnabled === undefined) delete process.env.STEERING_ENABLED;
  else process.env.STEERING_ENABLED = originalSteeringEnabled;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeTestDb();
});

describe("steering worker transport", () => {
  test("delivers pending rows once and reports the adapter's actual mode", async () => {
    const pending = pendingMessage();
    const nonPending = pendingMessage({ id: crypto.randomUUID(), status: "delivered" });
    const deliveries: Array<{ mode: string; text: string }> = [];
    const reports: Array<{ path: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/steering-messages?")) {
        return Response.json({ messages: [pending, nonPending] });
      }
      reports.push({
        path: new URL(url).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({ message: { ...pending, status: "delivered" } });
    }) as typeof fetch;
    const providerSession = session(async (delivery) => {
      deliveries.push(delivery);
      return { delivered: true, mode: "queue" };
    });
    const state = createSteeringDispatchState();
    const config = { apiUrl: "http://steering.test", apiKey: "key", agentId: "agent" };

    await pollAndDispatchSteering(config, pending.taskId, providerSession, state, fetchImpl);
    await pollAndDispatchSteering(config, pending.taskId, providerSession, state, fetchImpl);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.mode).toBe("steer");
    // The body is wrapped in the delivery envelope, which MUST carry the
    // steering message ID — `accept-steer` needs it, and it is the only route
    // to `handled`. Without it the agent obeys but can never acknowledge.
    expect(deliveries[0]?.text).toContain("change course");
    expect(deliveries[0]?.text).toContain(pending.id);
    expect(deliveries[0]?.text).toContain("accept-steer");
    expect(state.dispatchedIds.has(pending.id)).toBe(true);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toEqual({
      path: `/api/steering-messages/${pending.id}/delivered`,
      body: { mode: "queue" },
    });
  });

  test("scrubs provider errors before reporting an undeliverable reason", async () => {
    const pending = pendingMessage();
    const secret = "sk-proj-steering-transport-secret-1234567890";
    let reportedBody = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/api/steering-messages?")) {
        return Response.json({ messages: [pending] });
      }
      reportedBody = String(init?.body);
      return Response.json({ message: { ...pending, status: "promoted" } });
    }) as typeof fetch;

    await pollAndDispatchSteering(
      { apiUrl: "http://steering.test", apiKey: "key", agentId: "agent" },
      pending.taskId,
      session(async () => {
        throw new Error(`provider rejected bearer ${secret}`);
      }),
      createSteeringDispatchState(),
      fetchImpl,
    );

    expect(reportedBody).not.toContain(secret);
    expect(reportedBody).toContain("[REDACTED");
  });

  test("missing provider delivery promotes a non-codex pending row to a follow-up", async () => {
    const agent = createAgent({
      name: "transport fallback worker",
      isLead: false,
      status: "busy",
      maxTasks: 2,
      harnessProvider: "pi",
    });
    const task = createTaskExtended("transport fallback parent", {
      agentId: agent.id,
      source: "api",
    });
    expect(startTask(task.id)?.status).toBe("in_progress");
    const requested = requestSteering({
      taskId: task.id,
      message: "continue as a follow-up",
      mode: "queue",
      source: "api",
      createdByKind: "system",
    });
    expect(requested.outcome).toBe("queued");

    await pollAndDispatchSteering(
      { apiUrl: baseUrl, apiKey: "test-key", agentId: agent.id },
      task.id,
      session(),
      createSteeringDispatchState(),
    );

    expect(getPendingSteeringForTask(task.id)).toEqual([]);
    expect(getSteeringMessageById(requested.steeringMessageId!)).toMatchObject({
      status: "promoted",
      promotedTaskId: expect.any(String),
    });
    expect(getChildTasks(task.id)).toEqual([
      expect.objectContaining({
        parentTaskId: task.id,
        task: "continue as a follow-up",
      }),
    ]);
  });

  test("codex rows stay pending: the runner skips externally-delivered sessions", async () => {
    // Codex delivery is harness-side (codex-hook). The row must queue at
    // request time, and the runner's dispatch poll must leave it untouched —
    // dispatching would synthesize a false undeliverable and promote it out
    // from under the hook.
    const agent = createAgent({
      name: "codex steering worker",
      isLead: false,
      status: "busy",
      maxTasks: 1,
      harnessProvider: "codex",
    });
    const task = createTaskExtended("codex steering parent", {
      agentId: agent.id,
      source: "api",
    });
    expect(startTask(task.id)?.status).toBe("in_progress");

    const requested = requestSteering({
      taskId: task.id,
      message: "codex follow-up",
      mode: "steer",
      source: "api",
      createdByKind: "system",
    });

    expect(requested).toMatchObject({ outcome: "queued", degradedFrom: "steer" });

    // Session without deliverSteering — would normally be reported
    // undeliverable — but the external-delivery flag short-circuits the poll.
    const codexLikeSession = { ...session(), steeringDeliveredExternally: true };
    await pollAndDispatchSteering(
      { apiUrl: baseUrl, apiKey: "test-key", agentId: agent.id },
      task.id,
      codexLikeSession,
      createSteeringDispatchState(),
    );

    expect(getPendingSteeringForTask(task.id)).toEqual([
      expect.objectContaining({ id: requested.steeringMessageId, status: "pending" }),
    ]);
    expect(getChildTasks(task.id)).toEqual([]);
  });

  test("accept-steer marks a delivered row handled and is idempotent", async () => {
    const previousBaseUrl = process.env.MCP_BASE_URL;
    const previousApiKey = process.env.AGENT_SWARM_API_KEY;
    process.env.MCP_BASE_URL = baseUrl;
    process.env.AGENT_SWARM_API_KEY = "test-key";
    try {
      const agent = createAgent({
        name: "accept steering worker",
        isLead: false,
        status: "busy",
        maxTasks: 1,
        harnessProvider: "pi",
      });
      const task = createTaskExtended("accept steering parent", {
        agentId: agent.id,
        source: "api",
      });
      expect(startTask(task.id)?.status).toBe("in_progress");
      const steering = createSteeringMessage({
        taskId: task.id,
        body: "acknowledge this",
        mode: "queue",
        source: "api",
        createdByKind: "system",
      });
      expect(markSteeringDelivered(steering.id, "queue")?.status).toBe("delivered");
      const otherAgent = createAgent({
        name: "other accept steering worker",
        isLead: false,
        status: "busy",
        maxTasks: 1,
        harnessProvider: "pi",
      });
      const otherTask = createTaskExtended("other accept steering parent", {
        agentId: otherAgent.id,
        source: "api",
      });
      expect(startTask(otherTask.id)?.status).toBe("in_progress");
      // NEW CONTRACT: acceptSteerHandler returns a SwarmToolResult ({ ok,
      // message, data }), not a wire-level CallToolResult — isError/content
      // are synthesized only by finalizeSwarmToolResult at the registrar
      // boundary (see src/tools/utils.ts). Assert the handler-level envelope
      // directly, then also run it through the real finalize step once to
      // pin the actual wire shape a harness receives.
      const deniedResult = await acceptSteerHandler(
        {
          kind: "owner",
          agentId: otherAgent.id,
          sourceTaskId: otherTask.id,
        },
        { steeringMessageId: steering.id },
      );
      expect(deniedResult.ok).toBe(false);
      expect(deniedResult.message).toContain("assigned to another agent");
      const denied = finalizeSwarmToolResult("accept-steer", deniedResult);
      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.type).toBe("text");
      expect(denied.content[0]?.text).toContain("assigned to another agent");
      expect((denied.structuredContent as { success?: boolean })?.success).toBe(false);
      expect(getSteeringMessageById(steering.id)?.status).toBe("delivered");

      const ctx = {
        kind: "owner" as const,
        agentId: agent.id,
        sourceTaskId: task.id,
      };

      const first = await acceptSteerHandler(ctx, {
        steeringMessageId: steering.id,
        note: "Switched the summary to Spanish.",
      });
      const second = await acceptSteerHandler(ctx, { steeringMessageId: steering.id });

      // NEW CONTRACT: assert ok:true on the SwarmToolResult itself (see comment above).
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      const finalizedSecond = finalizeSwarmToolResult("accept-steer", second);
      expect(finalizedSecond.isError).not.toBe(true);
      expect((finalizedSecond.structuredContent as { success?: boolean })?.success).toBe(true);
      expect(getSteeringMessageById(steering.id)).toMatchObject({
        status: "handled",
        handledAt: expect.any(String),
        // Acceptance note persists; the idempotent second call must not clear it.
        handledNote: "Switched the summary to Spanish.",
      });
    } finally {
      if (previousBaseUrl === undefined) delete process.env.MCP_BASE_URL;
      else process.env.MCP_BASE_URL = previousBaseUrl;
      if (previousApiKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
      else process.env.AGENT_SWARM_API_KEY = previousApiKey;
    }
  });

  test("steering prompt follows provider traits and the core capability", async () => {
    const args = {
      role: "worker",
      agentId: crypto.randomUUID(),
      swarmUrl: "localhost",
      // steer-task/accept-steer register under `core`, not `task-pool`.
      serverCapabilities: ["core"],
    };
    const capable = await getBasePrompt({
      ...args,
      traits: { hasMcp: true, hasLocalEnvironment: true, steerModes: ["queue"] },
    });
    const absentTrait = await getBasePrompt({
      ...args,
      traits: { hasMcp: true, hasLocalEnvironment: true },
    });
    const capabilityDisabled = await getBasePrompt({
      ...args,
      serverCapabilities: [],
      traits: { hasMcp: true, hasLocalEnvironment: true, steerModes: ["queue"] },
    });

    expect(capable).toContain("Live Task Steering");
    expect(capable).toContain("accept-steer");
    expect(absentTrait).not.toContain("Live Task Steering");
    expect(capabilityDisabled).not.toContain("Live Task Steering");
  });
});
