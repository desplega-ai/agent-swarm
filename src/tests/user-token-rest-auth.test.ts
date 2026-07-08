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
