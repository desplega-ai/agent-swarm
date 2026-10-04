/**
 * Who may answer an approval request, and who the answer is recorded as.
 *
 * Drives the real `handleApprovalRequests` handler behind the same auth
 * resolution `handleCore` performs (`resolveHttpRequestAuth` + `setRequestAuth`),
 * so each case presents a real credential: the shared key, the shared key with
 * an `X-Agent-ID`, an `aswt_` user token, an `aseph_` agent session token, or a
 * page session.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createApprovalRequest,
  createPage,
  createUser,
  getApprovalRequestById,
  initDb,
} from "../be/db";
import { type IdentityActor, mintSessionToken, mintToken } from "../be/users";
import { handleApprovalRequests } from "../http/approval-requests";
import { resolveHttpRequestAuth } from "../http/auth";
import { signPageSession } from "../utils/page-session";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-approval-respond-auth.sqlite";
const API_KEY = "approval-respond-auth-test-key";
const ACTOR: IdentityActor = { kind: "operator", id: "approval-respond-auth-test" };

let server: Server;
let baseUrl = "";
let workerId = "";
let leadId = "";
let alice: { id: string; email: string; token: string };
let bob: { id: string; email: string; token: string };
let carol: { id: string; token: string };
let workerSessionToken = "";
let pageId = "";

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
    const handled = await handleApprovalRequests(
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

type Approvers = {
  users?: string[];
  roles?: string[];
  policy: "any" | "all" | { min: number };
};

async function pendingRequest(approvers: Approvers = { policy: "any" }) {
  return createApprovalRequest({
    id: crypto.randomUUID(),
    title: "Ship the release",
    questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
    approvers,
  });
}

async function respond(
  id: string,
  headers: Record<string, string>,
  body: Record<string, unknown> = { responses: { q1: { approved: true } } },
) {
  const res = await fetch(`${baseUrl}/api/approval-requests/${id}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const operator = () => ({ Authorization: `Bearer ${API_KEY}` });
const asUser = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);

  workerId = crypto.randomUUID();
  leadId = crypto.randomUUID();
  await createAgent({ id: workerId, name: "respond-worker", isLead: false, status: "idle" });
  await createAgent({ id: leadId, name: "respond-lead", isLead: true, status: "idle" });

  const a = await createUser({
    name: "Alice",
    email: "alice@example.com",
    role: "release-manager",
  });
  const b = await createUser({ name: "Bob", email: "bob@example.com" });
  const c = await createUser({ name: "Carol", role: "release-manager" });
  alice = {
    id: a.id,
    email: "alice@example.com",
    token: (await mintToken(a.id, "alice", ACTOR)).plaintext,
  };
  bob = {
    id: b.id,
    email: "bob@example.com",
    token: (await mintToken(b.id, "bob", ACTOR)).plaintext,
  };
  carol = { id: c.id, token: (await mintToken(c.id, "carol", ACTOR)).plaintext };

  workerSessionToken = (await mintSessionToken(workerId, crypto.randomUUID(), 60_000)).plaintext;

  const page = await createPage({
    agentId: workerId,
    slug: `respond-page-${crypto.randomUUID().slice(0, 8)}`,
    title: "Respond page",
    contentType: "text/html",
    body: "<p>hi</p>",
  });
  pageId = page.id;

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

describe("agent principals cannot answer an approval request", () => {
  test("shared key with X-Agent-ID (worker) is refused and the request stays pending", async () => {
    const request = await pendingRequest();
    const res = await respond(
      request.id,
      { ...operator(), "X-Agent-ID": workerId },
      {
        responses: { q1: { approved: true } },
        respondedBy: alice.email,
      },
    );
    expect(res.status).toBe(403);
    const stored = await getApprovalRequestById(request.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.resolvedBy).toBeNull();
  });

  test("shared key with a lead's X-Agent-ID is refused", async () => {
    const request = await pendingRequest();
    const res = await respond(request.id, { ...operator(), "X-Agent-ID": leadId });
    expect(res.status).toBe(403);
    expect((await getApprovalRequestById(request.id))?.status).toBe("pending");
  });

  test("an aseph_ agent session token is refused", async () => {
    const request = await pendingRequest();
    const res = await respond(request.id, asUser(workerSessionToken));
    expect(res.status).toBe(403);
    expect((await getApprovalRequestById(request.id))?.status).toBe("pending");
  });

  test("a page session with no signed-in user is refused", async () => {
    const request = await pendingRequest();
    const session = await signPageSession({ pageId, exp: Math.floor(Date.now() / 1000) + 600 });
    const res = await respond(request.id, {
      ...operator(),
      "X-Page-Id": pageId,
      "X-Page-Session": session,
    });
    expect(res.status).toBe(403);
    expect((await getApprovalRequestById(request.id))?.status).toBe("pending");
  });
});

describe("the responder comes from the credential, not the body", () => {
  test("shared key alone resolves as operator; respondedBy is kept only as a claim", async () => {
    const request = await pendingRequest();
    const res = await respond(request.id, operator(), {
      responses: { q1: { approved: true } },
      respondedBy: "someone-else@example.com",
    });
    expect(res.status).toBe(200);
    expect(res.body.approvalRequest.status).toBe("approved");
    expect(res.body.approvalRequest.resolvedBy).toBe("operator");
    expect(res.body.approvalRequest.approvals).toEqual([
      expect.objectContaining({
        responder: "operator",
        approved: true,
        claimedRespondedBy: "someone-else@example.com",
      }),
    ]);
    expect((await getApprovalRequestById(request.id))?.resolvedBy).toBe("operator");
  });

  test("a user token resolves as that user's id, whatever the body claims", async () => {
    const request = await pendingRequest();
    const res = await respond(request.id, asUser(bob.token), {
      responses: { q1: { approved: false } },
      respondedBy: alice.email,
    });
    expect(res.status).toBe(200);
    expect(res.body.approvalRequest.status).toBe("rejected");
    expect(res.body.approvalRequest.resolvedBy).toBe(bob.id);
  });

  test("a page session signed for a user resolves as that user", async () => {
    const request = await pendingRequest();
    const session = await signPageSession({
      pageId,
      exp: Math.floor(Date.now() / 1000) + 600,
      uid: alice.id,
    });
    const res = await respond(request.id, {
      ...operator(),
      "X-Page-Id": pageId,
      "X-Page-Session": session,
    });
    expect(res.status).toBe(200);
    expect(res.body.approvalRequest.resolvedBy).toBe(alice.id);
  });
});

describe("the approvers policy is enforced", () => {
  test("a user outside approvers.users and approvers.roles is refused", async () => {
    const request = await pendingRequest({ users: [alice.id], policy: "any" });
    const res = await respond(request.id, asUser(bob.token));
    expect(res.status).toBe(403);
    expect((await getApprovalRequestById(request.id))?.status).toBe("pending");
  });

  test("a listed user may answer; a user may also be listed by email", async () => {
    const byId = await pendingRequest({ users: [alice.id], policy: "any" });
    expect((await respond(byId.id, asUser(alice.token))).body.approvalRequest.status).toBe(
      "approved",
    );
    const byEmail = await pendingRequest({ users: [bob.email], policy: "any" });
    expect((await respond(byEmail.id, asUser(bob.token))).body.approvalRequest.status).toBe(
      "approved",
    );
  });

  test("a user holding a listed role may answer", async () => {
    const request = await pendingRequest({ roles: ["release-manager"], policy: "any" });
    expect((await respond(request.id, asUser(bob.token))).status).toBe(403);
    const res = await respond(request.id, asUser(carol.token));
    expect(res.status).toBe(200);
    expect(res.body.approvalRequest.resolvedBy).toBe(carol.id);
  });

  test("the operator key may answer a restricted request", async () => {
    const request = await pendingRequest({ users: [alice.id], policy: "any" });
    const res = await respond(request.id, operator());
    expect(res.status).toBe(200);
    expect(res.body.approvalRequest.resolvedBy).toBe("operator");
  });

  test("min: N distinct approvals are needed; a repeat answer from one responder is refused", async () => {
    const request = await pendingRequest({ policy: { min: 2 } });

    const first = await respond(request.id, asUser(alice.token));
    expect(first.status).toBe(200);
    expect(first.body.approvalRequest.status).toBe("pending");
    expect(first.body.approvalRequest.resolvedBy).toBeNull();
    expect(first.body.approvalRequest.approvalProgress).toEqual({ approved: 1, required: 2 });

    const repeat = await respond(request.id, asUser(alice.token));
    expect(repeat.status).toBe(409);

    const second = await respond(request.id, asUser(bob.token));
    expect(second.status).toBe(200);
    expect(second.body.approvalRequest.status).toBe("approved");
    expect(second.body.approvalRequest.resolvedBy).toBe(bob.id);
    expect(second.body.approvalRequest.approvalProgress).toBeNull();
    expect(
      (second.body.approvalRequest.approvals as { responder: string }[]).map((a) => a.responder),
    ).toEqual([alice.id, bob.id]);
  });

  test("concurrent answers to a min-2 request both land and resolve it", async () => {
    const request = await pendingRequest({ policy: { min: 2 } });
    const results = await Promise.all([
      respond(request.id, asUser(alice.token)),
      respond(request.id, asUser(bob.token)),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const stored = await getApprovalRequestById(request.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.approvals?.map((a) => a.responder).sort()).toEqual([alice.id, bob.id].sort());
  });

  test("concurrent repeat answers from one responder count once", async () => {
    const request = await pendingRequest({ policy: { min: 2 } });
    const results = await Promise.all([
      respond(request.id, asUser(alice.token)),
      respond(request.id, asUser(alice.token)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const stored = await getApprovalRequestById(request.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.approvals).toHaveLength(1);
  });

  test("all: every listed user must approve; the operator does not stand in for one", async () => {
    const request = await pendingRequest({ users: [alice.id, bob.id], policy: "all" });

    const byOperator = (await respond(request.id, operator())).body.approvalRequest;
    expect(byOperator.status).toBe("pending");
    expect(byOperator.approvalProgress).toEqual({ approved: 0, required: 2 });
    const byAlice = (await respond(request.id, asUser(alice.token))).body.approvalRequest;
    expect(byAlice.status).toBe("pending");
    expect(byAlice.approvalProgress).toEqual({ approved: 1, required: 2 });
    const last = await respond(request.id, asUser(bob.token));
    expect(last.body.approvalRequest.status).toBe("approved");
  });

  test("the slim list and the detail read carry quorum progress for pending requests", async () => {
    const request = await pendingRequest({ policy: { min: 3 } });
    expect((await respond(request.id, asUser(alice.token))).status).toBe(200);

    const list = await fetch(`${baseUrl}/api/approval-requests?fields=slim&status=pending`, {
      headers: operator(),
    });
    const { approvalRequests } = (await list.json()) as {
      approvalRequests: { id: string; approvalProgress: unknown; approvals?: unknown }[];
    };
    const row = approvalRequests.find((r) => r.id === request.id);
    expect(row?.approvalProgress).toEqual({ approved: 1, required: 3 });
    expect(row && "approvals" in row).toBe(false);

    const detail = await fetch(`${baseUrl}/api/approval-requests/${request.id}`, {
      headers: operator(),
    });
    const { approvalRequest } = (await detail.json()) as Record<string, any>;
    expect(approvalRequest.approvalProgress).toEqual({ approved: 1, required: 3 });
    expect(approvalRequest.approvals).toHaveLength(1);
  });

  test("one rejection from an eligible responder rejects a multi-approver request", async () => {
    const request = await pendingRequest({ users: [alice.id, bob.id], policy: "all" });
    expect((await respond(request.id, asUser(alice.token))).body.approvalRequest.status).toBe(
      "pending",
    );
    const res = await respond(request.id, asUser(bob.token), {
      responses: { q1: { approved: false } },
    });
    expect(res.body.approvalRequest.status).toBe("rejected");
    expect(res.body.approvalRequest.resolvedBy).toBe(bob.id);
  });
});
