import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getAgentById, getDbClient, initDb } from "../be/db";
import { seedRuntimePools } from "../be/runtime-pools/seed";
import { handleRuntimePools } from "../http/runtime-pools";
import { buildStatusPayload } from "../http/status";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { clearAuditSink, type RbacCheck, setAuditSink } from "../rbac";
import { registerRuntimeControllerListTool } from "../tools/runtime-controller-list";
import { registerRuntimePoolBindAgentTool } from "../tools/runtime-pool-bind-agent";
import { registerRuntimePoolCreateAgentTool } from "../tools/runtime-pool-create-agent";
import { registerRuntimePoolDeleteTool } from "../tools/runtime-pool-delete";
import { registerRuntimePoolListTool } from "../tools/runtime-pool-list";
import { registerRuntimePoolUpsertTool } from "../tools/runtime-pool-upsert";
import type { User } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { scrubSecrets } from "../utils/secret-scrubber";

const path = "./test-runtime-pools-http.sqlite";
const savedFlag = process.env.RUNTIME_POOLS_ENABLED;
let leadId: string;
let workerId: string;
let userId: string;
async function cleanup() {
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(path + suffix)
      .delete()
      .catch(() => {});
}
async function dispatch(
  path: string,
  method = "GET",
  body?: unknown,
  caller: "operator" | "lead" | "worker" | "user" | "anonymous" = "operator",
  headerAgentId?: string,
) {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = { "content-type": "application/json" };
  const agentId =
    headerAgentId ?? (caller === "lead" ? leadId : caller === "worker" ? workerId : undefined);
  if (caller !== "anonymous")
    setRequestAuth(
      req,
      caller === "user"
        ? { kind: "user", userId, user: { id: userId } as User }
        : { kind: "operator" },
    );
  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      text += String(chunk ?? "");
    },
  } as unknown as ServerResponse;
  expect(
    await handleRuntimePools(req, res, getPathSegments(path), parseQueryParams(path), agentId),
  ).toBe(true);
  return { status, text, data: JSON.parse(text) };
}
beforeAll(async () => {
  await cleanup();
  initDb(path);
});
afterAll(async () => {
  closeDb();
  await cleanup();
  if (savedFlag === undefined) delete process.env.RUNTIME_POOLS_ENABLED;
  else process.env.RUNTIME_POOLS_ENABLED = savedFlag;
});
beforeEach(async () => {
  process.env.RUNTIME_POOLS_ENABLED = "true";
  await getDbClient().run("DELETE FROM agents");
  await getDbClient().run("DELETE FROM runtime_pools");
  await getDbClient().run("DELETE FROM runtime_controllers");
  await getDbClient().run("DELETE FROM seed_state WHERE key = 'runtime-pools-default-static'");
  await getDbClient().run("DELETE FROM users");
  userId = crypto.randomUUID();
  await getDbClient().run(
    "INSERT INTO users (id, name, createdAt, lastUpdatedAt) VALUES (?, 'operator-user', ?, ?)",
    [userId, new Date().toISOString(), new Date().toISOString()],
  );
  leadId = (await createAgent({ name: "lead", isLead: true, status: "offline", capabilities: [] }))
    .id;
  workerId = (
    await createAgent({ name: "worker", isLead: false, status: "offline", capabilities: [] })
  ).id;
  await seedRuntimePools({
    RUNTIME_POOLS_ENABLED: "true",
    RUNTIME_DOCKER_HOST: "unix:///tmp/runtime-pools-test.sock",
  });
});
const poolInput = {
  name: "coders",
  kind: "docker",
  placements: ["builtin-docker"],
  image: "agent-swarm-worker:test",
};

describe("runtime pools HTTP", () => {
  test("binding audit uses the target pool and unbinding uses the previous pool", async () => {
    const checks: RbacCheck[] = [];
    setAuditSink((check) => {
      checks.push(check);
    });
    try {
      expect(
        (
          await dispatch(`/api/agents/${workerId}/runtime-pool`, "PUT", {
            poolId: "default-static",
          })
        ).status,
      ).toBe(200);
      expect(checks.at(-1)).toMatchObject({
        verb: "runtime_pool.bind",
        resource: { kind: "runtime_pool", poolId: "default-static" },
      });
      expect(
        (await dispatch(`/api/agents/${workerId}/runtime-pool`, "PUT", { poolId: null })).status,
      ).toBe(200);
      expect(checks.at(-1)).toMatchObject({
        verb: "runtime_pool.bind",
        resource: { kind: "runtime_pool", poolId: "default-static" },
      });
    } finally {
      clearAuditSink();
    }
  });
  test("shared principal treats absent identity as operator and user auth wins over an agent header", async () => {
    expect((await dispatch("/api/runtime-pools", "POST", poolInput, "anonymous")).status).toBe(200);
    expect(
      (
        await dispatch(
          "/api/runtime-controllers/builtin-static",
          "PATCH",
          { config: { REGION: "test" } },
          "user",
          leadId,
        )
      ).status,
    ).toBe(200);
  });
  test("a controller with undecryptable secrets does not break controller reads", async () => {
    await getDbClient().run(
      "UPDATE runtime_controllers SET secret_config = 'invalid-ciphertext' WHERE id = 'builtin-e2b'",
    );
    const read = await dispatch("/api/runtime-controllers/builtin-e2b");
    expect(read.status).toBe(200);
    expect(read.data.controller).toMatchObject({ secretConfigKeys: [], secretConfigError: true });
    const list = await dispatch("/api/runtime-controllers");
    expect(list.status).toBe(200);
    expect(list.data.controllers).toHaveLength(3);
    expect(list.text).not.toContain("invalid-ciphertext");
  });
  test("controller deletion returns 409 while a pool references it", async () => {
    const response = await dispatch("/api/runtime-controllers/builtin-static", "DELETE");
    expect(response.status).toBe(409);
    expect(response.data.error).toBe("Controller has runtime pools");
    expect((await dispatch("/api/runtime-controllers/builtin-static")).status).toBe(200);
  });
  test("pool-agent creation returns 409 for an existing agent name", async () => {
    const response = await dispatch("/api/runtime-pools/default-static/agents", "POST", {
      name: "worker",
    });
    expect(response.status).toBe(409);
    expect(response.data.error).toBe("Agent name already exists");
    expect((await getAgentById(workerId))?.runtimePoolId).toBeNull();
  });
  test("pool CRUD, binding, runtimes and forced deletion", async () => {
    const created = await dispatch("/api/runtime-pools", "POST", poolInput);
    expect(created.status).toBe(200);
    const id = created.data.pool.id;
    expect((await dispatch(`/api/runtime-pools/${id}`)).data.pool.id).toBe(id);
    expect((await dispatch("/api/runtime-pools")).data.pools).toHaveLength(2);
    const updated = await dispatch(`/api/runtime-pools/${id}`, "PATCH", {
      lifecycle: "per-task",
      delivery: "push",
      image: "agent-swarm-worker:slim",
    });
    expect(updated.data.pool).toMatchObject({ lifecycle: "per-task", delivery: "push" });
    expect(
      (await dispatch(`/api/agents/${workerId}/runtime-pool`, "PUT", { poolId: id })).data.agent
        .runtimePoolId,
    ).toBe(id);
    expect((await getAgentById(workerId))?.runtimePoolId).toBe(id);
    await getDbClient().run(
      "INSERT INTO runtime_instances (id, agent_id, pool_id, controller_id, status, external_handle) VALUES (?, ?, ?, 'builtin-docker', 'provisioning', ?)",
      [crypto.randomUUID(), workerId, id, JSON.stringify({ id: "container", kind: "docker" })],
    );
    expect((await dispatch(`/api/runtime-pools/${id}/runtimes`)).data.runtimes[0]).toMatchObject({
      poolId: id,
      status: "provisioning",
      externalHandle: { id: "container", kind: "docker" },
      draining: false,
    });
    expect((await dispatch(`/api/runtime-pools/${id}`, "DELETE")).status).toBe(409);
    const forced = await dispatch(`/api/runtime-pools/${id}?force=true`, "DELETE");
    expect(forced.status).toBe(409);
    expect(forced.data.error).toContain("wait for teardown");
    expect((await getAgentById(workerId))?.runtimePoolId).toBe(id);
    expect(
      (await dispatch(`/api/agents/${workerId}/runtime-pool`, "PUT", { poolId: null })).status,
    ).toBe(409);
    await getDbClient().run("UPDATE runtime_instances SET status = 'offline' WHERE pool_id = ?", [
      id,
    ]);
    expect((await dispatch(`/api/runtime-pools/${id}?force=true`, "DELETE")).data).toEqual({
      deleted: true,
    });
    expect((await getAgentById(workerId))?.runtimePoolId).toBeNull();
    expect((await dispatch(`/api/runtime-pools/${id}`)).status).toBe(404);
  });
  test("pool placement and kind changes return 409 while a runtime is non-offline", async () => {
    const created = await dispatch("/api/runtime-pools", "POST", poolInput);
    const id = created.data.pool.id;
    const other = await dispatch("/api/runtime-controllers", "POST", {
      name: "other-docker",
      kind: "docker",
    });
    await getDbClient().run(
      "INSERT INTO runtime_instances (id, agent_id, pool_id, controller_id, status) VALUES (?, ?, ?, 'builtin-docker', 'active')",
      [crypto.randomUUID(), workerId, id],
    );
    for (const patch of [
      { placements: [other.data.controller.id] },
      { kind: "e2b", placements: ["builtin-e2b"] },
    ]) {
      const response = await dispatch(`/api/runtime-pools/${id}`, "PATCH", patch);
      expect(response.status).toBe(409);
      expect(response.data.error).toContain("wait for teardown");
    }
    expect((await dispatch(`/api/runtime-pools/${id}`)).data.pool.placements).toEqual([
      "builtin-docker",
    ]);
  });
  test("rejects kind mismatches, k8s, invalid bounds, missing placements and missing images", async () => {
    for (const input of [
      { ...poolInput, kind: "e2b" },
      { ...poolInput, kind: "k8s" },
      { ...poolInput, slotsPerRuntime: 0 },
      { ...poolInput, minRuntimes: 2, maxRuntimes: 1 },
      { ...poolInput, placements: [] },
      { ...poolInput, image: null },
      { ...poolInput, image: "  " },
    ]) {
      expect((await dispatch("/api/runtime-pools", "POST", input)).status).toBe(400);
    }
    const k8s = await dispatch("/api/runtime-controllers", "POST", { name: "k8s", kind: "k8s" });
    expect(k8s.status).toBe(400);
    expect(k8s.data.error).toBe("k8s provider not implemented");
  });
  test("pool writes permit operators and users only; leads may only bind", async () => {
    expect((await dispatch("/api/runtime-pools", "POST", poolInput, "worker")).status).toBe(403);
    expect((await dispatch("/api/runtime-pools", "POST", poolInput, "lead")).status).toBe(403);
    const created = await dispatch("/api/runtime-pools", "POST", poolInput, "user");
    expect(created.status).toBe(200);
    const id = created.data.pool.id;
    expect(
      (await dispatch(`/api/runtime-pools/${id}`, "PATCH", { image: "evil:latest" }, "lead"))
        .status,
    ).toBe(403);
    expect((await dispatch(`/api/runtime-pools/${id}`, "DELETE", undefined, "lead")).status).toBe(
      403,
    );
    expect(
      (await dispatch(`/api/runtime-pools/${id}/agents`, "POST", { name: "lead-made" }, "lead"))
        .status,
    ).toBe(200);
    expect(
      (await dispatch(`/api/agents/${workerId}/runtime-pool`, "PUT", { poolId: id }, "lead"))
        .status,
    ).toBe(200);
    expect(
      (await dispatch(`/api/agents/${workerId}/runtime-pool`, "PUT", { poolId: null }, "lead"))
        .status,
    ).toBe(200);
    expect(
      (await dispatch(`/api/runtime-pools/${id}`, "PATCH", { enabled: false }, "user")).status,
    ).toBe(200);
    expect(
      (await dispatch(`/api/agents/${workerId}/runtime-pool`, "PUT", { poolId: id }, "worker"))
        .status,
    ).toBe(403);
    expect((await dispatch(`/api/runtime-pools/${id}`, "DELETE", undefined, "worker")).status).toBe(
      403,
    );
    expect(
      (await dispatch(`/api/runtime-pools/${id}/agents`, "POST", { name: "new-worker" }, "worker"))
        .status,
    ).toBe(403);
    expect(
      (await dispatch(`/api/runtime-pools/${id}?force=true`, "DELETE", undefined, "operator"))
        .status,
    ).toBe(200);
  });
  test("controller CRUD permits users and operators, denies leads, and hides secrets", async () => {
    const secret = crypto.randomUUID() + crypto.randomUUID();
    const input = { name: "remote-e2b", kind: "e2b", secretConfig: { E2B_API_KEY: secret } };
    expect((await dispatch("/api/runtime-controllers", "POST", input, "lead")).status).toBe(403);
    const created = await dispatch("/api/runtime-controllers", "POST", input, "user");
    expect(created.status).toBe(200);
    const id = created.data.controller.id;
    expect(created.data.controller.secretConfigKeys).toEqual(["E2B_API_KEY"]);
    expect(created.data.controller.createdBy).toBe(userId);
    expect(created.text).not.toContain(secret);
    expect(created.data.controller.secretConfig).toBeUndefined();
    expect(
      (
        await dispatch(
          `/api/runtime-controllers/${id}`,
          "PATCH",
          { config: { REGION: "test" } },
          "lead",
        )
      ).status,
    ).toBe(403);
    expect(
      (await dispatch(`/api/runtime-controllers/${id}`, "DELETE", undefined, "lead")).status,
    ).toBe(403);
    const patched = await dispatch(`/api/runtime-controllers/${id}`, "PATCH", {
      config: { REGION: "test" },
    });
    expect(patched.status).toBe(200);
    for (const response of [
      patched,
      await dispatch(`/api/runtime-controllers/${id}`),
      await dispatch("/api/runtime-controllers"),
    ])
      expect(response.text).not.toContain(secret);
    expect(scrubSecrets(`log ${secret}`)).not.toContain(secret);
    const cleared = await dispatch(`/api/runtime-controllers/${id}`, "PATCH", {
      secretConfig: { E2B_API_KEY: null },
    });
    expect(cleared.data.controller.secretConfigKeys).toEqual([]);
    expect((await dispatch(`/api/runtime-controllers/${id}`, "DELETE")).status).toBe(200);
  });
  test("creates an offline bound agent and refuses a second lead", async () => {
    const created = await dispatch("/api/runtime-pools/default-static/agents", "POST", {
      name: "new-worker",
      harnessProvider: "codex",
      templateId: "official/coder",
    });
    expect(created.status).toBe(200);
    expect(created.data.agent).toMatchObject({
      status: "offline",
      runtimePoolId: "default-static",
      harnessProvider: "codex",
    });
    expect(
      (
        await dispatch("/api/runtime-pools/default-static/agents", "POST", {
          name: "second-lead",
          isLead: true,
        })
      ).status,
    ).toBe(409);
  });
  test("status exposes the runtime pools flag", async () => {
    expect((await buildStatusPayload()).runtime_pools).toMatchObject({ enabled: true });
    process.env.RUNTIME_POOLS_ENABLED = "false";
    expect((await buildStatusPayload()).runtime_pools).toEqual({
      enabled: false,
      supervisor: "disabled",
    });
  });
  test("flag off returns the disabled 404 on every route", async () => {
    process.env.RUNTIME_POOLS_ENABLED = "false";
    for (const [url, method, body] of [
      ["/api/runtime-pools", "GET"],
      ["/api/runtime-pools", "POST", poolInput],
      ["/api/runtime-pools/default-static", "GET"],
      ["/api/runtime-pools/default-static", "PATCH", {}],
      ["/api/runtime-pools/default-static", "DELETE"],
      ["/api/runtime-pools/default-static/runtimes", "GET"],
      ["/api/runtime-pools/default-static/agents", "POST", { name: "x" }],
      ["/api/runtime-controllers", "GET"],
      ["/api/runtime-controllers", "POST", {}],
      ["/api/runtime-controllers/builtin-static", "GET"],
      ["/api/runtime-controllers/builtin-static", "PATCH", {}],
      ["/api/runtime-controllers/builtin-static", "DELETE"],
      [`/api/agents/${workerId}/runtime-pool`, "PUT", { poolId: null }],
    ] as const) {
      const response = await dispatch(url, method, body);
      expect(response.status).toBe(404);
      expect(response.data).toEqual({ error: "runtime pools are disabled" });
    }
  });
});

test("MCP proxies enforce REST permissions and compose both result channels", async () => {
  const server = new McpServer({ name: "runtime-pools-test", version: "1" });
  for (const register of [
    registerRuntimePoolListTool,
    registerRuntimePoolUpsertTool,
    registerRuntimePoolDeleteTool,
    registerRuntimePoolBindAgentTool,
    registerRuntimePoolCreateAgentTool,
    registerRuntimeControllerListTool,
  ])
    register(server);
  type Result = {
    content: { text: string }[];
    structuredContent: Record<string, unknown>;
    isError?: boolean;
  };
  const tools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<Result> }
      >;
    }
  )._registeredTools;
  // Sentinel header value the fake fetch maps to an operator (no agent) caller.
  const operatorAgentId = "operator-sentinel";
  const call = (name: string, args: unknown, agentId = leadId) =>
    tools[name]!.handler(args, { requestInfo: { headers: { "x-agent-id": agentId } } });
  const savedFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (input, init) => {
    fetchCalls++;
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(headers.get("x-agent-id")).toBeTruthy();
    const response = await dispatch(
      url.pathname + url.search,
      init?.method,
      init?.body ? JSON.parse(String(init.body)) : undefined,
      headers.get("x-agent-id") === leadId
        ? "lead"
        : headers.get("x-agent-id") === operatorAgentId
          ? "operator"
          : "worker",
    );
    return new Response(response.text, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    for (const args of [{}, { name: "incomplete" }, { name: "incomplete", kind: "docker" }]) {
      const missing = await call("runtime-pool-upsert", args);
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent.success).toBe(false);
      expect(missing.content[0]?.text).toContain(
        "requires name, kind, and one controller placement",
      );
    }
    expect(fetchCalls).toBe(0);
    const leadCreate = await call("runtime-pool-upsert", poolInput);
    expect(leadCreate.isError).toBe(true);
    expect(leadCreate.content[0]?.text).toContain("requires operator or user");
    const created = await call("runtime-pool-upsert", poolInput, operatorAgentId);
    expect(created.isError).toBe(false);
    const pool = created.structuredContent.pool as { id: string };
    expect(created.content.map((item) => item.text).join(" ")).toContain(pool.id);
    const list = await call("runtime-pool-list", {});
    expect(list.structuredContent.pools).toContainEqual(expect.objectContaining({ id: pool.id }));
    expect(list.content.map((item) => item.text).join(" ")).toContain(pool.id);
    const updated = await call(
      "runtime-pool-upsert",
      { id: pool.id, delivery: "push" },
      operatorAgentId,
    );
    expect(updated.structuredContent.pool).toMatchObject({ delivery: "push" });
    expect(
      (await call("runtime-pool-bind-agent", { agentId: workerId, poolId: pool.id }))
        .structuredContent.agent,
    ).toMatchObject({ runtimePoolId: pool.id });
    expect(
      (await call("runtime-pool-create-agent", { poolId: pool.id, name: "tool-worker" }))
        .structuredContent.agent,
    ).toMatchObject({ status: "offline", runtimePoolId: pool.id });
    expect((await call("runtime-controller-list", {})).structuredContent.controllers).toHaveLength(
      3,
    );
    const denied = await call("runtime-pool-upsert", { id: pool.id, enabled: false }, workerId);
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.success).toBe(false);
    expect(denied.content[0]?.text).toContain("requires");
    expect(
      (await call("runtime-pool-delete", { poolId: pool.id, force: true }, operatorAgentId))
        .structuredContent.deleted,
    ).toBe(true);
    process.env.RUNTIME_POOLS_ENABLED = "false";
    const disabled = await call("runtime-pool-list", {});
    expect(disabled.isError).toBe(true);
    expect(disabled.structuredContent.message).toBe("runtime pools are disabled");
    expect(disabled.content[0]?.text).toContain("runtime pools are disabled");
  } finally {
    globalThis.fetch = savedFetch;
    await server.close();
  }
});
