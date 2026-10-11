import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import WebSocket from "ws";
import {
  closeDb,
  createAgent,
  createSwarmRepo,
  createTaskExtended,
  getAgentById,
  getDbClient,
  getTaskById,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import {
  mintRuntimeToken,
  mintSessionToken,
  resolveBySessionToken,
  revokeRuntimeTokensForRuntime,
  revokeSessionToken,
} from "../be/users";
import { handleAgentRegister, handleAgentsRest } from "../http/agents";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { handleKv } from "../http/kv";
import { handleMcp } from "../http/mcp";
import { handleMcpServers } from "../http/mcp-servers";
import { handlePoll } from "../http/poll";
import { handleSessions } from "../http/sessions";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { attachRealtimeTransport } from "../realtime/transport";
import { registerSessionTokenConnection } from "../utils/session-token-connections";
import { listenOnFreePort } from "./test-net";

const key = "runtime-token-auth-test-key";
const agentId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const runtimeId = crypto.randomUUID();
let server: Server;
let baseUrl: string;
let detach: () => void;
let token: { tokenId: string; plaintext: string };
let ownTaskId: string;
let otherTaskId: string;
const oldKey = process.env.AGENT_SWARM_API_KEY;

async function request(
  path: string,
  bearer = token.plaintext,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

beforeAll(async () => {
  initDb(":memory:");
  process.env.AGENT_SWARM_API_KEY = key;
  await createAgent({ id: agentId, name: "Runtime worker", isLead: false, status: "idle" });
  await createAgent({ id: otherId, name: "Other worker", isLead: false, status: "idle" });
  ownTaskId = (await createTaskExtended("Runtime task", { agentId, source: "system" })).id;
  otherTaskId = (await createTaskExtended("Other task", { agentId: otherId, source: "system" })).id;
  token = await mintRuntimeToken(agentId, runtimeId, 60_000);
});

async function dispatch(req: IncomingMessage, res: ServerResponse) {
  if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, key)) return;
  const segments = getPathSegments(req.url ?? "");
  const query = parseQueryParams(req.url ?? "");
  const id = req.headers["x-agent-id"] as string | undefined;
  if (await handleAgentRegister(req, res, segments, id)) return;
  if (await handleAgentsRest(req, res, segments, query, id)) return;
  if (await handlePoll(req, res, segments, query, id)) return;
  if (await handleTasks(req, res, segments, query, id)) return;
  if (await handleSessions(req, res, segments, query)) return;
  if (await handleConfig(req, res, segments, query)) return;
  if (await handleKv(req, res, segments, query)) return;
  if (await handleMcpServers(req, res, segments, query, id)) return;
  if (await handleMcp(req, res, {})) return;
  res.writeHead(404).end();
}

async function startServer() {
  server = createServer((req, res) => {
    void dispatch(req, res).catch(() => res.writeHead(500).end());
  });
  const port = await listenOnFreePort(server);
  baseUrl = `http://127.0.0.1:${port}`;
  detach = attachRealtimeTransport(server);
}

afterAll(async () => {
  detach?.();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  if (oldKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
  else process.env.AGENT_SWARM_API_KEY = oldKey;
});

// Exercise handlers without a listener. Network tests below cover the wire path.
async function directRequest(
  path: string,
  bearer = token.plaintext,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers = Object.fromEntries(
    Object.entries({
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      ...options.headers,
    }).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const req = Object.assign(
    Readable.from(options.body === undefined ? [] : [JSON.stringify(options.body)]),
    {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      url: path,
      headers,
    },
  ) as IncomingMessage;
  let status = 200;
  let output = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(data = "") {
      output = data;
      return res;
    },
    setHeader() {
      return res;
    },
  } as unknown as ServerResponse;
  await dispatch(req, res);
  return { status, body: output ? JSON.parse(output) : null };
}

test("central handler binding rejects spoofed identities and supplies missing headers", async () => {
  for (const [path, method] of [
    ["/api/poll", "GET"],
    ["/ping", "POST"],
    [`/api/tasks/${ownTaskId}/progress`, "POST"],
    ["/mcp", "POST"],
  ]) {
    expect(
      (await directRequest(path!, token.plaintext, { method, headers: { "X-Agent-ID": otherId } }))
        .status,
    ).toBe(403);
  }
  expect((await directRequest("/me")).body.id).toBe(agentId);
  expect((await directRequest("/ping", token.plaintext, { method: "POST" })).status).toBe(204);
  expect(
    (
      await directRequest("/api/poll", token.plaintext, {
        headers: { "X-Runtime-Instance-ID": "wrong" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await directRequest(`/api/agents/${otherId}/profile`, token.plaintext, {
        method: "PUT",
        body: {},
      })
    ).status,
  ).toBe(403);
  expect(
    (await directRequest(`/api/agents/${otherId}/mcp-servers?resolveSecrets=true`)).status,
  ).toBe(403);
  expect(
    (
      await directRequest("/api/agents", token.plaintext, {
        body: { name: "Runtime", isLead: true, runtimeInstanceId: runtimeId },
      })
    ).status,
  ).toBe(200);
  expect((await getAgentById(agentId))?.isLead).toBe(false);
  const newAgentId = crypto.randomUUID();
  const newRuntimeId = crypto.randomUUID();
  const newToken = await mintRuntimeToken(newAgentId, newRuntimeId, 60_000);
  expect(
    (
      await directRequest("/api/agents", newToken.plaintext, {
        body: { name: "New runtime", isLead: true, runtimeInstanceId: newRuntimeId },
      })
    ).status,
  ).toBe(201);
  expect((await getAgentById(newAgentId))?.isLead).toBe(false);
});

test("handlers enforce self secrets and child token lifetime and ownership", async () => {
  const secret = "runtime-handler-secret-123456";
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agentId,
    key: "DIRECT_TEST_SECRET",
    value: secret,
    isSecret: true,
  });
  expect(
    JSON.stringify((await directRequest("/api/config/resolved?includeSecrets=true")).body),
  ).toContain(secret);
  const taskToken = await mintSessionToken(agentId, ownTaskId, 60_000);
  expect(
    JSON.stringify(
      (await directRequest("/api/config/resolved?includeSecrets=true", taskToken.plaintext)).body,
    ),
  ).not.toContain(secret);
  const child = await directRequest("/api/sessions/tokens", token.plaintext, {
    body: { agentId, taskId: ownTaskId, ttlMs: 120_000 },
  });
  expect(child.status).toBe(200);
  expect((await resolveBySessionToken(child.body.plaintext))!.expiresAt).toBe(
    (await resolveBySessionToken(token.plaintext))!.expiresAt,
  );
  expect(
    (
      await directRequest("/api/sessions/tokens", token.plaintext, {
        body: { agentId, taskId: otherTaskId, ttlMs: 60_000 },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await directRequest("/api/sessions/tokens", token.plaintext, {
        body: { agentId, runtimeId, ttlMs: 60_000 },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await directRequest("/api/sessions/tokens", taskToken.plaintext, {
        body: { agentId, taskId: ownTaskId, ttlMs: 60_000 },
      })
    ).status,
  ).toBe(401);
  const revokedRuntimeId = crypto.randomUUID();
  const parent = await directRequest("/api/sessions/tokens", key, {
    body: { agentId, runtimeId: revokedRuntimeId, ttlMs: 60_000 },
  });
  expect(parent.status).toBe(200);
  const minted = await directRequest("/api/sessions/tokens", parent.body.plaintext, {
    body: { agentId, taskId: ownTaskId, ttlMs: 60_000 },
  });
  expect(minted.status).toBe(200);
  expect(
    (await directRequest(`/api/sessions/tokens/${parent.body.tokenId}`, key, { method: "DELETE" }))
      .status,
  ).toBe(204);
  expect((await directRequest("/ping", parent.body.plaintext, { method: "POST" })).status).toBe(
    401,
  );
  expect((await directRequest("/ping", minted.body.plaintext, { method: "POST" })).status).toBe(
    401,
  );
});

test("runtime token lifecycle preserves binding and revokes child tokens", async () => {
  const id = crypto.randomUUID();
  const parent = await mintRuntimeToken(agentId, id, 60_000);
  const principal = (await resolveBySessionToken(parent.plaintext))!;
  expect(principal).toMatchObject({ agentId, taskId: null, runtimeId: id });
  const child = await mintSessionToken(agentId, ownTaskId, 120_000, {
    runtimeId: id,
    tokenId: parent.tokenId,
  });
  expect(Date.parse((await resolveBySessionToken(child.plaintext))!.expiresAt)).toBeLessThanOrEqual(
    Date.parse(principal.expiresAt),
  );
  await revokeRuntimeTokensForRuntime(id);
  expect(await resolveBySessionToken(parent.plaintext)).toBeNull();
  expect(await resolveBySessionToken(child.plaintext)).toBeNull();
  await expect(
    mintSessionToken(agentId, ownTaskId, 60_000, { runtimeId: id, tokenId: parent.tokenId }),
  ).rejects.toThrow("Runtime token is no longer valid");
  const expired = await mintRuntimeToken(agentId, crypto.randomUUID(), -1);
  expect(await resolveBySessionToken(expired.plaintext)).toBeNull();
});

test("runtime revocation closes registered connections only after commit", async () => {
  const id = crypto.randomUUID();
  const parent = await mintRuntimeToken(agentId, id, 60_000);
  let closed = 0;
  const unregister = registerSessionTokenConnection(parent.tokenId, () => {
    closed++;
  });
  try {
    await expect(
      getDbClient().transaction(async () => {
        await revokeRuntimeTokensForRuntime(id);
        expect(closed).toBe(0);
        throw new Error("Rollback");
      }),
    ).rejects.toThrow("Rollback");
    expect(closed).toBe(0);
    expect(await resolveBySessionToken(parent.plaintext)).not.toBeNull();
    await getDbClient().transaction(async () => {
      await revokeSessionToken(parent.tokenId);
      expect(closed).toBe(0);
    });
    expect(closed).toBe(1);
  } finally {
    unregister();
  }
});

describe("runtime token HTTP and realtime auth", () => {
  beforeAll(startServer);

  test("agent tokens reject repeated guarded query keys before handlers resolve scopes", async () => {
    const acp = await mintSessionToken(agentId, ownTaskId, 60_000);
    for (const bearer of [token.plaintext, acp.plaintext]) {
      for (const path of [
        `/api/config/resolved?agentId=${agentId}&agentId=${otherId}&includeSecrets=true`,
        "/api/config/resolved?repoId=self&repoId=other&includeSecrets=true",
        "/api/config/resolved?includeSecrets=false&includeSecrets=true",
        `/api/agents/${otherId}/mcp-servers?resolveSecrets=false&resolveSecrets=true`,
      ]) {
        expect((await request(path, bearer)).status).toBe(400);
      }
    }
    expect(
      (await request("/api/config/resolved?includeSecrets=false&includeSecrets=true", key)).status,
    ).toBe(200);
  });

  test("rewriting an owned task's VCS cannot reveal repo secrets", async () => {
    const ownRepo = await createSwarmRepo({
      name: "review-own",
      url: "https://github.com/review/own.git",
    });
    const otherRepo = await createSwarmRepo({
      name: "secret-repo",
      url: "https://github.com/victim/secret-repo.git",
    });
    const task = await createTaskExtended("Repo scope task", {
      agentId,
      vcsRepo: "review/own",
      source: "system",
    });
    for (const [repo, value] of [
      [ownRepo, "own-repo-secret"],
      [otherRepo, "other-repo-secret"],
    ] as const) {
      await upsertSwarmConfig({
        scope: "repo",
        scopeId: repo.id,
        key: "REVIEW_REPO_SECRET",
        value,
        isSecret: true,
      });
    }
    for (const scope of ["global", "agent"] as const) {
      await upsertSwarmConfig({
        scope,
        scopeId: scope === "agent" ? agentId : undefined,
        key: `REVIEW_${scope.toUpperCase()}_SECRET`,
        value: `${scope}-allowed-secret`,
        isSecret: true,
      });
      // An omitted repo secret must not suppress an allowed value with the same key.
      await upsertSwarmConfig({
        scope: "repo",
        scopeId: otherRepo.id,
        key: `REVIEW_${scope.toUpperCase()}_SECRET`,
        value: `victim-${scope}-secret`,
        isSecret: true,
      });
    }
    await upsertSwarmConfig({
      scope: "repo",
      scopeId: otherRepo.id,
      key: "REVIEW_REPO_PUBLIC",
      value: "repo-public-value",
      isSecret: false,
    });
    const read = async (repoId: string, taskId?: string) => {
      const response = await request(
        `/api/config/resolved?agentId=${agentId}&repoId=${repoId}&includeSecrets=true`,
        token.plaintext,
        {
          headers: taskId ? { "X-Source-Task-Id": taskId } : {},
        },
      );
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        configs: Array<{ key: string; value: string; scope: string }>;
      };
      expect(data.configs.find((config) => config.key === "REVIEW_GLOBAL_SECRET")?.value).toBe(
        "global-allowed-secret",
      );
      expect(data.configs.find((config) => config.key === "REVIEW_AGENT_SECRET")?.value).toBe(
        "agent-allowed-secret",
      );
      expect(data.configs.some((config) => config.key === "REVIEW_REPO_SECRET")).toBe(false);
      if (repoId === otherRepo.id) {
        expect(data.configs.find((config) => config.key === "REVIEW_REPO_PUBLIC")?.value).toBe(
          "repo-public-value",
        );
      }
      return JSON.stringify(data);
    };
    expect(await read(ownRepo.id, task.id)).not.toContain("own-repo-secret");
    expect(await read(ownRepo.id)).not.toContain("own-repo-secret");
    expect(await read(otherRepo.id, task.id)).not.toContain("other-repo-secret");
    expect(await read(ownRepo.id, ownTaskId)).not.toContain("own-repo-secret");
    for (const vcsRepo of ["victim/secret-repo", "secret-repo"]) {
      const rewritten = await request(`/api/tasks/${task.id}/vcs`, token.plaintext, {
        method: "PATCH",
        body: {
          vcsProvider: "github",
          vcsRepo,
          vcsNumber: 1,
          vcsUrl: "https://github.com/victim/secret-repo/pull/1",
        },
      });
      expect(rewritten.status).toBe(200);
      expect((await getTaskById(task.id))?.vcsRepo).toBe(vcsRepo);
      const response = await read(otherRepo.id, task.id);
      expect(response).not.toContain("other-repo-secret");
      expect(response).not.toContain("victim-global-secret");
      expect(response).not.toContain("victim-agent-secret");
    }
    await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [task.id]);
    expect(await read(otherRepo.id, task.id)).not.toContain("other-repo-secret");
    const defaultScope = await request(
      `/api/config/resolved?repoId=${otherRepo.id}&includeSecrets=true`,
    );
    expect(await defaultScope.text()).toContain("agent-allowed-secret");
    const maskedRead = await request(
      `/api/config/resolved?agentId=${agentId}&repoId=${otherRepo.id}&includeSecrets=false`,
    );
    const maskedData = await maskedRead.json();
    expect(
      maskedData.configs.some(
        (config: { scope: string; isSecret: boolean }) =>
          config.scope === "repo" && config.isSecret,
      ),
    ).toBe(false);
    expect(JSON.stringify(maskedData)).not.toContain("agent-allowed-secret");
    const leadId = crypto.randomUUID();
    await createAgent({ id: leadId, name: "Repo secret lead", isLead: true, status: "idle" });
    const lead = await mintRuntimeToken(leadId, crypto.randomUUID(), 60_000);
    for (const bearer of [key, lead.plaintext]) {
      const allowedRead = await request(
        `/api/config/resolved?repoId=${otherRepo.id}&includeSecrets=true`,
        bearer,
      );
      expect(allowedRead.status).toBe(200);
      expect(await allowedRead.text()).toContain("other-repo-secret");
    }
  });

  test("agent tokens can update VCS only for their assigned task, while swarm-key behavior remains", async () => {
    const own = await createTaskExtended("VCS owner task", { agentId, source: "system" });
    const other = await createTaskExtended("VCS other task", {
      agentId: otherId,
      source: "system",
    });
    const unassigned = await createTaskExtended("VCS unassigned task", { source: "system" });
    const acp = await mintSessionToken(agentId, own.id, 60_000);
    const body = {
      vcsProvider: "github",
      vcsRepo: "review/owner",
      vcsNumber: 2,
      vcsUrl: "https://github.com/review/owner/pull/2",
    };
    for (const bearer of [token.plaintext, acp.plaintext]) {
      expect(
        (await request(`/api/tasks/${own.id}/vcs`, bearer, { method: "PATCH", body })).status,
      ).toBe(200);
      for (const task of [other, unassigned]) {
        const before = await getTaskById(task.id);
        expect(
          (await request(`/api/tasks/${task.id}/vcs`, bearer, { method: "PATCH", body })).status,
        ).toBe(403);
        expect(await getTaskById(task.id)).toEqual(before);
      }
    }
    expect(
      (
        await request(`/api/tasks/${other.id}/vcs`, key, {
          method: "PATCH",
          body,
          headers: { "X-Agent-ID": agentId },
        })
      ).status,
    ).toBe(200);
    expect((await getTaskById(other.id))?.vcsRepo).toBe(body.vcsRepo);
  });

  test("runtime child tokens require pending or in-progress tasks", async () => {
    const task = await createTaskExtended("Child token status task", { agentId, source: "system" });
    for (const status of [
      "pending",
      "in_progress",
      "completed",
      "failed",
      "cancelled",
      "paused",
      "draft",
      "unassigned",
    ]) {
      await getDbClient().run("UPDATE agent_tasks SET status = ? WHERE id = ?", [status, task.id]);
      const before = await getDbClient().get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_tokens",
      );
      const response = await request("/api/sessions/tokens", token.plaintext, {
        body: { agentId, taskId: task.id, ttlMs: 60_000 },
      });
      const live = status === "pending" || status === "in_progress";
      expect(response.status).toBe(live ? 200 : 403);
      const after = await getDbClient().get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_tokens",
      );
      expect(after!.count).toBe(before!.count + (live ? 1 : 0));
    }
  });

  test("runtime task headers bind KV and MCP context, and agent tokens cannot impersonate pages", async () => {
    for (const taskId of [otherTaskId, crypto.randomUUID()]) {
      for (const path of ["/api/kv/review-binding", "/api/poll", "/mcp"]) {
        expect(
          (await request(path, token.plaintext, { headers: { "X-Source-Task-Id": taskId } }))
            .status,
        ).toBe(403);
      }
    }
    const write = await request("/api/kv/review-binding", token.plaintext, {
      method: "PUT",
      body: { value: "own-task-value" },
      headers: { "X-Source-Task-Id": ownTaskId },
    });
    expect(write.status).toBe(200);
    const read = await request("/api/kv/review-binding", token.plaintext, {
      headers: { "X-Source-Task-Id": ownTaskId },
    });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("own-task-value");
    const acp = await mintSessionToken(agentId, ownTaskId, 60_000);
    for (const bearer of [token.plaintext, acp.plaintext]) {
      for (const method of ["GET", "PUT"]) {
        expect(
          (
            await request("/api/kv/review-binding", bearer, {
              method,
              headers: { "X-Page-Id": crypto.randomUUID() },
              body: method === "PUT" ? { value: "spoofed" } : undefined,
            })
          ).status,
        ).toBe(403);
      }
    }
  });

  test("lead-equivalent tokens retain cross-agent access and legacy secret permissions", async () => {
    const leadId = crypto.randomUUID();
    await createAgent({ id: leadId, name: "Review lead", isLead: true, status: "idle" });
    const lead = await mintRuntimeToken(leadId, crypto.randomUUID(), 60_000);
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: otherId,
      key: "REVIEW_LEAD_SECRET",
      value: "lead-readable-secret",
      isSecret: true,
    });
    for (const bearer of [key, lead.plaintext]) {
      for (const path of [
        "/api/config?includeSecrets=true",
        `/api/config/resolved?agentId=${otherId}&includeSecrets=true`,
      ]) {
        const response = await request(path, bearer);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("lead-readable-secret");
      }
    }
    for (const bearer of [token.plaintext, lead.plaintext]) {
      const expected = bearer === token.plaintext ? 403 : 200;
      expect(
        (await request(`/api/agents/${otherId}/mcp-servers?resolveSecrets=true`, bearer)).status,
      ).toBe(expected);
      expect(
        (
          await request(`/api/agents/${otherId}/profile`, bearer, {
            method: "PUT",
            body: { role: "review-worker" },
          })
        ).status,
      ).toBe(expected);
    }
  });

  test("realtime expiry uses an agent-token message and keepalive does not touch lastUsedAt", async () => {
    const valid = await mintRuntimeToken(agentId, crypto.randomUUID(), 60_000);
    const expired = await mintRuntimeToken(agentId, crypto.randomUUID(), 500);
    const sockets: WebSocket[] = [];
    const open = async (bearer: string) => {
      const ws = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/realtime`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once("message", () => resolve());
        ws.on("error", reject);
      });
      return ws;
    };
    try {
      await open(valid.plaintext);
      const before = await getDbClient().get("SELECT lastUsedAt FROM session_tokens WHERE id = ?", [
        valid.tokenId,
      ]);
      const expiring = await open(expired.plaintext);
      const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
        expiring.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      expect(closed).toEqual({ code: 1008, reason: "Session token expired" });
      expect(
        await getDbClient().get("SELECT lastUsedAt FROM session_tokens WHERE id = ?", [
          valid.tokenId,
        ]),
      ).toEqual(before);
    } finally {
      for (const ws of sockets) ws.terminate();
    }
  }, 25_000);

  test("runtime and ACP tokens initialize MCP with the token agent", async () => {
    const acp = await mintSessionToken(agentId, ownTaskId, 60_000);
    for (const bearer of [token.plaintext, acp.plaintext]) {
      const response = await request("/mcp", bearer, {
        headers: { Accept: "application/json, text/event-stream", "X-Source-Task-Id": ownTaskId },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: "runtime-token-test", version: "1" },
            capabilities: {},
          },
        },
      });
      expect(response.status).toBe(200);
      await response.text();
    }
  });
  test("operator mints a runtime token with the configured default TTL", async () => {
    const previous = process.env.RUNTIME_TOKEN_TTL_HOURS;
    process.env.RUNTIME_TOKEN_TTL_HOURS = "2";
    try {
      const response = await request("/api/sessions/tokens", key, { body: { agentId, runtimeId } });
      expect(response.status).toBe(200);
      const minted = (await response.json()) as typeof token;
      const principal = await resolveBySessionToken(minted.plaintext);
      expect(principal).toMatchObject({ agentId, runtimeId, taskId: null });
      expect(Date.parse(principal!.expiresAt) - Date.now()).toBeGreaterThan(7_190_000);
      await revokeSessionToken(minted.tokenId);
      expect(await resolveBySessionToken(minted.plaintext)).toBeNull();
      // The runtime revoke also fences the original token for this runtime.
      token = await mintRuntimeToken(agentId, runtimeId, 60_000);
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_TOKEN_TTL_HOURS;
      else process.env.RUNTIME_TOKEN_TTL_HOURS = previous;
    }
  });

  test.each([
    ["/api/poll", "GET"],
    ["/ping", "POST"],
    ["/api/tasks/task-id/progress", "POST"],
    ["/mcp", "POST"],
  ])("rejects a mismatched agent header on %s", async (path, method) => {
    const response = await request(path, token.plaintext, {
      method,
      headers: { "X-Agent-ID": otherId },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "X-Agent-ID does not match token" });
  });

  test("missing headers resolve to the token identity on core and downstream routes", async () => {
    const me = await request("/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { id: string }).id).toBe(agentId);
    expect((await request("/ping", token.plaintext, { method: "POST" })).status).toBe(204);
    expect((await request("/api/poll")).status).toBe(200);
    expect(
      (
        await request(`/api/tasks/${ownTaskId}/progress`, token.plaintext, {
          body: { progress: "Runtime progress" },
        })
      ).status,
    ).toBe(200);
  });

  test("rejects a mismatched runtime header", async () => {
    expect(
      (
        await request("/api/poll", token.plaintext, {
          headers: { "X-Runtime-Instance-ID": crypto.randomUUID() },
        })
      ).status,
    ).toBe(403);
  });

  test("revoked and expired tokens return 401", async () => {
    const revoked = await mintRuntimeToken(agentId, crypto.randomUUID(), 60_000);
    await revokeRuntimeTokensForRuntime(
      (await resolveBySessionToken(revoked.plaintext))!.runtimeId!,
    );
    const expired = await mintRuntimeToken(agentId, crypto.randomUUID(), -1);
    for (const bearer of [revoked.plaintext, expired.plaintext]) {
      expect((await request("/ping", bearer, { method: "POST" })).status).toBe(401);
      expect(
        (
          await request(`/api/tasks/${ownTaskId}/progress`, bearer, {
            body: { progress: "revoked" },
          })
        ).status,
      ).toBe(401);
    }
  });

  test("runtime secret reads reveal only the resolved own scope", async () => {
    const secret = "runtime-self-secret-123456";
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: agentId,
      key: "RUNTIME_TEST_SECRET",
      value: secret,
      isSecret: true,
    });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: otherId,
      key: "OTHER_TEST_SECRET",
      value: "other-secret-123456",
      isSecret: true,
    });
    const read = async (path: string, bearer = token.plaintext) => {
      const response = await request(path, bearer);
      expect(response.status).toBe(200);
      return JSON.stringify(await response.json());
    };
    expect(await read("/api/config/resolved?includeSecrets=true")).toContain(secret);
    expect(await read(`/api/config/resolved?agentId=${agentId}&includeSecrets=true`)).toContain(
      secret,
    );
    expect(await read(`/api/config/resolved?agentId=${otherId}&includeSecrets=true`)).not.toContain(
      "other-secret-123456",
    );
    expect(await read("/api/config?includeSecrets=true")).not.toContain(secret);
    const acp = await mintSessionToken(agentId, ownTaskId, 60_000);
    expect(
      await read(`/api/config/resolved?agentId=${agentId}&includeSecrets=true`, acp.plaintext),
    ).not.toContain(secret);
  });

  test("runtime can mint only its own task tokens, capped at its expiry and revoked with it", async () => {
    const parentRuntime = crypto.randomUUID();
    const parent = await mintRuntimeToken(agentId, parentRuntime, 60_000);
    for (const body of [
      { agentId: otherId, taskId: otherTaskId, ttlMs: 60_000 },
      { agentId, taskId: otherTaskId, ttlMs: 60_000 },
      { agentId, taskId: crypto.randomUUID(), ttlMs: 60_000 },
      { agentId, runtimeId: crypto.randomUUID(), ttlMs: 60_000 },
    ]) {
      expect((await request("/api/sessions/tokens", parent.plaintext, { body })).status).toBe(403);
    }
    const minted = await request("/api/sessions/tokens", parent.plaintext, {
      body: { agentId, taskId: ownTaskId, ttlMs: 120_000 },
    });
    expect(minted.status).toBe(200);
    const child = (await minted.json()) as typeof token;
    const parentPrincipal = await resolveBySessionToken(parent.plaintext);
    const childPrincipal = await resolveBySessionToken(child.plaintext);
    expect(childPrincipal).toMatchObject({ agentId, taskId: ownTaskId, runtimeId: null });
    expect(Date.parse(childPrincipal!.expiresAt)).toBeLessThanOrEqual(
      Date.parse(parentPrincipal!.expiresAt),
    );
    expect(
      await getDbClient().get("SELECT parentRuntimeId FROM session_tokens WHERE id = ?", [
        child.tokenId,
      ]),
    ).toEqual({ parentRuntimeId: parentRuntime });
    expect(
      (
        await request("/api/sessions/tokens", child.plaintext, {
          body: { agentId, taskId: ownTaskId, ttlMs: 60_000 },
        })
      ).status,
    ).toBe(401);
    expect(
      (await request(`/api/sessions/tokens/${parent.tokenId}`, key, { method: "DELETE" })).status,
    ).toBe(204);
    expect(await resolveBySessionToken(child.plaintext)).toBeNull();
    expect((await request("/ping", child.plaintext, { method: "POST" })).status).toBe(401);
  });

  test("registration cannot promote an agent or register another runtime", async () => {
    expect(
      (
        await request("/api/agents", token.plaintext, {
          body: { name: "Runtime worker", isLead: true, runtimeInstanceId: runtimeId },
        })
      ).status,
    ).toBe(200);
    expect((await getAgentById(agentId))?.isLead).toBe(false);
    expect(
      (
        await request("/api/agents", token.plaintext, {
          body: { name: "Runtime worker", runtimeInstanceId: crypto.randomUUID() },
        })
      ).status,
    ).toBe(403);
  });

  test("non-lead token cannot modify or resolve another agent's scope", async () => {
    expect(
      (
        await request(`/api/agents/${otherId}/profile`, token.plaintext, {
          method: "PUT",
          body: { role: "lead" },
        })
      ).status,
    ).toBe(403);
    expect((await request(`/api/agents/${otherId}/mcp-servers?resolveSecrets=true`)).status).toBe(
      403,
    );
    expect(
      (await request(`/api/agents/${otherId}/mcp-servers?resolveSecrets=true`, key)).status,
    ).toBe(200);
  });

  test("realtime rejects mismatched identities and closes runtime and child sockets on revoke", async () => {
    const url = `${baseUrl.replace("http:", "ws:")}/api/realtime`;
    const rejected = await request("/api/realtime", token.plaintext, {
      headers: {
        "X-Agent-ID": otherId,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", // gitleaks:allow (RFC 6455 sample nonce)
      },
    });
    expect(rejected.status).toBe(401);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token.plaintext}`, "X-Agent-ID": otherId },
      });
      ws.once("open", () => {
        ws.close();
        reject(new Error("Spoofed socket opened"));
      });
      ws.on("error", () => resolve());
    });
    const parentRuntime = crypto.randomUUID();
    const parent = await mintRuntimeToken(agentId, parentRuntime, 60_000);
    const child = await mintSessionToken(agentId, ownTaskId, 60_000, {
      runtimeId: parentRuntime,
      tokenId: parent.tokenId,
    });
    const sockets: WebSocket[] = [];
    try {
      for (const bearer of [parent.plaintext, child.plaintext]) {
        const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${bearer}` } });
        sockets.push(ws);
        const hello = await new Promise<{ me: { userId: string; kind: string } }>(
          (resolve, reject) => {
            ws.once("error", reject);
            ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
          },
        );
        expect(hello.me).toMatchObject({ userId: agentId, kind: "agent" });
      }
      const closed = sockets.map(
        (ws) => new Promise<number>((resolve) => ws.once("close", resolve)),
      );
      await revokeRuntimeTokensForRuntime(parentRuntime);
      expect(await Promise.all(closed)).toEqual([1008, 1008]);
    } finally {
      for (const ws of sockets) ws.terminate();
    }
  });
});
