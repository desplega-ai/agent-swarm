import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  initDb,
  updateAgentProfile,
} from "../be/db";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { createSlackTaskWithFiles } from "../slack/inbound-files";
import { beginRequestAuthScope, setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

let server: Server;
let baseUrl: string;
let leadId: string;
let workerId: string;
let userId: string;
let user: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  initDb(":memory:");
  leadId = (await createAgent({ name: "Lead", status: "idle", isLead: true })).id;
  workerId = (
    await createAgent({
      name: "Coder Reviewer",
      status: "idle",
      isLead: false,
    })
  ).id;
  await updateAgentProfile(workerId, { capabilities: ["codigo", "revision"] });
  user = await createUser({ name: "Requester", email: "human-thread@example.test" });
  userId = user.id;
  server = createServer(async (req, res) => {
    beginRequestAuthScope();
    setRequestAuth(
      req,
      req.headers["x-agent-id"]
        ? { kind: "operator", fingerprint: "test" }
        : { kind: "user", userId, user },
    );
    await handleTasks(
      req,
      res,
      getPathSegments(req.url ?? ""),
      parseQueryParams(req.url ?? ""),
      req.headers["x-agent-id"] as string | undefined,
    );
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

test("human REST reply after Coder and Reviewer work reaches Lead without worker requirements", async () => {
  const root = await createTaskExtended("human thread", {
    agentId: leadId,
    requestedByUserId: userId,
    contextKey: `task:${crypto.randomUUID()}`,
  });
  const coder = await createTaskExtended("code", {
    agentId: workerId,
    parentTaskId: root.id,
    routingAffinity: { capabilities: ["codigo"], leadOnly: false },
  });
  const reviewer = await createTaskExtended("review", {
    agentId: workerId,
    parentTaskId: coder.id,
    routingAffinity: { capabilities: ["revision"], leadOnly: false },
  });
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "new human reply", parentTaskId: reviewer.id }),
  });
  const body = await response.json();
  expect(response.status).toBe(201);
  expect(body.agentId).toBe(leadId);
  expect(body.parentTaskId).toBe(reviewer.id);
  expect(body.contextKey).toBe(root.contextKey);
  expect(body.requestedByUserId).toBe(userId);
  expect(body.routingAffinity.capabilities).toEqual([]);
});

test("Slack human ingress after worker work reaches Lead without worker requirements", async () => {
  const parent = await createTaskExtended("Slack worker review", {
    agentId: workerId,
    requestedByUserId: userId,
    contextKey: `task:${crypto.randomUUID()}`,
    routingAffinity: { capabilities: ["revision"], leadOnly: false },
  });
  const { task } = await createSlackTaskWithFiles(
    "new Slack human reply",
    { agentId: leadId, parentTaskId: parent.id, source: "slack", requestedByUserId: userId },
    { files: [], fetched: [], failed: [], async [Symbol.asyncDispose]() {} },
  );
  expect(task.agentId).toBe(leadId);
  expect(task.parentTaskId).toBe(parent.id);
  expect(task.contextKey).toBe(parent.contextKey);
  expect(task.requestedByUserId).toBe(userId);
  expect(task.routingAffinity?.capabilities).toEqual([]);
});

test("human reply preserves Lead-only capability requirements and returns a clear 403", async () => {
  const parent = await createTaskExtended("privileged task", {
    requestedByUserId: userId,
    routingAffinity: { capabilities: ["merge"], leadOnly: true },
  });
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "new reply", parentTaskId: parent.id }),
  });
  const body = await response.json();
  expect(response.status).toBe(403);
  expect(body.error).toContain("Lead-only task routing affinity does not authorize");
});

test("human can choose another worker without inheriting the previous worker requirements", async () => {
  const target = await createAgent({ name: "Other worker", status: "idle", isLead: false });
  const parent = await createTaskExtended("previous worker work", {
    requestedByUserId: userId,
    routingAffinity: { capabilities: ["codigo"], leadOnly: false },
  });
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: "different work",
      parentTaskId: parent.id,
      agentId: target.id,
      routingReason: "human_pinned",
    }),
  });
  expect(response.status).toBe(201);
  expect((await response.json()).agentId).toBe(target.id);
});

test("agent using shared operator key cannot masquerade as a human reply", async () => {
  const parent = await createTaskExtended("worker continuation", {
    agentId: workerId,
    requestedByUserId: userId,
    routingAffinity: { capabilities: ["revision"], leadOnly: false },
  });
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-ID": workerId },
    body: JSON.stringify({
      task: "agent continuation",
      parentTaskId: parent.id,
      source: "ui",
      requestedByUserId: userId,
    }),
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error).toContain("Task routing affinity does not authorize");
});
