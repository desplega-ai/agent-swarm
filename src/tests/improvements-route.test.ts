import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { closeDb, createAgent, createUser, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import { getImprovement } from "../be/improvements";
import { type IdentityActor, mintSessionToken, mintToken } from "../be/users";
import { resolveHttpRequestAuth } from "../http/auth";
import { handleImprovements } from "../http/improvements";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-improvements-route.sqlite";
const API_KEY = "improvements-route-test-key";
const ACTOR: IdentityActor = { kind: "operator", id: "improvements-route-test" };
const GITHUB_TOKEN = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;

let server: Server;
let proxy: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let workerId = "";
let otherWorkerId = "";
let user: { id: string; token: string };
let workerSessionToken = "";
let proxyRequests: Array<Record<string, unknown>> = [];
let proxyStatus = 202;

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
    const handled = await handleImprovements(
      req,
      res,
      url.pathname.split("/").filter(Boolean),
      url.searchParams,
    );
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

async function call(
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const operator = () => ({ Authorization: `Bearer ${API_KEY}` });
const asAgent = (agentId: string) => ({ ...operator(), "X-Agent-ID": agentId });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function draftAsAgent(text = "Add a keyboard shortcut for search") {
  const res = await call("POST", "/api/improvements", asAgent(workerId), { text });
  expect(res.status).toBe(201);
  return res.body.improvement as { id: string; status: string };
}

async function setEnabled(value: "true" | "false") {
  await upsertSwarmConfig({ scope: "global", key: "IMPROVEMENTS_ENABLED", value });
}

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
  workerId = crypto.randomUUID();
  otherWorkerId = crypto.randomUUID();
  await createAgent({ id: workerId, name: "imp-worker", isLead: false, status: "idle" });
  await createAgent({ id: otherWorkerId, name: "imp-other", isLead: false, status: "idle" });
  const alice = await createUser({ name: "Alice", email: "alice@example.com" });
  user = { id: alice.id, token: (await mintToken(alice.id, "alice", ACTOR)).plaintext };
  workerSessionToken = (await mintSessionToken(workerId, crypto.randomUUID(), 60_000)).plaintext;

  proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      proxyRequests.push((await req.json()) as Record<string, unknown>);
      return Response.json(
        { status: "accepted", id: crypto.randomUUID() },
        { status: proxyStatus },
      );
    },
  });
  await upsertSwarmConfig({
    scope: "global",
    key: "feedback_endpoint",
    value: `http://127.0.0.1:${proxy.port}/v1/feedback`,
  });

  server = createAuthedServer();
  const port = await listenOnFreePort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.close();
  proxy.stop(true);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

beforeEach(async () => {
  proxyRequests = [];
  proxyStatus = 202;
  await setEnabled("true");
});

describe("an agent can only draft", () => {
  test("shared key + X-Agent-ID approve is refused and nothing is sent", async () => {
    const draft = await draftAsAgent();
    const res = await call("POST", `/api/improvements/${draft.id}/approve`, asAgent(workerId), {});
    expect(res.status).toBe(403);
    expect(proxyRequests).toHaveLength(0);
    expect((await getImprovement(draft.id))?.status).toBe("pending_approval");
  });

  test("an aseph_ agent session token approve is refused and nothing is sent", async () => {
    const draft = await draftAsAgent();
    const res = await call(
      "POST",
      `/api/improvements/${draft.id}/approve`,
      bearer(workerSessionToken),
      {},
    );
    expect(res.status).toBe(403);
    expect(proxyRequests).toHaveLength(0);
    expect((await getImprovement(draft.id))?.approvedBy).toBeNull();
  });

  test("an agent's sendNow stays pending and nothing is sent", async () => {
    const res = await call("POST", "/api/improvements", asAgent(workerId), {
      text: "Ship it now please",
      sendNow: true,
      email: "someone@example.com",
    });
    expect(res.status).toBe(201);
    expect(res.body.improvement.status).toBe("pending_approval");
    expect(res.body.improvement.requestedByAgentId).toBe(workerId);
    expect(res.body.improvement.email).toBeNull();
    expect(proxyRequests).toHaveLength(0);
  });
});

describe("a person approves", () => {
  test("a user token approve sends once, with approvedBy from the credential", async () => {
    const draft = await draftAsAgent("Show cost per workflow run");
    const res = await call("POST", `/api/improvements/${draft.id}/approve`, bearer(user.token), {
      email: "alice@example.com",
    });
    expect(res.status).toBe(200);
    expect(res.body.improvement.status).toBe("sent");
    expect(res.body.improvement.approvedBy).toBe(user.id);
    expect(proxyRequests).toEqual([
      expect.objectContaining({ text: "Show cost per workflow run", email: "alice@example.com" }),
    ]);

    const again = await call(
      "POST",
      `/api/improvements/${draft.id}/approve`,
      bearer(user.token),
      {},
    );
    expect(again.status).toBe(409);
    expect(proxyRequests).toHaveLength(1);
  });

  test("the shared key alone approves as operator", async () => {
    const draft = await draftAsAgent();
    const res = await call("POST", `/api/improvements/${draft.id}/approve`, operator(), {});
    expect(res.status).toBe(200);
    expect(res.body.improvement.approvedBy).toBe("operator");
    expect(proxyRequests).toHaveLength(1);
  });

  test("a person's sendNow creates and sends in one call", async () => {
    const res = await call("POST", "/api/improvements", bearer(user.token), {
      text: "Let me pin tasks",
      sendNow: true,
      source: "ui",
    });
    expect(res.status).toBe(200);
    expect(res.body.improvement).toMatchObject({
      status: "sent",
      source: "ui",
      approvedBy: user.id,
    });
    expect(proxyRequests).toHaveLength(1);
  });

  test("a proxy 500 marks the row failed and a person can retry", async () => {
    proxyStatus = 500;
    const draft = await draftAsAgent();
    const res = await call("POST", `/api/improvements/${draft.id}/approve`, operator(), {});
    expect(res.status).toBe(200);
    expect(res.body.improvement).toMatchObject({ status: "failed", proxyStatus: 500 });
    proxyStatus = 202;
    const retry = await call("POST", `/api/improvements/${draft.id}/approve`, operator(), {});
    expect(retry.body.improvement.status).toBe("sent");
    expect(proxyRequests).toHaveLength(2);
  });
});

describe("secret scrubbing", () => {
  test("a secret-shaped token is stored redacted and a person's sendNow stays pending", async () => {
    const res = await call("POST", "/api/improvements", bearer(user.token), {
      text: `My token ${GITHUB_TOKEN} leaked in logs`,
      sendNow: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.improvement.status).toBe("pending_approval");
    expect(res.body.improvement.text).not.toContain(GITHUB_TOKEN);
    expect(res.body.improvement.text).toContain("[REDACTED");
    expect(proxyRequests).toHaveLength(0);
  });
});

describe("discard", () => {
  test("another agent cannot discard a draft; the drafting agent can", async () => {
    const draft = await draftAsAgent();
    const other = await call(
      "POST",
      `/api/improvements/${draft.id}/discard`,
      asAgent(otherWorkerId),
    );
    expect(other.status).toBe(403);
    const own = await call("POST", `/api/improvements/${draft.id}/discard`, asAgent(workerId));
    expect(own.status).toBe(200);
    expect(own.body.improvement.status).toBe("discarded");
    const approve = await call("POST", `/api/improvements/${draft.id}/approve`, operator(), {});
    expect(approve.status).toBe(409);
    expect(proxyRequests).toHaveLength(0);
  });
});

describe("kill switch", () => {
  test("with IMPROVEMENTS_ENABLED=false every write route refuses and nothing is sent", async () => {
    const draft = await draftAsAgent();
    await setEnabled("false");
    const create = await call("POST", "/api/improvements", bearer(user.token), {
      text: "x",
      sendNow: true,
    });
    const approve = await call("POST", `/api/improvements/${draft.id}/approve`, operator(), {});
    const discard = await call("POST", `/api/improvements/${draft.id}/discard`, operator());
    for (const res of [create, approve, discard]) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("improvements_disabled");
    }
    expect(proxyRequests).toHaveLength(0);

    const list = await call("GET", "/api/improvements", operator());
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(false);
  });
});

describe("list", () => {
  test("pending rows carry leak hints", async () => {
    await call("POST", "/api/improvements", asAgent(workerId), {
      text: "imp-worker keeps timing out",
    });
    const list = await call("GET", "/api/improvements", operator());
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(true);
    const row = list.body.improvements.find(
      (r: { text: string }) => r.text === "imp-worker keeps timing out",
    );
    expect(row.leakHints).toContain("imp-worker");
  });

  test("old pending and failed drafts stay listed behind more than 100 newer rows", async () => {
    const insert = (id: string, status: string, createdAt: string) =>
      getDbClient().run(
        `INSERT INTO improvements (id, text, status, source, approved_by, created_at, updated_at)
         VALUES (?, ?, ?, 'api', ?, ?, ?)`,
        [id, `row ${id}`, status, status === "sent" ? "operator" : null, createdAt, createdAt],
      );
    const oldPending = crypto.randomUUID();
    const oldFailed = crypto.randomUUID();
    await insert(oldPending, "pending_approval", "2000-01-01T00:00:00.000Z");
    await insert(oldFailed, "failed", "2000-01-01T00:00:01.000Z");
    for (let i = 0; i < 150; i++) {
      const at = new Date(Date.UTC(2099, 0, 1, 0, 0, i)).toISOString();
      await insert(crypto.randomUUID(), i % 2 ? "sent" : "discarded", at);
    }

    const list = await call("GET", "/api/improvements", operator());
    expect(list.status).toBe(200);
    const rows = list.body.improvements as Array<{ id: string; status: string; createdAt: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(oldPending);
    expect(ids).toContain(oldFailed);
    expect(rows.find((r) => r.id === oldPending)?.status).toBe("pending_approval");
    // History stays capped, and the whole list stays newest first.
    const history = rows.filter((r) => r.status !== "pending_approval" && r.status !== "failed");
    expect(history).toHaveLength(100);
    const created = rows.map((r) => r.createdAt);
    expect(created).toEqual([...created].sort().reverse());
  });
});
