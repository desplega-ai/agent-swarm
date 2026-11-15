import { createHmac, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as z from "zod";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  claimTask,
  createAssignedTask,
  createUser,
  expectToolOk,
  registerWorker,
  retireAgent,
  withMcp,
} from "./core-helpers";

// MCP Events (SEP-3415 draft, webhook mode) on /mcp-user, end to end over HTTP:
// an events-aware client subscribes with a callback on a local receiver, a worker
// settles tasks through store-progress, and the receiver checks the Standard
// Webhooks signature. A plain client sees the same tools as before, and
// unsubscribe stops delivery. The SUT boots with
// MCP_USER_EVENTS_ALLOW_PRIVATE_CALLBACKS=true so the receiver can be http://127.0.0.1.

const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
const USER_TOOLS = [
  "cancel-task",
  "get-task-details",
  "get-tasks",
  "script-get-types",
  "script-run",
  "script-search",
  "send-task",
  "steer-task",
];
const LooseResult = z.looseObject({});

type Delivery = { headers: Headers; body: string };

function startReceiver(): { url: string; deliveries: Delivery[]; stop: () => void } {
  const deliveries: Delivery[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      deliveries.push({ headers: request.headers, body });
      const parsed = JSON.parse(body) as { type?: string; challenge?: string };
      if (parsed.type === "verification") {
        return Response.json({ challenge: parsed.challenge });
      }
      return new Response(null, { status: 204 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/hooks/${randomBytes(6).toString("hex")}`,
    deliveries,
    stop: () => server.stop(true),
  };
}

function verifySignature(delivery: Delivery, secret: string): boolean {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const id = delivery.headers.get("webhook-id") ?? "";
  const timestamp = delivery.headers.get("webhook-timestamp") ?? "";
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${delivery.body}`)
    .digest("base64");
  return (delivery.headers.get("webhook-signature") ?? "").split(" ").includes(`v1,${expected}`);
}

function eventBodies(deliveries: Delivery[]): Array<Record<string, unknown>> {
  return deliveries
    .map((d) => JSON.parse(d.body) as Record<string, unknown>)
    .filter((body) => body.type === undefined);
}

async function mintToken(ctx: ScenarioContext, userId: string): Promise<string> {
  const minted = await ctx.api("POST", `/api/users/${userId}/mcp-tokens`, {
    body: { label: `events e2e ${ctx.nonce}` },
  });
  expectStatus(minted, [200], "mint user MCP token");
  return String(asRecord(minted.json).plaintext);
}

async function connectUser(
  ctx: ScenarioContext,
  token: string,
  declareEvents: boolean,
): Promise<Client> {
  const client = new Client(
    { name: `agent-swarm-e2e-${declareEvents ? "events" : "plain"}`, version: "1.0.0" },
    declareEvents ? { capabilities: { extensions: { [EVENTS_EXTENSION]: {} } } } : undefined,
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp-user`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** An `events/*` request carrying the SEP-3415 per-request client capability. */
function eventsRequest(
  client: Client,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return client.request(
    {
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": { extensions: { [EVENTS_EXTENSION]: {} } },
        },
      },
    },
    LooseResult,
  ) as Promise<Record<string, unknown>>;
}

async function settleTask(
  ctx: ScenarioContext,
  workerId: string,
  userId: string,
  outcome: "completed" | "failed",
): Promise<string> {
  const taskId = await createAssignedTask(ctx, workerId, `events e2e ${outcome} ${ctx.nonce}`, {
    requestedByUserId: userId,
  });
  await claimTask(ctx, workerId, taskId);
  await withMcp(ctx, workerId, (conn) =>
    expectToolOk(
      conn,
      "store-progress",
      outcome === "completed"
        ? { taskId, status: "completed", output: `done ${taskId}` }
        : { taskId, status: "failed", failureReason: `broke ${taskId}` },
    ),
  );
  return taskId;
}

export const mcpUserEvents: Scenario = {
  name: "mcp-user-events",
  order: 77,
  async run(ctx) {
    const receiver = startReceiver();
    const workerId = await registerWorker(ctx, "events-worker");
    const subscriberId = await createUser(ctx, "events-subscriber");
    const plainUserId = await createUser(ctx, "events-plain");
    const events = await connectUser(ctx, await mintToken(ctx, subscriberId), true);
    const plain = await connectUser(ctx, await mintToken(ctx, plainUserId), false);
    try {
      // 3. Backward compatibility: a client that never calls events/* gets the same tools.
      const plainTools = (await plain.listTools()).tools.map((t) => t.name).sort();
      expect(
        JSON.stringify(plainTools) === JSON.stringify(USER_TOOLS),
        `plain client lists exactly the user tools, got ${plainTools.join(",")}`,
      );
      const plainCaps = plain.getServerCapabilities() ?? {};
      expect(
        plainCaps.tools !== undefined && plainCaps.logging !== undefined,
        "tools and logging still advertised",
      );
      const plainTasks = asRecord(await plain.callTool({ name: "get-tasks", arguments: {} }));
      expect(plainTasks.isError !== true, "plain client get-tasks still works");

      // 1. Subscribe both events, verified through the local receiver.
      const listed = await eventsRequest(events, "events/list", {});
      const names = (listed.events as Array<{ name: string }>).map((e) => e.name);
      expect(
        names.includes("task.completed") && names.includes("task.failed"),
        `events/list offers task.completed and task.failed, got ${names.join(",")}`,
      );
      const secret = `whsec_${randomBytes(32).toString("base64")}`;
      const subscription = (name: string) => ({
        name,
        arguments: {},
        delivery: { mode: "webhook", url: receiver.url, secret },
        cursor: null,
      });
      const completedSub = await eventsRequest(
        events,
        "events/subscribe",
        subscription("task.completed"),
      );
      const failedSub = await eventsRequest(
        events,
        "events/subscribe",
        subscription("task.failed"),
      );
      expect(
        typeof completedSub.id === "string" && typeof completedSub.refreshBefore === "string",
        "subscribe returns an id and a lease",
      );
      const challenges = receiver.deliveries.filter(
        (d) => JSON.parse(d.body).type === "verification",
      );
      expect(
        challenges.length === 1,
        `one verification challenge per (user, url), got ${challenges.length}`,
      );
      expect(
        verifySignature(challenges[0] as Delivery, secret),
        "the challenge is signed with the secret",
      );

      // 2. A completed and a failed task each reach the receiver, signed.
      const completedId = await settleTask(ctx, workerId, subscriberId, "completed");
      const failedId = await settleTask(ctx, workerId, subscriberId, "failed");
      await settleTask(ctx, workerId, plainUserId, "completed");
      expect(
        await pollUntil(() => eventBodies(receiver.deliveries).length >= 2, 10_000, 100),
        "both task events were delivered",
      );
      const deliveries = receiver.deliveries.filter((d) => JSON.parse(d.body).type === undefined);
      for (const delivery of deliveries) {
        expect(verifySignature(delivery, secret), "each delivery verifies against the secret");
      }
      const byName = new Map(eventBodies(receiver.deliveries).map((b) => [b.name, b]));
      const completed = asRecord(byName.get("task.completed"));
      const failed = asRecord(byName.get("task.failed"));
      expect(
        asRecord(completed.data).taskId === completedId,
        "task.completed names the completed task",
      );
      expect(asRecord(failed.data).taskId === failedId, "task.failed names the failed task");
      expect(
        deliveries.some((d) => d.headers.get("x-mcp-subscription-id") === completedSub.id) &&
          deliveries.some((d) => d.headers.get("x-mcp-subscription-id") === failedSub.id),
        "each delivery carries its subscription id",
      );
      // The plain user's task matched no subscription.
      await Bun.sleep(500);
      expect(eventBodies(receiver.deliveries).length === 2, "no delivery for another user's task");

      // 4. Unsubscribe stops delivery.
      for (const name of ["task.completed", "task.failed"]) {
        await eventsRequest(events, "events/unsubscribe", {
          name,
          arguments: {},
          delivery: { url: receiver.url },
        });
      }
      await settleTask(ctx, workerId, subscriberId, "completed");
      await settleTask(ctx, workerId, subscriberId, "failed");
      await Bun.sleep(1_000);
      expect(eventBodies(receiver.deliveries).length === 2, "no delivery after unsubscribe");
      ctx.log(
        `delivered ${eventBodies(receiver.deliveries).length} signed events, then none after unsubscribe`,
      );
    } finally {
      await events.close();
      await plain.close();
      receiver.stop();
      await retireAgent(ctx, workerId);
    }
  },
};
