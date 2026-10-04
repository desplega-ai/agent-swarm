/**
 * Who may list and delete memories over HTTP (`POST /api/memory/list`,
 * `DELETE /api/memory/{id}`).
 *
 * Drives the real `handleMemory` handler against the real SQLite store behind
 * the same auth resolution `handleCore` performs, so each case presents a real
 * credential: the shared key, the shared key with `X-Agent-ID` (what the script
 * SDK's `memory_delete` sends), an `aseph_` agent session token, or an `aswt_`
 * user token.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { closeDb, createAgent, createUser, initDb } from "../be/db";
import { getMemoryStore } from "../be/memory";
import { type IdentityActor, mintSessionToken, mintToken } from "../be/users";
import { resolveHttpRequestAuth } from "../http/auth";
import { handleMemory } from "../http/memory";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-memory-http-access.sqlite";
const API_KEY = "memory-http-access-test-key";
const ACTOR: IdentityActor = { kind: "operator", id: "memory-http-access-test" };

let server: Server;
let baseUrl = "";
let workerA = "";
let workerB = "";
let leadId = "";
let workerASession = "";
let userToken = "";

function createAuthedServer(): Server {
  return createServer(async (req, res) => {
    const auth = await resolveHttpRequestAuth(req, API_KEY);
    if (!auth) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    setRequestAuth(req, auth);
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw = req.headers["x-agent-id"];
    const agentIdHeader = Array.isArray(raw) ? raw[0] : raw;
    const handled = await handleMemory(
      req,
      res,
      url.pathname.split("/").filter(Boolean),
      agentIdHeader,
    );
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

const operator = () => ({ Authorization: `Bearer ${API_KEY}` });
const asAgent = (agentId: string) => ({ ...operator(), "X-Agent-ID": agentId });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function remember(agentId: string, scope: "agent" | "swarm", name: string) {
  return getMemoryStore().store({
    agentId,
    scope,
    name,
    content: `${name} body`,
    source: "manual",
  });
}

async function del(id: string, headers: Record<string, string>) {
  const res = await fetch(`${baseUrl}/api/memory/${id}`, { method: "DELETE", headers });
  return res.status;
}

async function list(headers: Record<string, string>, body: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/memory/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ limit: 100, ...body }),
  });
  const json = (await res.json()) as {
    results: { id: string; agentId: string | null; scope: string }[];
    total: number;
  };
  return { status: res.status, ...json };
}

async function exists(id: string) {
  return (await getMemoryStore().peek(id)) !== null;
}

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);

  workerA = crypto.randomUUID();
  workerB = crypto.randomUUID();
  leadId = crypto.randomUUID();
  await createAgent({ id: workerA, name: "memory-worker-a", isLead: false, status: "idle" });
  await createAgent({ id: workerB, name: "memory-worker-b", isLead: false, status: "idle" });
  await createAgent({ id: leadId, name: "memory-lead", isLead: true, status: "idle" });

  workerASession = (await mintSessionToken(workerA, crypto.randomUUID(), 60_000)).plaintext;
  const user = await createUser({ name: "Memory admin" });
  userToken = (await mintToken(user.id, "memory-admin", ACTOR)).plaintext;

  server = createAuthedServer();
  const port = await listenOnFreePort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("DELETE /api/memory/{id}", () => {
  test("a worker cannot delete another agent's memory", async () => {
    const memory = await remember(workerB, "agent", "b-private");
    expect(await del(memory.id, asAgent(workerA))).toBe(403);
    expect(await exists(memory.id)).toBe(true);
  });

  test("an aseph_ session token is held to the same rule", async () => {
    const memory = await remember(workerB, "agent", "b-private-session");
    expect(await del(memory.id, bearer(workerASession))).toBe(403);
    expect(await exists(memory.id)).toBe(true);
  });

  test("a worker cannot delete a swarm-scope memory, even one it wrote", async () => {
    const theirs = await remember(workerB, "swarm", "b-swarm");
    const own = await remember(workerA, "swarm", "a-swarm");
    expect(await del(theirs.id, asAgent(workerA))).toBe(403);
    expect(await del(own.id, asAgent(workerA))).toBe(403);
    expect(await exists(theirs.id)).toBe(true);
    expect(await exists(own.id)).toBe(true);
  });

  test("a worker deletes its own agent-scope memory", async () => {
    const memory = await remember(workerA, "agent", "a-private");
    expect(await del(memory.id, asAgent(workerA))).toBe(200);
    expect(await exists(memory.id)).toBe(false);
  });

  test("the lead deletes a swarm-scope memory but not another agent's agent-scope memory", async () => {
    const swarm = await remember(workerB, "swarm", "b-swarm-for-lead");
    const priv = await remember(workerB, "agent", "b-private-for-lead");
    expect(await del(swarm.id, asAgent(leadId))).toBe(200);
    expect(await del(priv.id, asAgent(leadId))).toBe(403);
    expect(await exists(swarm.id)).toBe(false);
    expect(await exists(priv.id)).toBe(true);
  });

  test("the operator key and a user token delete any memory", async () => {
    const one = await remember(workerB, "agent", "b-private-for-operator");
    const two = await remember(workerB, "swarm", "b-swarm-for-user");
    expect(await del(one.id, operator())).toBe(200);
    expect(await del(two.id, bearer(userToken))).toBe(200);
    expect(await exists(one.id)).toBe(false);
    expect(await exists(two.id)).toBe(false);
  });

  test("a missing memory is a 404 for every caller", async () => {
    expect(await del(crypto.randomUUID(), asAgent(workerA))).toBe(404);
    expect(await del(crypto.randomUUID(), operator())).toBe(404);
  });
});

describe("POST /api/memory/list", () => {
  let aPrivate = "";
  let bPrivate = "";
  let bSwarm = "";

  beforeAll(async () => {
    aPrivate = (await remember(workerA, "agent", "list-a-private")).id;
    bPrivate = (await remember(workerB, "agent", "list-b-private")).id;
    bSwarm = (await remember(workerB, "swarm", "list-b-swarm")).id;
  });

  test("a worker sees its own rows and swarm rows, never another agent's private rows", async () => {
    const res = await list(asAgent(workerA));
    expect(res.status).toBe(200);
    const ids = res.results.map((r) => r.id);
    expect(ids).toContain(aPrivate);
    expect(ids).toContain(bSwarm);
    expect(ids).not.toContain(bPrivate);
    expect(res.results.every((r) => r.agentId === workerA || r.scope === "swarm")).toBe(true);
    expect(res.total).toBe(res.results.length);
  });

  test("filtering a worker's list by another agent returns only that agent's swarm rows", async () => {
    const res = await list(asAgent(workerA), { agentId: workerB });
    const ids = res.results.map((r) => r.id);
    expect(ids).toContain(bSwarm);
    expect(ids).not.toContain(bPrivate);
  });

  test("scope=agent for a worker is its own private rows only", async () => {
    const res = await list(bearer(workerASession), { scope: "agent" });
    const ids = res.results.map((r) => r.id);
    expect(ids).toContain(aPrivate);
    expect(ids).not.toContain(bPrivate);
  });

  test("the operator key, a user token and the lead see every agent's rows", async () => {
    for (const headers of [operator(), bearer(userToken), asAgent(leadId)]) {
      const ids = (await list(headers)).results.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([aPrivate, bPrivate, bSwarm]));
    }
  });
});
