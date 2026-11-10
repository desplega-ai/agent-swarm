import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  closeDb,
  completeTask,
  createTaskExtended,
  createUser,
  failTask,
  getDbClient,
  initDb,
  startTask,
} from "../be/db";
import {
  __setRetryDelaysForTests,
  initMcpEventsDispatcher,
  stopMcpEventsDispatcher,
} from "../be/mcp-events/dispatcher";
import { MAX_SUBSCRIPTIONS_PER_USER } from "../be/mcp-events/protocol";
import {
  __setWebhookTestOverrides,
  callbackUrlProblem,
  parseWebhookSecret,
} from "../be/mcp-events/webhook";
import { type IdentityActor, mintToken } from "../be/users";
import { handleMcpUser } from "../http/mcp-user";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-mcp-user-events.sqlite";
const ACTOR: IdentityActor = { kind: "operator", id: "test" };
const LOCAL_RECEIVER_OVERRIDES = {
  allowInsecure: true,
  guard: { policy: { allowPrivate: true, allowlist: null } },
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

// ─── MCP server under test ───────────────────────────────────────────────────

let mcpServer: Server;
let mcpPort: number;

function createMcpServer(): Server {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sessionUsers: Record<string, string> = {};
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (await handleMcpUser(req, res, transports, sessionUsers)) return;
    res.writeHead(404);
    res.end();
  });
}

function parseMcpPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    return JSON.parse(
      trimmed
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n"),
    );
  }
  return JSON.parse(trimmed);
}

type RpcResponse = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

let rpcId = 10;

async function mcpPost(
  token: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ status: number; payload: RpcResponse; sessionId: string | null }> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(`http://localhost:${mcpPort}/mcp-user`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    payload: (text ? parseMcpPayload(text) : {}) as RpcResponse,
    sessionId: response.headers.get("mcp-session-id"),
  };
}

/** A client that never touches events: initialize (empty capabilities) + initialized. */
async function openSession(token: string): Promise<{ sessionId: string; init: RpcResponse }> {
  const { payload, sessionId } = await mcpPost(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "plain-client", version: "1" },
      capabilities: {},
    },
  });
  if (!sessionId) throw new Error("no session id");
  await mcpPost(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  return { sessionId, init: payload };
}

async function rpc(
  token: string,
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<RpcResponse> {
  const { payload } = await mcpPost(
    token,
    { jsonrpc: "2.0", id: rpcId++, method, ...(params ? { params } : {}) },
    sessionId,
  );
  return payload;
}

// ─── Webhook receiver ────────────────────────────────────────────────────────

type ReceivedRequest = { headers: IncomingMessage["headers"]; body: string; path: string };
type ReceiverMode = "echo" | "wrong-challenge" | "fail-once" | "fail-always";

let receiver: Server;
let receiverPort: number;
let received: ReceivedRequest[] = [];
let receiverMode: ReceiverMode = "echo";
let failuresLeft = 0;

function createReceiver(): Server {
  return createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ headers: req.headers, body, path: req.url ?? "" });
      const parsed = JSON.parse(body) as { type?: string; challenge?: string };
      if (parsed.type === "verification") {
        const challenge = receiverMode === "wrong-challenge" ? "nope" : parsed.challenge;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge }));
        return;
      }
      if (receiverMode === "fail-always" || (receiverMode === "fail-once" && failuresLeft-- > 0)) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
}

function hookUrl(path = "/hooks/a"): string {
  return `http://127.0.0.1:${receiverPort}${path}`;
}

function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

function verifySignature(request: ReceivedRequest, secret: string): boolean {
  const key = parseWebhookSecret(secret);
  if (!key) return false;
  const id = String(request.headers["webhook-id"]);
  const ts = String(request.headers["webhook-timestamp"]);
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${request.body}`).digest("base64");
  return String(request.headers["webhook-signature"])
    .split(" ")
    .some((sig) => sig === `v1,${expected}`);
}

function eventDeliveries(): ReceivedRequest[] {
  return received.filter((r) => !(JSON.parse(r.body) as { type?: string }).type);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

const originalEnabled = process.env.MCP_USER_EVENTS_ENABLED;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  mcpServer = createMcpServer();
  mcpPort = await listenOnFreePort(mcpServer, "127.0.0.1");
  receiver = createReceiver();
  receiverPort = await listenOnFreePort(receiver, "127.0.0.1");
  initMcpEventsDispatcher();
});

afterAll(async () => {
  stopMcpEventsDispatcher();
  __setWebhookTestOverrides(null);
  __setRetryDelaysForTests(null);
  if (originalEnabled === undefined) delete process.env.MCP_USER_EVENTS_ENABLED;
  else process.env.MCP_USER_EVENTS_ENABLED = originalEnabled;
  await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(async () => {
  delete process.env.MCP_USER_EVENTS_ENABLED;
  __setWebhookTestOverrides(LOCAL_RECEIVER_OVERRIDES);
  __setRetryDelaysForTests([20, 20, 20, 20]);
  received = [];
  receiverMode = "echo";
  failuresLeft = 0;
  const client = getDbClient();
  await client.run("DELETE FROM mcp_event_subscriptions");
  await client.run("DELETE FROM user_identity_events");
  await client.run("DELETE FROM user_tokens");
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM users");
});

afterEach(() => {
  stopMcpEventsDispatcher();
  initMcpEventsDispatcher();
});

async function newUser(name: string): Promise<{ id: string; token: string }> {
  const user = await createUser({ name });
  return { id: user.id, token: (await mintToken(user.id, name, ACTOR)).plaintext };
}

async function subscribe(
  token: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Promise<RpcResponse> {
  return rpc(token, sessionId, "events/subscribe", {
    name: "task.completed",
    arguments: {},
    delivery: { mode: "webhook", url: hookUrl(), secret: newSecret() },
    cursor: null,
    ...overrides,
  });
}

async function finishTask(userId: string, outcome: "completed" | "failed", parentTaskId?: string) {
  const task = await createTaskExtended("summarize the release notes", {
    requestedByUserId: userId,
    ...(parentTaskId ? { parentTaskId } : {}),
  });
  await startTask(task.id);
  if (outcome === "completed") await completeTask(task.id, "Here is the summary.");
  else await failTask(task.id, "The repo was unreachable.");
  return task;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("backward compatibility for clients that never call events/*", () => {
  test("initialize and tools/list match the kill-switch-off baseline except the capability keys", async () => {
    const user = await newUser("Plain");

    process.env.MCP_USER_EVENTS_ENABLED = "false";
    const before = await openSession(user.token);
    const toolsBefore = await rpc(user.token, before.sessionId, "tools/list");

    delete process.env.MCP_USER_EVENTS_ENABLED;
    const after = await openSession(user.token);
    const toolsAfter = await rpc(user.token, after.sessionId, "tools/list");

    expect(toolsAfter).toEqual({ ...toolsBefore, id: toolsAfter.id } as RpcResponse);
    expect(toolsAfter.result).toEqual(toolsBefore.result as Record<string, unknown>);

    const capsBefore = (before.init.result as { capabilities: Record<string, unknown> })
      .capabilities;
    const capsAfter = (after.init.result as { capabilities: Record<string, unknown> }).capabilities;
    const { events, extensions, ...restAfter } = capsAfter;
    expect(restAfter).toEqual(capsBefore);
    expect(events).toEqual({});
    expect(extensions).toEqual({ "io.modelcontextprotocol/events": {} });
    expect(Object.keys(capsBefore).sort()).toEqual(["logging", "tools"]);

    const { capabilities: _a, ...initRestBefore } = before.init.result as Record<string, unknown>;
    const { capabilities: _b, ...initRestAfter } = after.init.result as Record<string, unknown>;
    expect(initRestAfter).toEqual(initRestBefore);
  });

  test("a task finishing for a user with no subscription sends nothing", async () => {
    const user = await newUser("Quiet");
    await openSession(user.token);
    await finishTask(user.id, "completed");
    await Bun.sleep(100);
    expect(received).toHaveLength(0);
  });
});

describe("kill switch", () => {
  test("MCP_USER_EVENTS_ENABLED=false answers events/* with method not found", async () => {
    process.env.MCP_USER_EVENTS_ENABLED = "false";
    const user = await newUser("Off");
    const { sessionId, init } = await openSession(user.token);
    expect((init.result as { capabilities: Record<string, unknown> }).capabilities.events).toBe(
      undefined,
    );
    for (const method of ["events/list", "events/subscribe", "events/unsubscribe"]) {
      const response = await rpc(user.token, sessionId, method, {});
      expect(response.error?.code).toBe(-32601);
    }
  });

  test("turning it off stops delivery to existing subscriptions", async () => {
    const user = await newUser("Off later");
    const { sessionId } = await openSession(user.token);
    expect((await subscribe(user.token, sessionId)).result?.id).toBeDefined();
    process.env.MCP_USER_EVENTS_ENABLED = "false";
    await finishTask(user.id, "completed");
    await Bun.sleep(100);
    expect(eventDeliveries()).toHaveLength(0);
  });
});

describe("events/list", () => {
  test("lists task.completed and task.failed with webhook delivery", async () => {
    const user = await newUser("Lister");
    const { sessionId } = await openSession(user.token);
    const response = await rpc(user.token, sessionId, "events/list");
    const events = (response.result as { events: Array<{ name: string; delivery: string[] }> })
      .events;
    expect(events.map((e) => e.name)).toEqual(["task.completed", "task.failed"]);
    for (const e of events) expect(e.delivery).toEqual(["webhook"]);
  });
});

describe("events/subscribe", () => {
  test("verifies the endpoint with a signed challenge, then grants a lease", async () => {
    const user = await newUser("Subscriber");
    const { sessionId } = await openSession(user.token);
    const secret = newSecret();
    const response = await subscribe(user.token, sessionId, {
      delivery: { mode: "webhook", url: hookUrl(), secret },
    });
    const result = response.result as { id: string; refreshBefore: string; cursor: null };
    expect(result.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(result.cursor).toBeNull();
    const ttl = new Date(result.refreshBefore).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(59 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000);

    expect(received).toHaveLength(1);
    const challenge = received[0] as ReceivedRequest;
    expect(JSON.parse(challenge.body).type).toBe("verification");
    expect(String(challenge.headers["webhook-id"])).toMatch(/^msg_verification_/);
    expect(challenge.headers["x-mcp-subscription-id"]).toBe(result.id);
    expect(verifySignature(challenge, secret)).toBe(true);
  });

  test("a refresh keeps the id, skips the challenge and reports delivery status", async () => {
    const user = await newUser("Refresher");
    const { sessionId } = await openSession(user.token);
    const secret = newSecret();
    const params = { delivery: { mode: "webhook", url: hookUrl(), secret }, ttlMs: 120_000 };
    const first = (await subscribe(user.token, sessionId, params)).result as { id: string };
    const second = (
      await subscribe(user.token, sessionId, {
        ...params,
        // Same key with reordered argument keys and a clamped-up TTL.
        arguments: {},
        ttlMs: 1,
      })
    ).result as { id: string; refreshBefore: string; deliveryStatus: { active: boolean } };
    expect(second.id).toBe(first.id);
    expect(second.deliveryStatus.active).toBe(true);
    expect(new Date(second.refreshBefore).getTime() - Date.now()).toBeGreaterThan(55_000);
    expect(received.filter((r) => JSON.parse(r.body).type === "verification")).toHaveLength(1);
  });

  test("skipping the challenge never extends the verification window", async () => {
    const user = await newUser("Window");
    const root = await createTaskExtended("root", { requestedByUserId: user.id });
    const { sessionId } = await openSession(user.token);
    await subscribe(user.token, sessionId);
    const old = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    await getDbClient().run("UPDATE mcp_event_subscriptions SET verifiedAt = ?", [old]);
    // Same (user, url), new key: covered by the earlier check, so no new challenge.
    const second = (await subscribe(user.token, sessionId, { arguments: { taskId: root.id } }))
      .result as { id: string };
    expect(received.filter((r) => JSON.parse(r.body).type === "verification")).toHaveLength(1);
    const row = await getDbClient().get<{ verifiedAt: string }>(
      "SELECT verifiedAt FROM mcp_event_subscriptions WHERE id = ?",
      [second.id],
    );
    expect(row?.verifiedAt).toBe(old);
  });

  test("a failed challenge returns CallbackEndpointError and stores nothing", async () => {
    receiverMode = "wrong-challenge";
    const user = await newUser("Bad echo");
    const { sessionId } = await openSession(user.token);
    const response = await subscribe(user.token, sessionId);
    expect(response.error?.code).toBe(-32027);
    expect(response.error?.data).toEqual({ reason: "challenge_failed" });
    const row = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM mcp_event_subscriptions",
    );
    expect(row?.n).toBe(0);
  });

  test("rejects bad params with the draft's error codes", async () => {
    const user = await newUser("Validator");
    const { sessionId } = await openSession(user.token);
    const badSecret = await subscribe(user.token, sessionId, {
      delivery: { mode: "webhook", url: hookUrl(), secret: "whsec_c2hvcnQ=" },
    });
    expect(badSecret.error?.code).toBe(-32602);
    const unknownEvent = await subscribe(user.token, sessionId, { name: "task.exploded" });
    expect(unknownEvent.error).toMatchObject({ code: -32023, data: { kind: "event" } });
    const push = await subscribe(user.token, sessionId, {
      delivery: { mode: "push", url: hookUrl(), secret: newSecret() },
    });
    expect(push.error?.code).toBe(-32026);
    const badArgs = await subscribe(user.token, sessionId, { arguments: { severity: "P1" } });
    expect(badArgs.error?.code).toBe(-32602);
    expect(received).toHaveLength(0);
  });

  test("a taskId filter must name one of the caller's own tasks", async () => {
    const owner = await newUser("Owner");
    const other = await newUser("Other");
    const task = await createTaskExtended("owner's task", { requestedByUserId: owner.id });
    const { sessionId } = await openSession(other.token);
    const response = await subscribe(other.token, sessionId, { arguments: { taskId: task.id } });
    expect(response.error?.code).toBe(-32024);
    expect(received).toHaveLength(0);
  });

  test("caps live subscriptions per user", async () => {
    const user = await newUser("Hoarder");
    const { sessionId } = await openSession(user.token);
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER; i++) {
      const ok = await subscribe(user.token, sessionId, {
        delivery: { mode: "webhook", url: hookUrl(`/hooks/${i}`), secret: newSecret() },
      });
      expect(ok.result?.id).toBeDefined();
    }
    const challengesBefore = received.length;
    const over = await subscribe(user.token, sessionId, {
      delivery: { mode: "webhook", url: hookUrl("/hooks/over"), secret: newSecret() },
    });
    expect(over.error).toMatchObject({
      code: -32025,
      data: { limit: "subscriptions", max: MAX_SUBSCRIPTIONS_PER_USER },
    });
    // Refused before any verification POST to the new URL.
    expect(received.length).toBe(challengesBefore);
  });

  test("seals the signing secret at rest", async () => {
    const user = await newUser("Sealed");
    const { sessionId } = await openSession(user.token);
    const secret = newSecret();
    await subscribe(user.token, sessionId, {
      delivery: { mode: "webhook", url: hookUrl(), secret },
    });
    const row = await getDbClient().get<{ secretSealed: string }>(
      "SELECT secretSealed FROM mcp_event_subscriptions",
    );
    expect(row?.secretSealed).toBeDefined();
    expect(row?.secretSealed).not.toContain(secret.slice("whsec_".length, 20));
    expect(row?.secretSealed).not.toContain("whsec_");
  });
});

describe("egress guard", () => {
  test("without the local-receiver override, http and private literals are refused", () => {
    __setWebhookTestOverrides(null);
    expect(callbackUrlProblem("http://hooks.example.com/x")).not.toBeNull();
    expect(callbackUrlProblem("https://127.0.0.1/x")).not.toBeNull();
    expect(callbackUrlProblem("https://10.0.0.8/x")).not.toBeNull();
    expect(callbackUrlProblem("https://user:pw@hooks.example.com/x")).not.toBeNull();
    expect(callbackUrlProblem("https://hooks.example.com/x")).toBeNull();
  });

  test("a public name that resolves to a private address is refused at send time", async () => {
    let fetched = 0;
    __setWebhookTestOverrides({
      allowInsecure: true,
      guard: {
        policy: { allowPrivate: false, allowlist: null },
        resolve: async () => ["10.1.2.3"],
      },
      baseFetch: (async () => {
        fetched++;
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    const user = await newUser("Rebind");
    const { sessionId } = await openSession(user.token);
    const response = await subscribe(user.token, sessionId, {
      delivery: { mode: "webhook", url: "http://hooks.example.test/cb", secret: newSecret() },
    });
    expect(response.error).toMatchObject({ code: -32027, data: { reason: "connection_refused" } });
    expect(fetched).toBe(0);
  });
});

describe("delivery", () => {
  test("task.completed reaches the subscriber, signed, and only for the user's own tasks", async () => {
    const user = await newUser("Receiver");
    const other = await newUser("Stranger");
    const { sessionId } = await openSession(user.token);
    const secret = newSecret();
    const sub = (
      await subscribe(user.token, sessionId, {
        delivery: { mode: "webhook", url: hookUrl(), secret },
      })
    ).result as { id: string };

    await finishTask(other.id, "completed");
    await finishTask(user.id, "failed");
    const mine = await finishTask(user.id, "completed");
    await waitFor(() => eventDeliveries().length >= 1);
    await Bun.sleep(50);

    const deliveries = eventDeliveries();
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0] as ReceivedRequest;
    const body = JSON.parse(delivery.body);
    expect(body).toMatchObject({
      name: "task.completed",
      cursor: null,
      data: { taskId: mine.id, status: "completed", output: "Here is the summary." },
    });
    expect(body.eventId).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(delivery.headers["webhook-id"]).toBe(body.eventId);
    expect(delivery.headers["x-mcp-subscription-id"]).toBe(sub.id);
    expect(delivery.headers["content-type"]).toBe("application/json");
    expect(verifySignature(delivery, secret)).toBe(true);
  });

  test("task.failed carries the failure reason", async () => {
    const user = await newUser("Failer");
    const { sessionId } = await openSession(user.token);
    await subscribe(user.token, sessionId, { name: "task.failed" });
    const task = await finishTask(user.id, "failed");
    await waitFor(() => eventDeliveries().length >= 1);
    expect(JSON.parse((eventDeliveries()[0] as ReceivedRequest).body)).toMatchObject({
      name: "task.failed",
      data: { taskId: task.id, status: "failed", failureReason: "The repo was unreachable." },
    });
  });

  test("a taskId filter matches the task and its descendants only", async () => {
    const user = await newUser("Filter");
    const root = await createTaskExtended("root", { requestedByUserId: user.id });
    const { sessionId } = await openSession(user.token);
    await subscribe(user.token, sessionId, { arguments: { taskId: root.id } });

    await finishTask(user.id, "completed");
    const child = await finishTask(user.id, "completed", root.id);
    await waitFor(() => eventDeliveries().length >= 1);
    await Bun.sleep(50);
    const deliveries = eventDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(JSON.parse((deliveries[0] as ReceivedRequest).body).data.taskId).toBe(child.id);
  });

  test("retries a failed delivery with the same webhook-id and a fresh signature", async () => {
    const user = await newUser("Retry");
    const { sessionId } = await openSession(user.token);
    const secret = newSecret();
    await subscribe(user.token, sessionId, {
      delivery: { mode: "webhook", url: hookUrl(), secret },
    });
    receiverMode = "fail-once";
    failuresLeft = 1;
    await finishTask(user.id, "completed");
    await waitFor(() => eventDeliveries().length >= 2);
    const [first, second] = eventDeliveries() as [ReceivedRequest, ReceivedRequest];
    expect(second.headers["webhook-id"]).toBe(first.headers["webhook-id"]);
    expect(verifySignature(second, secret)).toBe(true);
    // The receiver logs the request before the server records the outcome.
    let row: { lastError: string | null; lastDeliveryAt: string | null } | null = null;
    for (let i = 0; i < 100 && !row?.lastDeliveryAt; i++) {
      await Bun.sleep(10);
      row = await getDbClient().get(
        "SELECT lastError, lastDeliveryAt FROM mcp_event_subscriptions",
      );
    }
    expect(row?.lastError).toBeNull();
    expect(row?.lastDeliveryAt).toBeTruthy();
  });

  test("stops after the bounded attempt count", async () => {
    const user = await newUser("Dead endpoint");
    const { sessionId } = await openSession(user.token);
    await subscribe(user.token, sessionId);
    receiverMode = "fail-always";
    await finishTask(user.id, "completed");
    await waitFor(() => eventDeliveries().length >= 5);
    await Bun.sleep(150);
    expect(eventDeliveries()).toHaveLength(5);
    const row = await getDbClient().get<{ lastError: string; failedSince: string }>(
      "SELECT lastError, failedSince FROM mcp_event_subscriptions",
    );
    expect(row?.lastError).toBe("http_5xx");
    expect(row?.failedSince).toBeTruthy();
  });

  test("events/unsubscribe stops delivery and is idempotent", async () => {
    const user = await newUser("Leaver");
    const { sessionId } = await openSession(user.token);
    await subscribe(user.token, sessionId, { arguments: {} });
    const params = { name: "task.completed", arguments: {}, delivery: { url: hookUrl() } };
    expect((await rpc(user.token, sessionId, "events/unsubscribe", params)).result).toEqual({
      resultType: "complete",
    });
    expect((await rpc(user.token, sessionId, "events/unsubscribe", params)).result).toEqual({
      resultType: "complete",
    });
    await finishTask(user.id, "completed");
    await Bun.sleep(100);
    expect(eventDeliveries()).toHaveLength(0);
  });

  test("another user cannot unsubscribe someone else's subscription", async () => {
    const owner = await newUser("Keeper");
    const intruder = await newUser("Intruder");
    const ownerSession = await openSession(owner.token);
    await subscribe(owner.token, ownerSession.sessionId);
    const intruderSession = await openSession(intruder.token);
    await rpc(intruder.token, intruderSession.sessionId, "events/unsubscribe", {
      name: "task.completed",
      arguments: {},
      delivery: { url: hookUrl() },
    });
    await finishTask(owner.id, "completed");
    await waitFor(() => eventDeliveries().length >= 1);
  });
});
