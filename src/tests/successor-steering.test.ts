import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  claimTask,
  closeDb,
  createAgent,
  createSteeringMessage,
  createTaskExtended,
  getDbClient,
  getPendingSteeringForAgent,
  getPendingSteeringForTask,
  getScheduledTaskById,
  getSteeringMessageById,
  getTaskById,
  initDb,
  markSteeringDelivered,
  startTask,
  supersedeTask,
} from "../be/db";
import {
  type ApiConfig,
  createSteeringDispatchState,
  pollAndDispatchSteering,
} from "../commands/runner";
import { getRebootAffectedTasks, runRebootSweep } from "../heartbeat/heartbeat";
import { type CodexHookConfig, collectDeliverableSteering } from "../hooks/codex-hook";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { ProviderSession, SteerDeliveryResult } from "../providers/types";
import { createStandaloneScheduleTask } from "../scheduler/schedule-task";
import { createResumeFollowUp } from "../tasks/worker-follow-up";
import { acceptSteerHandler } from "../tools/accept-steer";
import { registerDeferTaskTool } from "../tools/defer-task";
import type { AgentTask } from "../types";
import { listenOnFreePort } from "./test-net";

// A steer that reached a task but was never accepted moves to the task that
// carries the work forward once the original ends. The successor's own session
// receives it through the normal live-delivery path and acknowledges it there.

type Tool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

let workerId: string;
let replacementId: string;
let deferTask: Tool;

async function makeAgent(name: string) {
  const { id } = await createAgent({
    name,
    isLead: false,
    status: "idle",
    capabilities: [],
    maxTasks: 50,
  });
  // A shared role makes either agent eligible for the other's pooled resume.
  await getDbClient().run("UPDATE agents SET role = 'coder' WHERE id = ?", [id]);
  return id;
}

async function inProgressTask(agentId = workerId) {
  const task = await createTaskExtended("work that gets a successor", { agentId });
  await startTask(task.id);
  return task;
}

async function steer(taskId: string, body: string, state: "pending" | "delivered") {
  const message = await createSteeringMessage({
    taskId,
    body,
    mode: "queue",
    source: "api",
    createdByKind: "agent",
    createdByAgentId: workerId,
  });
  if (state === "delivered") {
    expect((await markSteeringDelivered(message.id, "queue"))?.status).toBe("delivered");
  }
  return message;
}

/** Run a session for `taskId` as `agentId`: start it and deliver its pending steering. */
async function runSession(taskId: string, agentId: string) {
  const task = await getTaskById(taskId);
  if (task?.agentId !== agentId) expect(await claimTask(taskId, agentId)).not.toBeNull();
  if ((await getTaskById(taskId))?.status !== "in_progress") await startTask(taskId);
  for (const message of await getPendingSteeringForTask(taskId)) {
    expect((await markSteeringDelivered(message.id, "queue"))?.status).toBe("delivered");
  }
}

async function accept(agentId: string, steeringMessageId: string) {
  return await acceptSteerHandler({ kind: "owner", agentId }, { steeringMessageId });
}

async function supersede(parentId: string): Promise<AgentTask> {
  // Same order as POST /api/tasks/{id}/supersede: terminal first, then the resume.
  expect(
    await supersedeTask(parentId, { reason: "manual_supersede", resumeTaskId: null }),
  ).toBeTruthy();
  const resume = await createResumeFollowUp({ parentId, reason: "manual_supersede" });
  if (resume.kind !== "created") throw new Error(`resume not created: ${resume.kind}`);
  return resume.task;
}

async function deferAndWake(parentId: string): Promise<AgentTask> {
  const result = await deferTask.handler(
    { taskId: parentId, delayMs: 3_600_000, summary: "Waiting", note: "Check back" },
    { sessionId: crypto.randomUUID(), requestInfo: { headers: { "x-agent-id": workerId } } },
  );
  const { success, scheduleId } = result.structuredContent as {
    success: boolean;
    scheduleId?: string;
  };
  expect(success).toBe(true);
  const wake = await createStandaloneScheduleTask((await getScheduledTaskById(scheduleId!))!);
  expect(wake.parentTaskId).toBe(parentId);
  return wake;
}

async function rebootRetry(parentId: string): Promise<AgentTask> {
  await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    parentId,
  ]);
  await runRebootSweep();
  const retryTaskId = getRebootAffectedTasks().find((a) => a.original.id === parentId)?.retryTaskId;
  expect(retryTaskId).toBeTruthy();
  return (await getTaskById(retryTaskId!))!;
}

const SUCCESSORS = {
  "defer-task wake-up": deferAndWake,
  "reboot-sweep retry": rebootRetry,
  "supersede resume": supersede,
} as const;

beforeAll(async () => {
  initDb(":memory:");
  const server = new McpServer({ name: "successor-steering", version: "1.0.0" });
  registerDeferTaskTool(server);
  const tools = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  deferTask = tools["defer-task"]!;
});

beforeEach(async () => {
  const db = getDbClient();
  await db.run("DELETE FROM task_steering_messages");
  await db.run("DELETE FROM agent_tasks");
  await db.run("DELETE FROM agents");
  await db.run("DELETE FROM active_sessions");
  workerId = await makeAgent("Steered Worker");
  replacementId = await makeAgent("Replacement Worker");
});

afterAll(() => closeDb());

describe("successor tasks take over unhandled steering", () => {
  test.each(
    Object.keys(SUCCESSORS) as Array<keyof typeof SUCCESSORS>,
  )("%s: a delivered, unaccepted steer moves to the successor and is acknowledged there", async (path) => {
    const parent = await inProgressTask();
    const body = "Also relay the v12 result.";
    const open = await steer(parent.id, body, "delivered");
    const handled = await steer(parent.id, "Already acted on this one.", "delivered");
    expect((await accept(workerId, handled.id)).ok).toBe(true);

    const successor = await SUCCESSORS[path](parent.id);

    expect(await getSteeringMessageById(open.id)).toMatchObject({
      taskId: successor.id,
      status: "pending",
    });
    // The accepted row stays where it was handled.
    expect(await getSteeringMessageById(handled.id)).toMatchObject({
      taskId: parent.id,
      status: "handled",
    });
    // Live delivery is the only path: nothing is copied into the task text.
    expect(successor.task).not.toContain(open.id);
    expect(successor.task).not.toContain(body);

    await runSession(successor.id, workerId);
    expect((await accept(workerId, open.id)).ok).toBe(true);
    expect((await getSteeringMessageById(open.id))?.status).toBe("handled");
  });

  test("finding 1: a replacement worker acknowledges a steer carried to its resume", async () => {
    const parent = await inProgressTask(workerId);
    const message = await steer(parent.id, "Use the new endpoint.", "delivered");

    const resume = await supersede(parent.id);
    await runSession(resume.id, replacementId);

    const result = await accept(replacementId, message.id);
    expect(result.message).not.toContain("assigned to another agent");
    expect(result.ok).toBe(true);
    expect((await getSteeringMessageById(message.id))?.status).toBe("handled");
    // The original worker no longer owns it.
    expect((await accept(workerId, message.id)).ok).toBe(false);
  });

  test("finding 2: a pending steer carried on supersede is delivered once and acknowledged", async () => {
    const parent = await inProgressTask();
    const message = await steer(parent.id, "Queued before supersede.", "pending");

    const resume = await supersede(parent.id);
    expect(resume.task).not.toContain(message.id);

    // The terminal parent no longer offers it to its agent's live hooks.
    expect(await getPendingSteeringForTask(parent.id)).toEqual([]);
    expect(await getPendingSteeringForAgent(workerId)).toEqual([]);

    // Once the resume is claimed, the row is its one live delivery candidate.
    expect(await claimTask(resume.id, workerId)).not.toBeNull();
    const queued = await getPendingSteeringForAgent(workerId);
    expect(queued.map((m) => [m.id, m.taskId])).toEqual([[message.id, resume.id]]);

    await runSession(resume.id, workerId);
    expect((await accept(workerId, message.id)).ok).toBe(true);
    expect((await getSteeringMessageById(message.id))?.status).toBe("handled");
    expect(await getPendingSteeringForAgent(workerId)).toEqual([]);
    // A second delivery attempt is a no-op on the handled row.
    expect(await markSteeringDelivered(message.id, "queue")).toBeNull();
  });

  test("finding 3: a reboot retry after acceptance does not repeat the steer", async () => {
    const parent = await inProgressTask();
    const message = await steer(parent.id, "Ship v12, not v11.", "delivered");

    const r1 = await supersede(parent.id);
    await runSession(r1.id, workerId);
    expect((await accept(workerId, message.id)).ok).toBe(true);

    const r2 = await rebootRetry(r1.id);

    expect(r2.task).not.toContain(message.id);
    expect(r2.task).not.toContain("Ship v12, not v11.");
    expect(await getPendingSteeringForTask(r2.id)).toEqual([]);
    expect(await getSteeringMessageById(message.id)).toMatchObject({
      taskId: r1.id,
      status: "handled",
    });
  });

  test("finding 4: P to R1 to R2 via supersede keeps the unaccepted steer", async () => {
    const parent = await inProgressTask();
    const message = await steer(parent.id, "Second hop must still see this.", "delivered");

    const r1 = await supersede(parent.id);
    // R1 receives it but ends without accepting.
    await runSession(r1.id, workerId);
    const r2 = await supersede(r1.id);

    expect(await getSteeringMessageById(message.id)).toMatchObject({
      taskId: r2.id,
      status: "pending",
    });
    await runSession(r2.id, workerId);
    expect((await accept(workerId, message.id)).ok).toBe(true);
  });

  test("finding 4: P to W1 to W2 via double deferral keeps the unaccepted steer", async () => {
    const parent = await inProgressTask();
    const message = await steer(parent.id, "Survive two deferrals.", "delivered");

    const w1 = await deferAndWake(parent.id);
    // W1 receives it and defers again without accepting.
    await runSession(w1.id, workerId);
    const w2 = await deferAndWake(w1.id);

    expect(await getSteeringMessageById(message.id)).toMatchObject({
      taskId: w2.id,
      status: "pending",
    });
    await runSession(w2.id, workerId);
    expect((await accept(workerId, message.id)).ok).toBe(true);
  });
});

// The same hand-offs, driven through the worker's real delivery transport (the
// runner poller and the codex hook) against the real HTTP routes. The runner
// keeps one dispatch state for its whole process, and a predecessor's session
// can still be live after its task row turned terminal.
describe("successor hand-off at the delivery boundary", () => {
  let server: Server;
  let apiUrl: string;
  const originalSteeringEnabled = process.env.STEERING_ENABLED;

  beforeAll(async () => {
    process.env.STEERING_ENABLED = "true";
    server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Content-Type", "application/json");
      const url = req.url ?? "";
      const callerAgentId = req.headers["x-agent-id"] as string | undefined;
      if (await handleTasks(req, res, getPathSegments(url), parseQueryParams(url), callerAgentId)) {
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    });
    apiUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
  });

  afterAll(async () => {
    if (originalSteeringEnabled === undefined) delete process.env.STEERING_ENABLED;
    else process.env.STEERING_ENABLED = originalSteeringEnabled;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const runnerConfig = (): ApiConfig => ({ apiUrl, apiKey: "test-key", agentId: workerId });
  const hookConfig = (taskId: string): CodexHookConfig => ({
    apiUrl,
    apiKey: "test-key",
    agentId: workerId,
    taskId,
  });

  /** A live session that records every steer it receives. */
  function recordingSession(
    received: string[],
    deliver: () => Promise<SteerDeliveryResult> = async () => ({
      delivered: true,
      mode: "queue",
    }),
  ): ProviderSession {
    return {
      sessionId: crypto.randomUUID(),
      onEvent: () => {},
      waitForCompletion: async () => ({ exitCode: 0, isError: false }),
      abort: async () => {},
      deliverSteering: async (delivery) => {
        received.push(delivery.text);
        return await deliver();
      },
    };
  }

  async function sameAgentResume(parentId: string): Promise<AgentTask> {
    const resume = await supersede(parentId);
    expect(await claimTask(resume.id, workerId)).not.toBeNull();
    return resume;
  }

  test("runner: a hand-off with shared dispatch state delivers to the successor exactly once", async () => {
    const parent = await inProgressTask();
    const message = await steer(parent.id, "Runner hand-off steer.", "pending");
    // One runner process, one dispatch state, two task sessions.
    const state = createSteeringDispatchState();
    const toParent: string[] = [];
    const toResume: string[] = [];

    await pollAndDispatchSteering(runnerConfig(), parent.id, recordingSession(toParent), state);
    expect(toParent).toHaveLength(1);

    const resume = await sameAgentResume(parent.id);
    expect(await getSteeringMessageById(message.id)).toMatchObject({
      taskId: resume.id,
      status: "pending",
    });

    const resumeSession = recordingSession(toResume);
    await pollAndDispatchSteering(runnerConfig(), resume.id, resumeSession, state);
    await pollAndDispatchSteering(runnerConfig(), resume.id, resumeSession, state);

    expect(toResume).toHaveLength(1);
    expect(toResume[0]).toContain(message.id);
    expect(await getSteeringMessageById(message.id)).toMatchObject({
      taskId: resume.id,
      status: "delivered",
    });
    expect((await accept(workerId, message.id)).ok).toBe(true);
  });

  test("runner: a predecessor delivery in flight across the hand-off leaves the row to the successor", async () => {
    const parent = await inProgressTask();
    const message = await steer(parent.id, "In flight during supersede.", "pending");
    const state = createSteeringDispatchState();
    const toParent: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const parentDispatch = pollAndDispatchSteering(
      runnerConfig(),
      parent.id,
      recordingSession(toParent, async () => {
        started();
        await released;
        return { delivered: true, mode: "queue" };
      }),
      state,
    );
    await deliveryStarted;
    const resume = await sameAgentResume(parent.id);
    release();
    await parentDispatch;

    // The parent's late callback must not mark the successor's row delivered.
    expect(await getSteeringMessageById(message.id)).toMatchObject({
      taskId: resume.id,
      status: "pending",
    });
    const toResume: string[] = [];
    await pollAndDispatchSteering(runnerConfig(), resume.id, recordingSession(toResume), state);
    expect(toResume).toHaveLength(1);
    expect((await accept(workerId, message.id)).ok).toBe(true);
  });

  test("codex hook: a live predecessor's hook takes nothing after the hand-off", async () => {
    const parent = await inProgressTask();
    const message = await steer(parent.id, "Hook hand-off steer.", "pending");

    expect(await collectDeliverableSteering(hookConfig(parent.id))).toHaveLength(1);

    const resume = await sameAgentResume(parent.id);
    // The parent's session is still live and its hook fires again.
    expect(await collectDeliverableSteering(hookConfig(parent.id))).toEqual([]);
    expect(await getSteeringMessageById(message.id)).toMatchObject({
      taskId: resume.id,
      status: "pending",
    });

    const toResume = await collectDeliverableSteering(hookConfig(resume.id));
    expect(toResume).toHaveLength(1);
    expect(toResume[0]).toContain(message.id);
    expect((await accept(workerId, message.id)).ok).toBe(true);
  });

  test("codex hook: without a task id the hook delivers nothing", async () => {
    const parent = await inProgressTask();
    const message = await steer(parent.id, "No task id, no delivery.", "pending");
    const { taskId: _omit, ...agentWide } = hookConfig(parent.id);

    expect(await collectDeliverableSteering(agentWide)).toEqual([]);
    expect((await getSteeringMessageById(message.id))?.status).toBe("pending");
  });
});
