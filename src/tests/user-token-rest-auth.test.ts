import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, createTaskExtended, createUser, getDb, initDb } from "../be/db";
import { type IdentityActor, mintToken, revokeToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-user-token-rest-auth.sqlite";
const API_KEY = "test-api-key";
const ACTOR: IdentityActor = { kind: "operator", id: "op:test" };

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;

    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    if (await handleTasks(req, res, pathSegments, queryParams, myAgentId)) return;

    res.writeHead(404);
    res.end("Not Found");
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function cleanupDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("normal REST API user-bound token auth", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    cleanupDb();
    initDb(TEST_DB_PATH);
    createAgent({ name: "Lead", isLead: true, status: "idle" });
    server = createTestServer();
    port = await listen(server);
  });

  afterAll(() => {
    server.close();
    closeDb();
    cleanupDb();
  });

  test("POST /api/tasks accepts active user token and forces requester/audit user", async () => {
    const user = createUser({ name: "Token REST User" });
    const other = createUser({ name: "Other User" });
    const { plaintext } = mintToken(user.id, "rest", ACTOR);

    const res = await fetch(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plaintext}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task: "created through user token",
        requestedByUserId: other.id,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; requestedByUserId?: string };
    expect(body.requestedByUserId).toBe(user.id);

    const row = getDb()
      .prepare<
        { requestedByUserId: string | null; created_by: string | null; updated_by: string | null },
        string
      >("SELECT requestedByUserId, created_by, updated_by FROM agent_tasks WHERE id = ?")
      .get(body.id);
    expect(row?.requestedByUserId).toBe(user.id);
    expect(row?.created_by).toBe(user.id);
    expect(row?.updated_by).toBe(user.id);
  });

  test("global API key still creates unattributed tasks by default", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ task: "created through global key" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; requestedByUserId?: string };
    expect(body.requestedByUserId).toBeUndefined();
  });

  test("global API key caller cannot spoof requestedByUserId via body — falls back to owned task context", async () => {
    const legitRequester = createUser({ name: "Legit Requester" });
    const attacker = createUser({ name: "Attacker" });
    const agent = createAgent({ name: "spoof-test-agent", isLead: false, status: "idle" });
    const ownedTask = createTaskExtended("owned task for spoof test", {
      agentId: agent.id,
      requestedByUserId: legitRequester.id,
    });

    const res = await fetch(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "x-agent-id": agent.id,
        "x-source-task-id": ownedTask.id,
      },
      body: JSON.stringify({
        task: "created through global key with spoofed requestedByUserId",
        requestedByUserId: attacker.id,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; requestedByUserId?: string };
    expect(body.requestedByUserId).toBe(legitRequester.id);
    expect(body.requestedByUserId).not.toBe(attacker.id);
  });

  test("global API key caller + body requestedByUserId, flag OFF (default) → stays unattributed, body ignored", async () => {
    // Default posture: the body fallback is off, so an operator/global-key
    // caller cannot spoof attribution via the request body. This is the
    // anti-spoofing behavior upstream #939 introduced.
    expect(process.env.TRUST_BODY_REQUESTED_BY_USER_ID).toBeUndefined();
    const someUser = createUser({ name: "Some User (flag off)" });

    const res = await fetch(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task: "created from the UI session view, flag off",
        requestedByUserId: someUser.id,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; requestedByUserId?: string };
    expect(body.requestedByUserId).toBeUndefined();
  });

  describe("TRUST_BODY_REQUESTED_BY_USER_ID=true (opt-in for shared-key deployments)", () => {
    beforeAll(() => {
      process.env.TRUST_BODY_REQUESTED_BY_USER_ID = "true";
    });

    afterAll(() => {
      delete process.env.TRUST_BODY_REQUESTED_BY_USER_ID;
    });

    test("global API key caller + valid body requestedByUserId (no owned task context) → attributed to that user", async () => {
      // Fork-specific opt-in: this org's UI shares one operator key across
      // all users, so there is no ownership-gated task context to fall back
      // to — the body-supplied id is the only signal available, and it is
      // trusted once validated against a real user row, but only when the
      // deployment has explicitly opted into this flag.
      const uiUser = createUser({ name: "UI Picker User" });

      const res = await fetch(`http://localhost:${port}/api/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: "created from the UI session view",
          requestedByUserId: uiUser.id,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; requestedByUserId?: string };
      expect(body.requestedByUserId).toBe(uiUser.id);
    });

    test("global API key caller + bogus body requestedByUserId → stays unattributed (NULL), not a crash", async () => {
      const res = await fetch(`http://localhost:${port}/api/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: "created with a nonexistent requestedByUserId",
          requestedByUserId: "does-not-exist",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; requestedByUserId?: string };
      expect(body.requestedByUserId).toBeUndefined();
    });

    test("owned task context still takes precedence over body even when flag is on", async () => {
      const legitRequester = createUser({ name: "Legit Requester (flag on)" });
      const attacker = createUser({ name: "Attacker (flag on)" });
      const agent = createAgent({
        name: "spoof-test-agent-flag-on",
        isLead: false,
        status: "idle",
      });
      const ownedTask = createTaskExtended("owned task for spoof test, flag on", {
        agentId: agent.id,
        requestedByUserId: legitRequester.id,
      });

      const res = await fetch(`http://localhost:${port}/api/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "x-agent-id": agent.id,
          "x-source-task-id": ownedTask.id,
        },
        body: JSON.stringify({
          task: "created through global key with spoofed requestedByUserId, flag on",
          requestedByUserId: attacker.id,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; requestedByUserId?: string };
      expect(body.requestedByUserId).toBe(legitRequester.id);
      expect(body.requestedByUserId).not.toBe(attacker.id);
    });
  });

  test("revoked user token is unauthorized for normal API", async () => {
    const user = createUser({ name: "Revoked REST User" });
    const { tokenId, plaintext } = mintToken(user.id, "revoked", ACTOR);
    revokeToken(tokenId, ACTOR);

    const res = await fetch(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plaintext}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ task: "should not be created" }),
    });

    expect(res.status).toBe(401);
  });
});
