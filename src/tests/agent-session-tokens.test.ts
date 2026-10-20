import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getAgentById,
  getDbClient,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { attachRole } from "../be/rbac-roles";
import { createRuntimeController } from "../be/runtime-pools/db";
import { mintControllerToken } from "../be/runtime-pools/tokens";
import {
  AGENT_TOKEN_NO_EXPIRY,
  type IdentityActor,
  mintAgentToken,
  mintRuntimeToken,
  mintSessionToken,
  mintToken,
  resolveBySessionToken,
  resolveSessionToken,
  revokeAgentTokens,
} from "../be/users";
import { handleAgentRegister, handleAgentsRest } from "../http/agents";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { handlePoll } from "../http/poll";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { scrubSecrets } from "../utils/secret-scrubber";
import { registerSessionTokenConnection } from "../utils/session-token-connections";
import { listenOnFreePort } from "./test-net";

// Synthetic credentials, built at runtime so no literal looks like a real secret.
const key = `agent-token-test-${randomBytes(8).toString("hex")}`;
const synthetic = (label: string) => `synthetic-${label}-${randomBytes(12).toString("hex")}`;
const USER_ACTOR: IdentityActor = { kind: "operator", id: "agent-session-tokens-test" };
let server: Server;
let baseUrl: string;
let workerId: string;
let otherId: string;
let leadId: string;
let ownTaskId: string;
let otherTaskId: string;

async function request(
  path: string,
  bearer: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, text, body };
}

async function dispatch(req: IncomingMessage, res: ServerResponse) {
  if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, key)) return;
  const segments = getPathSegments(req.url ?? "");
  const query = parseQueryParams(req.url ?? "");
  const id = req.headers["x-agent-id"] as string | undefined;
  if (await handleAgentRegister(req, res, segments, id)) return;
  if (await handlePoll(req, res, segments, query, id)) return;
  if (await handleAgentsRest(req, res, segments, query, id)) return;
  if (await handleSessions(req, res, segments, query)) return;
  if (await handleConfig(req, res, segments, query)) return;
  res.writeHead(404).end();
}

beforeAll(async () => {
  initDb(":memory:");
  workerId = (await createAgent({ name: "token-worker", isLead: false, status: "idle" })).id;
  otherId = (await createAgent({ name: "token-other", isLead: false, status: "idle" })).id;
  leadId = (await createAgent({ name: "token-lead", isLead: true, status: "idle" })).id;
  ownTaskId = (await createTaskExtended("Own task", { agentId: workerId, source: "system" })).id;
  otherTaskId = (await createTaskExtended("Other task", { agentId: otherId, source: "system" })).id;
  server = createServer((req, res) => {
    void dispatch(req, res).catch(() => res.writeHead(500).end());
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

describe("worker token management routes", () => {
  test("operator mints a non-expiring agent token, once per agent", async () => {
    const newId = crypto.randomUUID();
    expect((await request(`/api/agents/${newId}/token`, key, { body: {} })).status).toBe(404);

    const minted = await request(`/api/agents/${newId}/token`, key, {
      body: { name: "minted-worker" },
    });
    expect(minted.status).toBe(200);
    expect(minted.body).toMatchObject({ agentId: newId, expiresAt: null, agentCreated: true });
    expect(await getAgentById(newId)).toMatchObject({
      name: "minted-worker",
      isLead: false,
      status: "offline",
    });
    expect(await resolveBySessionToken(minted.body.plaintext)).toMatchObject({
      tokenId: minted.body.tokenId,
      tokenKind: "agent",
      agentId: newId,
      taskId: null,
      runtimeId: null,
      expiresAt: AGENT_TOKEN_NO_EXPIRY,
    });
    // The plaintext is registered with the scrubber at mint time.
    expect(scrubSecrets(`token=${minted.body.plaintext}`)).not.toContain(minted.body.plaintext);

    const again = await request(`/api/agents/${newId}/token`, key, { body: {} });
    expect(again.status).toBe(409);

    // The stored expiry is exact on every mint, so the active-token lookup
    // (a string comparison) always finds the token the resolver accepts.
    for (let i = 0; i < 25; i++) {
      await revokeAgentTokens(newId);
      const token = await mintAgentToken(newId);
      expect((await resolveBySessionToken(token.plaintext))?.expiresAt).toBe(AGENT_TOKEN_NO_EXPIRY);
    }
    expect(await revokeAgentTokens(newId)).toBe(1);

    const ttl = await request(`/api/agents/${otherId}/token`, key, { body: { ttlMs: 60_000 } });
    expect(ttl.status).toBe(200);
    expect(ttl.body.agentCreated).toBe(false);
    expect(Date.parse(ttl.body.expiresAt)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect((await request(`/api/agents/${otherId}/token`, key, { method: "DELETE" })).body).toEqual(
      { revoked: 1 },
    );
  });

  test("only an operator key without X-Agent-ID or a user manages worker tokens", async () => {
    const own = await mintAgentToken(leadId);
    const lead = await mintRuntimeToken(leadId, crypto.randomUUID(), 60_000);
    const task = await mintSessionToken(workerId, ownTaskId, 60_000);
    const path = `/api/agents/${workerId}/token`;
    // Agent-first: the operator key acting as an agent, even the lead, is that agent.
    for (const agentId of [workerId, leadId]) {
      const res = await request(path, key, { body: {}, headers: { "X-Agent-ID": agentId } });
      expect(res.status).toBe(403);
    }
    for (const bearer of [own.plaintext, lead.plaintext, task.plaintext]) {
      for (const [method, suffix] of [
        ["POST", ""],
        ["POST", "/rotate"],
        ["DELETE", ""],
      ] as const) {
        const res = await request(`${path}${suffix}`, bearer, {
          method,
          body: method === "POST" ? {} : undefined,
        });
        expect(res.status).toBe(403);
      }
    }
    expect((await request(`/api/agents/${leadId}/token`, key, { method: "DELETE" })).body).toEqual({
      revoked: 1,
    });
  });

  test("rotation keeps the old token for the grace window, then it expires", async () => {
    expect((await request(`/api/agents/${workerId}/token/rotate`, key, { body: {} })).status).toBe(
      404,
    );
    const first = await mintAgentToken(workerId);
    const firstChild = await mintSessionToken(workerId, ownTaskId, 7 * 86_400_000, {
      tokenId: first.tokenId,
      runtimeId: null,
    });
    const rotated = await request(`/api/agents/${workerId}/token/rotate`, key, {
      body: { graceSec: 60 },
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.expiresAt).toBeNull();
    expect(Date.parse(rotated.body.previousExpiresAt)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect((await request("/api/poll", first.plaintext)).status).toBe(200);
    expect((await request("/api/poll", rotated.body.plaintext)).status).toBe(200);
    // A child of the rotated token expires with it, not at its own longer TTL.
    expect((await resolveBySessionToken(firstChild.plaintext))?.expiresAt).toBe(
      rotated.body.previousExpiresAt,
    );
    const rotatedChild = await mintSessionToken(workerId, ownTaskId, 7 * 86_400_000, {
      tokenId: rotated.body.tokenId,
      runtimeId: null,
    });

    const again = await request(`/api/agents/${workerId}/token/rotate`, key, {
      body: { graceSec: 0 },
    });
    expect(again.status).toBe(200);
    expect((await request("/api/poll", rotated.body.plaintext)).status).toBe(401);
    expect((await request("/api/poll", rotatedChild.plaintext)).status).toBe(401);
    expect((await request("/api/poll", again.body.plaintext)).status).toBe(200);
    expect(
      (await request(`/api/agents/${workerId}/token`, key, { method: "DELETE" })).body,
    ).toEqual({ revoked: 1 });
    expect((await request("/api/poll", again.body.plaintext)).status).toBe(401);
  });

  test("a user without a grant-all role needs the agent's privileges and never mints a lead's", async () => {
    const roleId = `token-manager-${crypto.randomUUID()}`;
    await getDbClient().run(
      "INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES (?, ?, '', 0, 0)",
      [roleId, roleId],
    );
    const grant = (verb: string) =>
      getDbClient().run("INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)", [
        roleId,
        verb,
      ]);
    await grant("agent.token.manage");
    const limited = await createUser({ name: "Token manager" });
    // New users start as admin (rbac-roles insert trigger); narrow this one.
    await getDbClient().run("DELETE FROM principal_roles WHERE principalId = ?", [limited.id]);
    await getDbClient().run(
      "INSERT INTO principal_roles (principalType, principalId, roleId) VALUES ('user', ?, ?)",
      [limited.id, roleId],
    );
    const limitedToken = (await mintToken(limited.id, "limited", USER_ACTOR)).plaintext;
    const admin = await createUser({ name: "Token admin" });
    await attachRole(admin.id, "admin");
    const adminToken = (await mintToken(admin.id, "admin", USER_ACTOR)).plaintext;

    // agent.token.manage alone would hand out the agent's privileges and secret reads.
    for (const agentId of [workerId, leadId]) {
      const res = await request(`/api/agents/${agentId}/token`, limitedToken, { body: {} });
      expect(res.status).toBe(403);
    }
    await grant("agent.act.any");
    await grant("config.read.secrets");
    const minted = await request(`/api/agents/${workerId}/token`, limitedToken, { body: {} });
    expect(minted.status).toBe(200);
    expect(minted.body.agentId).toBe(workerId);
    for (const [method, suffix] of [
      ["POST", ""],
      ["POST", "/rotate"],
      ["DELETE", ""],
    ] as const) {
      const res = await request(`/api/agents/${leadId}/token${suffix}`, limitedToken, {
        method,
        body: method === "POST" ? {} : undefined,
      });
      expect(res.status).toBe(403);
    }

    const lead = await request(`/api/agents/${leadId}/token`, adminToken, { body: {} });
    expect(lead.status).toBe(200);
    for (const agentId of [workerId, leadId]) {
      expect(
        (await request(`/api/agents/${agentId}/token`, adminToken, { method: "DELETE" })).body,
      ).toEqual({ revoked: 1 });
    }
  });
});

describe("worker token as an agent principal", () => {
  test("binds X-Agent-ID and X-Source-Task-Id to the token agent", async () => {
    const token = await mintAgentToken(workerId);
    try {
      expect((await request("/api/poll", token.plaintext)).status).toBe(200);
      const spoofed = await request("/api/poll", token.plaintext, {
        headers: { "X-Agent-ID": otherId },
      });
      expect(spoofed.status).toBe(403);
      const foreignTask = await request("/api/config/resolved", token.plaintext, {
        headers: { "X-Source-Task-Id": otherTaskId },
      });
      expect(foreignTask.status).toBe(403);
      const ownTask = await request("/api/config/resolved", token.plaintext, {
        headers: { "X-Source-Task-Id": ownTaskId },
      });
      expect(ownTask.status).toBe(200);
      // Registration accepts the token for its own agent and cannot promote it.
      const registered = await request("/api/agents", token.plaintext, {
        body: { name: "token-worker", isLead: true },
      });
      expect(registered.status).toBeLessThan(300);
      expect((await getAgentById(workerId))?.isLead).toBe(false);
    } finally {
      await request(`/api/agents/${workerId}/token`, key, { method: "DELETE" });
    }
  });

  test("mints and revokes child task tokens for its own assigned task only", async () => {
    const token = await mintAgentToken(workerId);
    const child = await request("/api/sessions/tokens", token.plaintext, {
      body: { agentId: workerId, taskId: ownTaskId, ttlMs: 60_000 },
    });
    expect(child.status).toBe(200);
    expect(await resolveBySessionToken(child.body.plaintext)).toMatchObject({
      tokenKind: "task",
      taskId: ownTaskId,
    });
    for (const body of [
      { agentId: workerId, taskId: otherTaskId, ttlMs: 60_000 },
      { agentId: otherId, taskId: otherTaskId, ttlMs: 60_000 },
      { agentId: workerId, runtimeId: crypto.randomUUID(), ttlMs: 60_000 },
    ]) {
      expect((await request("/api/sessions/tokens", token.plaintext, { body })).status).toBe(403);
    }
    // A child task token cannot mint further tokens.
    const grandchild = await request("/api/sessions/tokens", child.body.plaintext, {
      body: { agentId: workerId, taskId: ownTaskId, ttlMs: 60_000 },
    });
    expect(grandchild.status).toBe(401);

    const foreign = await mintSessionToken(workerId, ownTaskId, 60_000);
    const revokeForeign = await request(
      `/api/sessions/tokens/${foreign.tokenId}`,
      token.plaintext,
      { method: "DELETE" },
    );
    expect(revokeForeign.status).toBe(403);
    const revokeOwn = await request(`/api/sessions/tokens/${child.body.tokenId}`, token.plaintext, {
      method: "DELETE",
    });
    expect(revokeOwn.status).toBe(204);
    expect(await resolveBySessionToken(child.body.plaintext)).toBeNull();
    await request(`/api/agents/${workerId}/token`, key, { method: "DELETE" });
  });

  test("revoking the agent token revokes its children and closes their connections", async () => {
    for (const revoke of ["agent-route", "session-route"] as const) {
      const token = await mintAgentToken(workerId);
      const child = await request("/api/sessions/tokens", token.plaintext, {
        body: { agentId: workerId, taskId: ownTaskId, ttlMs: 60_000 },
      });
      expect(child.status).toBe(200);
      const closed: string[] = [];
      const unregister = [token.tokenId, child.body.tokenId].map((id) =>
        registerSessionTokenConnection(id, () => closed.push(id)),
      );
      try {
        const res =
          revoke === "agent-route"
            ? await request(`/api/agents/${workerId}/token`, key, { method: "DELETE" })
            : await request(`/api/sessions/tokens/${token.tokenId}`, key, { method: "DELETE" });
        expect(res.status).toBeLessThan(300);
        expect((await request("/api/poll", token.plaintext)).status).toBe(401);
        expect((await request("/api/poll", child.body.plaintext)).status).toBe(401);
        expect(closed.sort()).toEqual([token.tokenId, child.body.tokenId].sort());
      } finally {
        for (const fn of unregister) fn();
      }
    }
  });
});

describe("secret read scope by session token kind", () => {
  const globalSecret = synthetic("global");
  const ownSecret = synthetic("own");
  const otherSecret = synthetic("other");

  beforeAll(async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "AGENT_TOKEN_TEST_GLOBAL",
      value: globalSecret,
      isSecret: true,
    });
    for (const [scopeId, value] of [
      [workerId, ownSecret],
      [otherId, otherSecret],
    ] as const) {
      await upsertSwarmConfig({
        scope: "agent",
        scopeId,
        key: "AGENT_TOKEN_TEST_AGENT",
        value,
        isSecret: true,
      });
    }
  });

  const resolved = (bearer: string, agentId?: string) =>
    request(
      `/api/config/resolved?includeSecrets=true${agentId ? `&agentId=${agentId}` : ""}`,
      bearer,
    );

  test("agent and runtime tokens read their own scope, defaulting agentId to the token", async () => {
    const agent = await mintAgentToken(workerId);
    const runtime = await mintRuntimeToken(workerId, crypto.randomUUID(), 60_000);
    try {
      for (const bearer of [agent.plaintext, runtime.plaintext]) {
        for (const agentId of [undefined, workerId]) {
          const res = await resolved(bearer, agentId);
          expect(res.status).toBe(200);
          expect(res.text).toContain(globalSecret);
          expect(res.text).toContain(ownSecret);
          expect(res.text).not.toContain(otherSecret);
        }
        const foreign = await resolved(bearer, otherId);
        expect(foreign.status).toBe(200);
        expect(foreign.text).not.toContain(otherSecret);
        expect(foreign.text).not.toContain(globalSecret);
      }
    } finally {
      await request(`/api/agents/${workerId}/token`, key, { method: "DELETE" });
    }
  });

  test("task tokens read none, controller tokens are refused, the operator reads all", async () => {
    const task = await mintSessionToken(workerId, ownTaskId, 60_000);
    for (const agentId of [undefined, workerId]) {
      const res = await resolved(task.plaintext, agentId);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(globalSecret);
      expect(res.text).not.toContain(ownSecret);
      expect(res.text).toContain("secret values masked");
    }

    const controllerId = (
      await createRuntimeController({ name: "remote", kind: "docker", placement: "remote" })
    ).id;
    const controller = await mintControllerToken(controllerId);
    expect((await resolveSessionToken(controller.plaintext))?.kind).toBe("controller");
    expect((await resolved(controller.plaintext, workerId)).status).toBe(403);

    // Positive control: the same request with the operator key returns plaintext.
    const operator = await resolved(key, otherId);
    expect(operator.status).toBe(200);
    expect(operator.text).toContain(otherSecret);
    expect(operator.text).toContain(globalSecret);
  });

  test("an unknown aseph_ token is unauthenticated", async () => {
    const random = `aseph_${randomBytes(24).toString("base64url")}`;
    expect(await resolveSessionToken(random)).toBeNull();
    for (const path of ["/api/config/resolved?includeSecrets=true", "/api/poll"]) {
      expect((await request(path, random)).status).toBe(401);
    }
    expect((await request(`/api/agents/${workerId}/token`, random, { body: {} })).status).toBe(401);
  });
});
