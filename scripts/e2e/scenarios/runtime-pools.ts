import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

type Frame = { type?: string; id?: number; seq?: number; error?: string; data?: unknown };

async function openWorkerSocket(ctx: ScenarioContext, token: string) {
  const ws = new WebSocket(`${ctx.baseUrl.replace(/^http/, "ws")}/api/realtime`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const frames: Frame[] = [];
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame;
    if (typeof frame.seq === "number") ws.send(JSON.stringify({ ack: frame.seq }));
    frames.push(frame);
  });
  const opened = await pollUntil(() => ws.readyState !== WebSocket.CONNECTING, 10_000, 20);
  if (!opened || ws.readyState !== WebSocket.OPEN) {
    ws.close();
    throw new Error("Worker realtime socket did not open");
  }
  return {
    ws,
    send: (message: Record<string, unknown>) => ws.send(JSON.stringify(message)),
    async next(predicate: (frame: Frame) => boolean) {
      expect(
        await pollUntil(() => frames.some(predicate), 10_000, 20),
        "Worker realtime frame did not arrive",
      );
      return frames.splice(frames.findIndex(predicate), 1)[0]!;
    },
  };
}

function entityId(value: unknown): string {
  const id = asRecord(value).id;
  expect(typeof id === "string", "Entity response has no id");
  return id;
}

async function verifyFlagOff(ctx: ScenarioContext) {
  for (const [method, path] of [
    ["GET", "/api/runtime-pools"],
    ["POST", "/api/runtime-pools"],
    ["GET", "/api/runtime-pools/missing"],
    ["PATCH", "/api/runtime-pools/missing"],
    ["DELETE", "/api/runtime-pools/missing"],
    ["GET", "/api/runtime-pools/missing/runtimes"],
    ["POST", "/api/runtime-pools/missing/agents"],
    ["GET", "/api/runtime-controllers"],
    ["POST", "/api/runtime-controllers"],
    ["GET", "/api/runtime-controllers/missing"],
    ["PATCH", "/api/runtime-controllers/missing"],
    ["DELETE", "/api/runtime-controllers/missing"],
    ["POST", "/api/runtime-controllers/missing/token"],
    ["PUT", "/api/agents/missing/runtime-pool"],
  ] as const) {
    expectStatus(
      await ctx.api(method, path, { body: method === "GET" ? undefined : {} }),
      [404],
      path,
    );
  }
  const registered = await ctx.api("POST", "/api/agents", {
    body: { name: `e2e-poll-${ctx.nonce}`, role: "worker" },
  });
  expectStatus(registered, [201], "register legacy worker");
  expect(
    asRecord(registered.json).deliveryMode === "poll",
    "Flag-off registration did not select poll",
  );
  const agentId = entityId(registered.json);
  const created = await ctx.api("POST", "/api/tasks", {
    body: {
      task: "Legacy poll task",
      agentId,
      routingReason: "human_pinned",
      followUpConfig: { disabled: true },
    },
  });
  expectStatus(created, [201], "create legacy task");
  const taskId = entityId(created.json);
  const polled = await ctx.api("GET", "/api/poll", { agentId });
  expectStatus(polled, [200], "poll legacy task");
  expect(
    asRecord(asRecord(polled.json).trigger).taskId === taskId,
    "Legacy poll did not dispatch the task",
  );
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/finish`, {
      agentId,
      body: { status: "completed", output: "pong" },
    }),
    [200],
    "finish legacy task",
  );
  const completed = await ctx.api("GET", `/api/tasks/${taskId}`);
  expectStatus(completed, [200], "read legacy task");
  expect(asRecord(completed.json).status === "completed", "Legacy task did not complete");
  expectStatus(
    await ctx.api("POST", "/close", { agentId, body: {} }),
    [204],
    "close legacy worker",
  );
  ctx.log("runtime-pools: flag off preserves registration and poll dispatch");
}

export const runtimePools: Scenario = {
  name: "runtime-pools",
  order: 180,
  groups: ["runtime-pools"],
  async run(ctx) {
    const status = await ctx.api("GET", "/status");
    expectStatus(status, [200], "read runtime supervisor status");
    const runtimeStatus = asRecord(asRecord(status.json).runtime_pools);
    if (runtimeStatus.enabled === false) {
      expect(runtimeStatus.supervisor === "disabled", "Flag-off supervisor is active");
      await verifyFlagOff(ctx);
      return;
    }
    expect(runtimeStatus.enabled === true, "Status does not report the runtime pools flag");
    expect(runtimeStatus.supervisor === "running", "Flag-on supervisor is not running");

    let controllerId: string | undefined;
    let poolId: string | undefined;
    let agentId: string | undefined;
    let runtimeId: string | undefined;
    let tokenId: string | undefined;
    let peer: Awaited<ReturnType<typeof openWorkerSocket>> | undefined;
    const taskIds: string[] = [];
    const cleanupErrors: { label: string; error: unknown }[] = [];
    try {
      // An offline remote controller keeps this API contract test free of infrastructure calls.
      const controller = await ctx.api("POST", "/api/runtime-controllers", {
        body: { name: `e2e-controller-${ctx.nonce}`, kind: "docker", placement: "remote" },
      });
      expectStatus(controller, [200], "create controller");
      controllerId = entityId(asRecord(controller.json).controller);
      expectStatus(
        await ctx.api("PATCH", `/api/runtime-controllers/${controllerId}`, {
          body: { config: { WORKER_API_URL: ctx.baseUrl } },
        }),
        [200],
        "update controller",
      );
      const controllerRead = await ctx.api("GET", `/api/runtime-controllers/${controllerId}`);
      expectStatus(controllerRead, [200], "read controller");
      expect(
        asRecord(asRecord(asRecord(controllerRead.json).controller).config).WORKER_API_URL ===
          ctx.baseUrl,
        "Controller configuration was not persisted",
      );
      const controllers = await ctx.api("GET", "/api/runtime-controllers");
      expectStatus(controllers, [200], "list controllers");
      expect(
        (asRecord(controllers.json).controllers as unknown[]).some(
          (row) => entityId(row) === controllerId,
        ),
        "Controller list omitted the controller",
      );

      const pool = await ctx.api("POST", "/api/runtime-pools", {
        body: {
          name: `e2e-pool-${ctx.nonce}`,
          kind: "docker",
          placements: [controllerId],
          image: "e2e-api-only",
          delivery: "push",
          lifecycle: "per-task",
          maxRuntimes: 1,
        },
      });
      expectStatus(pool, [200], "create pool");
      poolId = entityId(asRecord(pool.json).pool);
      expectStatus(
        await ctx.api("PATCH", `/api/runtime-pools/${poolId}`, {
          body: { slotsPerRuntime: 2 },
        }),
        [200],
        "update pool",
      );
      const poolRead = await ctx.api("GET", `/api/runtime-pools/${poolId}`);
      expectStatus(poolRead, [200], "read pool");
      expect(
        asRecord(asRecord(poolRead.json).pool).slotsPerRuntime === 2,
        "Pool update was not persisted",
      );
      const pools = await ctx.api("GET", "/api/runtime-pools");
      expectStatus(pools, [200], "list pools");
      expect(
        (asRecord(pools.json).pools as unknown[]).some((row) => entityId(row) === poolId),
        "Pool list omitted the pool",
      );
      const agent = await ctx.api("POST", `/api/runtime-pools/${poolId}/agents`, {
        body: { name: `e2e-sleeper-${ctx.nonce}`, maxTasks: 2 },
      });
      expectStatus(agent, [200], "create sleeping pool agent");
      agentId = entityId(asRecord(agent.json).agent);
      expect(
        asRecord(asRecord(agent.json).agent).status === "offline",
        "Pool agent started online",
      );

      const task = await ctx.api("POST", "/api/tasks", {
        body: { task: "Wake the sleeping worker", followUpConfig: { disabled: true } },
      });
      expectStatus(task, [201], "create unassigned pool task");
      const taskId = entityId(task.json);
      taskIds.push(taskId);
      expect(asRecord(task.json).status === "unassigned", "Task skipped wake grace");
      expect(
        await pollUntil(
          async () => {
            const assigned = await ctx.api("GET", `/api/tasks/${taskId}`);
            expectStatus(assigned, [200], "read wake assignment");
            const row = asRecord(assigned.json);
            return (
              row.agentId === agentId &&
              row.status === "pending" &&
              typeof row.poolWakeAt === "string"
            );
          },
          45_000,
          100,
        ),
        "Tier-two routing did not assign the sleeping agent after grace",
      );

      runtimeId = crypto.randomUUID();
      const minted = await ctx.api("POST", "/api/sessions/tokens", {
        body: { agentId, runtimeId },
      });
      expectStatus(minted, [200], "mint runtime token");
      const credential = asRecord(minted.json);
      tokenId = String(credential.tokenId);
      expect(typeof credential.plaintext === "string", "Runtime token response has no credential");
      const token = credential.plaintext;
      expectStatus(await ctx.api("GET", "/me", { apiKey: token }), [200], "runtime token identity");
      expectStatus(
        await ctx.api("GET", "/api/poll", { apiKey: token, agentId: crypto.randomUUID() }),
        [403],
        "reject spoofed agent identity",
      );
      expectStatus(
        await ctx.api("GET", "/api/poll", {
          apiKey: token,
          headers: { "X-Runtime-Instance-ID": crypto.randomUUID() },
        }),
        [403],
        "reject spoofed runtime identity",
      );
      const registered = await ctx.api("POST", "/api/agents", {
        apiKey: token,
        body: { name: `e2e-sleeper-${ctx.nonce}`, runtimeInstanceId: runtimeId, maxTasks: 2 },
      });
      expectStatus(registered, [200], "register pool runtime");
      expect(
        asRecord(registered.json).deliveryMode === "push",
        "Pool registration did not select push",
      );
      const runtimes = await ctx.api("GET", `/api/runtime-pools/${poolId}/runtimes`);
      expectStatus(runtimes, [200], "list pool runtimes");
      expect(Array.isArray(asRecord(runtimes.json).runtimes), "Pool runtime list has no array");

      peer = await openWorkerSocket(ctx, token);
      peer.send({ id: 1, op: "subscribe", namespace: `worker:${agentId}`, name: "nudge" });
      expect(
        !(await peer.next((frame) => frame.id === 1)).error,
        "Worker could not subscribe to its nudges",
      );
      for (const [id, op, namespace] of [
        [2, "subscribe", `worker:${crypto.randomUUID()}`],
        [3, "publish", `worker:${agentId}`],
      ] as const) {
        peer.send({
          id,
          op,
          namespace,
          name: "nudge",
          data: { v: 1, kind: "work", at: new Date().toISOString() },
        });
        expect(
          (await peer.next((frame) => frame.id === id)).type === "error",
          "Worker namespace allowed a forbidden operation",
        );
      }
      const nudged = await ctx.api("POST", "/api/tasks", {
        body: {
          task: "Nudge the registered worker",
          agentId,
          routingReason: "human_pinned",
          followUpConfig: { disabled: true },
        },
      });
      expectStatus(nudged, [201], "create nudge task");
      const nudgedId = entityId(nudged.json);
      taskIds.push(nudgedId);
      await peer.next(
        (frame) =>
          frame.type === "channel" &&
          asRecord(frame.data).kind === "work" &&
          asRecord(frame.data).taskId === nudgedId,
      );
      const polled = await ctx.api("GET", "/api/poll", { apiKey: token });
      expectStatus(polled, [200], "push worker fetches queued task");
      expect(
        asRecord(asRecord(polled.json).trigger).taskId === taskId,
        "Push fetch did not dispatch the wake assignment",
      );
      expectStatus(
        await ctx.api("POST", `/api/tasks/${taskId}/finish`, {
          apiKey: token,
          body: { status: "completed", output: "pong" },
        }),
        [200],
        "finish wake assignment",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/sessions/tokens/${tokenId}`),
        [204],
        "revoke runtime token",
      );
      tokenId = undefined;
      expectStatus(
        await ctx.api("GET", "/me", { apiKey: token }),
        [401],
        "reject revoked runtime token",
      );
      expect(
        await pollUntil(() => peer!.ws.readyState === WebSocket.CLOSED, 5000, 20),
        "Revocation did not close the worker socket",
      );
      ctx.log(
        "runtime-pools: CRUD, wake routing, scoped tokens, push nudges, and supervisor status verified",
      );
    } finally {
      async function cleanup(label: string, action: () => unknown | Promise<unknown>) {
        try {
          await action();
        } catch (error) {
          cleanupErrors.push({ label, error });
        }
      }
      await cleanup("close socket", () => peer?.ws.close());
      if (tokenId)
        await cleanup("revoke runtime token", () =>
          ctx.api("DELETE", `/api/sessions/tokens/${tokenId}`),
        );
      for (const id of taskIds)
        await cleanup("cancel task", () =>
          ctx.api("POST", `/api/tasks/${id}/cancel`, { body: {} }),
        );
      if (agentId && runtimeId)
        await cleanup("close runtime", () =>
          ctx.api("POST", "/close", {
            agentId,
            headers: { "X-Runtime-Instance-ID": runtimeId! },
            body: {},
          }),
        );
      if (agentId)
        await cleanup("unbind pool agent", async () =>
          expectStatus(
            await ctx.api("PUT", `/api/agents/${agentId}/runtime-pool`, {
              body: { poolId: null },
            }),
            [200],
            "unbind pool agent",
          ),
        );
      if (poolId) {
        await cleanup("delete pool", async () =>
          expectStatus(
            await ctx.api("DELETE", `/api/runtime-pools/${poolId}`),
            [200],
            "delete pool",
          ),
        );
        await cleanup("pool deleted", async () =>
          expectStatus(await ctx.api("GET", `/api/runtime-pools/${poolId}`), [404], "pool deleted"),
        );
      }
      if (controllerId) {
        await cleanup("delete controller", async () =>
          expectStatus(
            await ctx.api("DELETE", `/api/runtime-controllers/${controllerId}`),
            [200],
            "delete controller",
          ),
        );
        await cleanup("controller deleted", async () =>
          expectStatus(
            await ctx.api("GET", `/api/runtime-controllers/${controllerId}`),
            [404],
            "controller deleted",
          ),
        );
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        cleanupErrors.map(({ error }) => error),
        `Runtime pool cleanup failed: ${cleanupErrors.map(({ label }) => label).join(", ")}`,
      );
  },
};
