import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  cancelPendingSteeringForTask,
  closeDb,
  createAgent,
  createSteeringMessage,
  createTaskExtended,
  createUser,
  getChildTasks,
  getDbClient,
  getLatestLeadTaskInThread,
  getPendingSteeringForAgent,
  getSteeringMessageById,
  getSteeringMessagesForTask,
  getTaskById,
  hasPendingSteering,
  initDb,
  markSteeringDelivered,
  markSteeringHandled,
  pauseTask,
  startTask,
} from "../be/db";
import {
  getTaskSteeringFields,
  markSteeringUndeliverable,
  requestSteering,
  SteeringRequestError,
} from "../be/steering";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { PROVIDER_STEER_CAPABILITIES, type ProviderName, SteeringMessageSchema } from "../types";

const TEST_DB_PATH = `/tmp/agent-swarm-steering-core-${process.pid}.sqlite`;
let server: Server;
let baseUrl: string;

async function removeTestDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("task steering core", () => {
  const agentIds = new Map<ProviderName | "lead", string>();
  const originalSteeringEnabled = process.env.STEERING_ENABLED;

  beforeAll(async () => {
    process.env.STEERING_ENABLED = "true";
    await removeTestDb();
    initDb(TEST_DB_PATH);

    for (const provider of [
      "pi",
      "claude",
      "codex",
      "devin",
      "claude-managed",
      "opencode",
    ] as const) {
      const agent = await createAgent({
        name: `${provider} steering worker`,
        description: `Steering test worker for ${provider}`,
        role: "worker",
        isLead: false,
        status: "busy",
        maxTasks: 10,
        capabilities: [],
        harnessProvider: provider,
      });
      agentIds.set(provider, agent.id);
    }

    const lead = await createAgent({
      name: "Steering lead",
      description: "Lead used by steering thread tests",
      role: "lead",
      isLead: true,
      status: "busy",
      maxTasks: 10,
      capabilities: [],
      harnessProvider: "claude",
    });
    agentIds.set("lead", lead.id);

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

  async function api(
    method: string,
    path: string,
    body?: unknown,
    agentId?: string,
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (agentId) headers["X-Agent-ID"] = agentId;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
    };
  }

  async function runningTask(provider: ProviderName, label: string) {
    const task = await createTaskExtended(label, {
      agentId: agentIds.get(provider),
      source: "api",
    });
    const started = await startTask(task.id);
    expect(started?.status).toBe("in_progress");
    return started!;
  }

  test("row lifecycle transitions pending -> delivered -> handled", async () => {
    const task = await runningTask("pi", "lifecycle");
    const created = await createSteeringMessage({
      taskId: task.id,
      body: "change direction",
      mode: "queue",
      source: "api",
      createdByKind: "system",
    });

    expect(created.status).toBe("pending");
    expect(await getSteeringMessageById(created.id)).toEqual(created);
    expect(await getSteeringMessageById("missing-steering-message")).toBeNull();
    expect(SteeringMessageSchema.safeParse(created).success).toBe(true);
    expect(await hasPendingSteering(task.id)).toBe(true);
    expect(await getPendingSteeringForAgent(agentIds.get("pi")!)).toContainEqual(created);

    const delivered = await markSteeringDelivered(created.id, "queue");
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.deliveredMode).toBe("queue");
    expect(delivered?.deliveredAt).toBeDefined();
    expect(await hasPendingSteering(task.id)).toBe(false);

    const handled = await markSteeringHandled(created.id);
    expect(handled?.status).toBe("handled");
    expect(handled?.handledAt).toBeDefined();
    expect(await markSteeringHandled(created.id)).toBeNull();
  });

  test("cancels every pending row for a task", async () => {
    const task = await runningTask("pi", "cancel pending");
    for (const body of ["one", "two"]) {
      await createSteeringMessage({
        taskId: task.id,
        body,
        mode: "queue",
        source: "api",
        createdByKind: "system",
      });
    }

    expect(await cancelPendingSteeringForTask(task.id)).toBe(2);
    expect(await hasPendingSteering(task.id)).toBe(false);
    expect((await getSteeringMessagesForTask(task.id)).map((message) => message.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });

  test("codex steer requests degrade to queue and stay pending for the hook", async () => {
    // Codex is queue-capable via harness-side hook delivery: the row must
    // stay `pending` (never promoted at request time, never dispatched by the
    // runner) until the codex-hook marks it delivered.
    const task = await runningTask("codex", "codex parent");
    const result = await requestSteering({
      taskId: task.id,
      message: "continue with a safer approach",
      mode: "steer",
      source: "mcp",
      createdByKind: "agent",
      createdByAgentId: agentIds.get("lead"),
    });

    expect(result).toMatchObject({
      outcome: "queued",
      effectiveMode: "queue",
      degradedFrom: "steer",
    });
    expect(result.promotedTaskId).toBeUndefined();
    expect(await getSteeringMessagesForTask(task.id)).toEqual([
      expect.objectContaining({
        id: result.steeringMessageId,
        mode: "steer",
        status: "pending",
      }),
    ]);
  });

  test("undeliverable promotion bypasses Linear tracker context dedup", async () => {
    const parent = await createTaskExtended("linear-backed codex parent", {
      agentId: agentIds.get("codex"),
      source: "linear",
      contextKey: "task:trackers:linear:STEER-101",
    });
    expect((await startTask(parent.id))?.status).toBe("in_progress");

    const result = await requestSteering({
      taskId: parent.id,
      message: "promote this into distinct follow-up work",
      source: "api",
      createdByKind: "system",
    });
    expect(result.outcome).toBe("queued");

    const promoted = await markSteeringUndeliverable(result.steeringMessageId, "session died");
    expect(promoted.message.status).toBe("promoted");
    expect(promoted.promotedTaskId).not.toBe(parent.id);
    expect(await getTaskById(promoted.promotedTaskId!)).toMatchObject({
      parentTaskId: parent.id,
      contextKey: parent.contextKey,
      task: "promote this into distinct follow-up work",
    });
  });

  test("automatic promotion preserves inherited requester provenance", async () => {
    const user = await createUser({ name: "Steering provenance requester" });
    const parent = await createTaskExtended("heartbeat steering parent", {
      agentId: agentIds.get("codex"),
      taskType: "heartbeat-checklist",
      requestedByUserId: user.id,
    });
    expect((await startTask(parent.id))?.status).toBe("in_progress");

    const result = await requestSteering({
      taskId: parent.id,
      message: "promote autonomous steering",
      source: "api",
      createdByKind: "agent",
      createdByAgentId: agentIds.get("lead"),
    });
    const promoted = await markSteeringUndeliverable(result.steeringMessageId, "session died");
    expect((await getTaskById(promoted.promotedTaskId!))?.requestedByUserId).toBe(user.id);
    const provenance = await getDbClient().get<{ inherited: number }>(
      "SELECT requestedByUserIdInherited AS inherited FROM agent_tasks WHERE id = ?",
      [promoted.promotedTaskId!],
    );
    expect(provenance?.inherited).toBe(1);
  });

  test("claude steer requests degrade to queue while preserving requested mode", async () => {
    const task = await runningTask("claude", "claude degrade");
    const result = await requestSteering({
      taskId: task.id,
      message: "please account for the new constraint",
      mode: "steer",
      source: "ui",
      createdByKind: "user",
    });

    expect(result).toMatchObject({
      outcome: "queued",
      effectiveMode: "queue",
      degradedFrom: "steer",
    });
    expect(await getSteeringMessagesForTask(task.id)).toEqual([
      expect.objectContaining({ mode: "steer", status: "pending" }),
    ]);
  });

  test("degradation follows the capability map, not a hardcoded provider list", async () => {
    // Regression: the ladder used to special-case `provider === "claude"`, so
    // narrowing devin to queue-only left it reporting outcome "steered" for a
    // mode it cannot honor. Every queue-only provider must degrade identically.
    const queueOnly = (Object.keys(PROVIDER_STEER_CAPABILITIES) as ProviderName[]).filter(
      (provider) => {
        const modes = PROVIDER_STEER_CAPABILITIES[provider];
        return modes.length > 0 && !modes.includes("steer");
      },
    );
    expect(queueOnly.length).toBeGreaterThan(0);

    for (const provider of queueOnly) {
      const task = await runningTask(provider, `${provider} degrade`);
      expect(
        await requestSteering({
          taskId: task.id,
          message: "please account for the new constraint",
          mode: "steer",
          source: "ui",
          createdByKind: "user",
        }),
      ).toMatchObject({ outcome: "queued", effectiveMode: "queue", degradedFrom: "steer" });
    }
  });

  test("paused tasks auto-start before steering is queued", async () => {
    const task = await runningTask("pi", "paused auto-start");
    expect((await pauseTask(task.id))?.status).toBe("paused");

    const result = await requestSteering({
      taskId: task.id,
      message: "resume with this context",
      source: "api",
      createdByKind: "system",
    });

    expect(result).toMatchObject({ outcome: "queued", effectiveMode: "queue" });
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("pending tasks queue steering for delivery once the session starts", async () => {
    const task = await createTaskExtended("pending queue target", {
      agentId: agentIds.get("pi"),
      source: "api",
    });
    expect(task.status).toBe("pending");

    const result = await requestSteering({
      taskId: task.id,
      message: "context before the session exists",
      source: "api",
      createdByKind: "system",
    });

    // Not promoted — the row waits as `pending` and the worker delivers it
    // after claiming the task and starting the session.
    expect(result).toMatchObject({ outcome: "queued", effectiveMode: "queue" });
    expect((await getSteeringMessageById(result.steeringMessageId))?.status).toBe("pending");
    expect((await getTaskById(task.id))?.status).toBe("pending");
  });

  test("steer mode on a pending task degrades to queue (nothing to interrupt)", async () => {
    const task = await createTaskExtended("pending steer target", {
      agentId: agentIds.get("pi"),
      source: "api",
    });

    const result = await requestSteering({
      taskId: task.id,
      message: "interrupt before start",
      mode: "steer",
      source: "api",
      createdByKind: "system",
    });

    expect(result).toMatchObject({
      outcome: "queued",
      effectiveMode: "queue",
      degradedFrom: "steer",
    });
    expect((await getSteeringMessageById(result.steeringMessageId))?.status).toBe("pending");
  });

  test("pending codex tasks queue for hook delivery once the session starts", async () => {
    const task = await createTaskExtended("pending codex target", {
      agentId: agentIds.get("codex"),
      source: "api",
    });

    const result = await requestSteering({
      taskId: task.id,
      message: "codex pre-start message",
      source: "api",
      createdByKind: "system",
    });

    expect(result.outcome).toBe("queued");
    expect(result.promotedTaskId).toBeUndefined();
    expect((await getSteeringMessageById(result.steeringMessageId))?.status).toBe("pending");
  });

  test("latest lead task lookup excludes newer worker-assigned Slack tasks", async () => {
    const channelId = "C-STEERING";
    const threadTs = "1234.5678";
    const leadTask = await createTaskExtended("lead thread task", {
      agentId: agentIds.get("lead"),
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
    });
    await createTaskExtended("newer worker thread task", {
      agentId: agentIds.get("pi"),
      source: "slack",
      slackChannelId: channelId,
      slackThreadTs: threadTs,
    });

    expect((await getLatestLeadTaskInThread(channelId, threadTs))?.id).toBe(leadTask.id);
  });

  test("scrubs secrets before persisting the steering body", async () => {
    const previous = process.env.OPENAI_API_KEY;
    const secret = "sk-proj-steering-secret-value-1234567890";
    process.env.OPENAI_API_KEY = secret;
    try {
      const task = await runningTask("pi", "secret scrubbing");
      await requestSteering({
        taskId: task.id,
        message: `Use token ${secret} only for this request`,
        source: "api",
        createdByKind: "system",
      });
      const stored = (await getSteeringMessagesForTask(task.id))[0]!;
      expect(stored.body).not.toContain(secret);
      expect(stored.body).toContain("[REDACTED:OPENAI_API_KEY]");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test('onUnsupported:"fail" returns 422 and creates no row', async () => {
    const task = await runningTask("claude", "unsupported fail");

    try {
      await requestSteering({
        taskId: task.id,
        message: "must interrupt now",
        mode: "steer",
        onUnsupported: "fail",
        source: "api",
        createdByKind: "system",
      });
      throw new Error("Expected requestSteering to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(SteeringRequestError);
      expect((error as SteeringRequestError).statusCode).toBe(422);
      expect((error as Error).message).toContain("claude");
    }

    expect(await getSteeringMessagesForTask(task.id)).toEqual([]);
  });

  test('onUnsupported:"fail" leaves a paused task paused and creates no row', async () => {
    const task = await runningTask("claude", "paused unsupported fail");
    expect((await pauseTask(task.id))?.status).toBe("paused");

    try {
      await requestSteering({
        taskId: task.id,
        message: "must interrupt without resuming",
        mode: "steer",
        onUnsupported: "fail",
        source: "api",
        createdByKind: "system",
      });
      throw new Error("Expected requestSteering to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(SteeringRequestError);
      expect((error as SteeringRequestError).statusCode).toBe(422);
    }

    expect((await getTaskById(task.id))?.status).toBe("paused");
    expect(await getSteeringMessagesForTask(task.id)).toEqual([]);
  });

  test("undeliverable service promotes once and is idempotent", async () => {
    const task = await runningTask("pi", "service undeliverable");
    const message = await createSteeringMessage({
      taskId: task.id,
      body: "promote from service",
      mode: "queue",
      source: "api",
      createdByKind: "system",
    });

    const first = await markSteeringUndeliverable(message.id, "provider rejected delivery");
    const second = await markSteeringUndeliverable(message.id, "retry");

    expect(first.message.status).toBe("promoted");
    expect(first.promotedTaskId).toBeDefined();
    expect(second).toEqual(first);
    expect(await getChildTasks(task.id)).toHaveLength(1);
  });

  test("worker delivery routes enforce assignment and are idempotent", async () => {
    const ownerId = agentIds.get("pi")!;
    const otherAgentId = agentIds.get("claude")!;
    const task = await runningTask("pi", "delivery endpoint");
    const message = await createSteeringMessage({
      taskId: task.id,
      body: "deliver over HTTP",
      mode: "steer",
      source: "api",
      createdByKind: "system",
    });

    expect(
      (
        await api("POST", `/api/steering-messages/${message.id}/delivered`, {
          mode: "queue",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          "POST",
          `/api/steering-messages/${message.id}/delivered`,
          { mode: "queue" },
          otherAgentId,
        )
      ).status,
    ).toBe(403);

    const delivered = await api(
      "POST",
      `/api/steering-messages/${message.id}/delivered`,
      { mode: "queue" },
      ownerId,
    );
    expect(delivered.status).toBe(200);
    expect(delivered.body.message).toMatchObject({
      id: message.id,
      status: "delivered",
      deliveredMode: "queue",
    });

    const retried = await api(
      "POST",
      `/api/steering-messages/${message.id}/delivered`,
      { mode: "steer" },
      ownerId,
    );
    expect(retried.status).toBe(200);
    expect(retried.body.message).toEqual(delivered.body.message);
  });

  test("worker undeliverable route promotes once and returns the promoted task id on retry", async () => {
    const ownerId = agentIds.get("pi")!;
    const otherAgentId = agentIds.get("claude")!;
    const task = await runningTask("pi", "undeliverable endpoint");
    const message = await createSteeringMessage({
      taskId: task.id,
      body: "promote over HTTP",
      mode: "queue",
      source: "api",
      createdByKind: "system",
    });

    const forbidden = await api(
      "POST",
      `/api/steering-messages/${message.id}/undeliverable`,
      { reason: "not this worker's message" },
      otherAgentId,
    );
    expect(forbidden.status).toBe(403);
    expect((await getSteeringMessageById(message.id))?.status).toBe("pending");

    const first = await api(
      "POST",
      `/api/steering-messages/${message.id}/undeliverable`,
      { reason: "provider has no live delivery method" },
      ownerId,
    );
    expect(first.status).toBe(200);
    expect(first.body.message).toMatchObject({
      id: message.id,
      status: "promoted",
      promotedTaskId: first.body.promotedTaskId,
    });
    expect(first.body.promotedTaskId).toBeString();

    const retried = await api(
      "POST",
      `/api/steering-messages/${message.id}/undeliverable`,
      { reason: "retry" },
      ownerId,
    );
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual(first.body);
    expect(await getChildTasks(task.id)).toHaveLength(1);
  });

  test('onUnsupported defaults to "degrade" when omitted', async () => {
    const task = await runningTask("claude", "unsupported default");
    const result = await requestSteering({
      taskId: task.id,
      message: "interrupt if possible",
      mode: "steer",
      source: "api",
      createdByKind: "system",
    });
    expect(result).toMatchObject({
      outcome: "queued",
      effectiveMode: "queue",
      degradedFrom: "steer",
    });
  });

  test("task read steering fields match provider capabilities", async () => {
    for (const provider of ["claude", "codex", "pi"] as const) {
      const task = await createTaskExtended(`${provider} capability read`, {
        agentId: agentIds.get(provider),
        source: "api",
      });
      expect((await getTaskSteeringFields(task)).supportedSteerModes).toEqual(
        PROVIDER_STEER_CAPABILITIES[provider],
      );
    }
  });
});
