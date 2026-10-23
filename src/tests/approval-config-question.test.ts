/**
 * HITL `config` questions: create-time rules on every path, the answer path
 * that writes swarm_config, and a sentinel regression test proving a secret's
 * plaintext never lands anywhere except the encrypted swarm_config row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";

const slackPayloads: unknown[] = [];
const postMessage = mock(async (args: Record<string, unknown>) => {
  slackPayloads.push(args);
  return { ts: "1700000000.000100" };
});
const conversationsInfo = mock(async (_args: { channel: string }) => ({
  channel: { is_ext_shared: false },
}));
mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: { chat: { postMessage }, conversations: { info: conversationsInfo } },
  }),
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decryptSecret, getEncryptionKey } from "../be/crypto";
import * as db from "../be/db";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  createWorkflow,
  getApprovalRequestById,
  getDbClient,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { isSealedJson, openSealedJson } from "../be/sealed-json";
import { type IdentityActor, mintToken } from "../be/users";
import { handleApprovalRequests } from "../http/approval-requests";
import { resolveHttpRequestAuth } from "../http/auth";
import * as core from "../http/core";
import { resetExternalChannelStateForTesting } from "../slack/external-channel";
import { registerRequestHumanInputTool } from "../tools/request-human-input";
import type { WorkflowDefinition } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { startWorkflowExecution } from "../workflows/engine";
import { InProcessEventBus, workflowEventBus } from "../workflows/event-bus";
import type { ExecutorDependencies } from "../workflows/executors/base";
import { HumanInTheLoopExecutor } from "../workflows/executors/human-in-the-loop";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-approval-config-question.sqlite";
const API_KEY = "approval-config-question-test-key";

let server: Server;
let baseUrl = "";
let workerId = "";
let leadId = "";
let toolHandler: (args: unknown, extra: unknown) => Promise<Record<string, any>>;
const resolvedEvents: unknown[] = [];
const reloadSpy = spyOn(core, "scheduleIntegrationsReload").mockImplementation(() => {});

const uniqueKey = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const operator = { Authorization: `Bearer ${API_KEY}` };

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = operator,
): Promise<{ status: number; text: string; json: Record<string, any> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, any> };
}

function createRequest(body: Record<string, unknown>) {
  // Slack notifications need a lead caller.
  const headers = body.notifications ? { ...operator, "X-Agent-ID": leadId } : operator;
  return api(
    "POST",
    "/api/approval-requests",
    { title: "Set up Bitbucket", approvers: { policy: "any" }, ...body },
    headers,
  );
}

async function createConfigRequest(
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  questionExtra: Record<string, unknown> = {},
): Promise<string> {
  const res = await createRequest({
    questions: [{ id: "cfg", type: "config", config, ...questionExtra }],
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.json.approvalRequest.id as string;
}

function respond(id: string, responses: Record<string, unknown>, headers = operator) {
  return api("POST", `/api/approval-requests/${id}/respond`, { responses }, headers);
}

async function configRow(key: string) {
  return getDbClient().get<{
    value: string;
    isSecret: number;
    encrypted: number;
    lastUpdatedAt: string;
    envPath: string | null;
    description: string | null;
  }>("SELECT * FROM swarm_config WHERE key = ?", [key]);
}

/**
 * Every value in every column of every table, cast to text, plus the opened
 * form of sealed replay columns. Returns `table.column` for each hit.
 */
async function scanDatabase(needles: string[]): Promise<{ hits: string[]; columns: number }> {
  const client = getDbClient();
  const tables = await client.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const hits = new Set<string>();
  let columns = 0;
  for (const { name: table } of tables) {
    let cols: { name: string }[];
    try {
      cols = await client.query<{ name: string }>("SELECT name FROM pragma_table_info(?)", [table]);
    } catch {
      continue;
    }
    for (const { name: column } of cols) {
      let rows: { v: string | null }[];
      try {
        rows = await client.query<{ v: string | null }>(
          `SELECT CAST("${column}" AS TEXT) AS v FROM "${table}" WHERE "${column}" IS NOT NULL`,
        );
      } catch {
        continue;
      }
      columns++;
      for (const { v } of rows) {
        if (!v) continue;
        const views = [v];
        if (isSealedJson(v)) views.push(JSON.stringify(openSealedJson(v)));
        if (views.some((view) => needles.some((needle) => view.includes(needle)))) {
          hits.add(`${table}.${column}`);
        }
      }
    }
  }
  return { hits: [...hits].sort(), columns };
}

async function followUpTasks(sourceTaskId: string) {
  return getDbClient().query<Record<string, unknown>>(
    "SELECT * FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'hitl-follow-up'",
    [sourceTaskId],
  );
}

async function sourceTask(): Promise<string> {
  const task = await createTaskExtended("configure bitbucket", {
    agentId: workerId,
    source: "mcp",
  });
  return task.id;
}

function callTool(args: Record<string, unknown>, agentId = workerId) {
  return toolHandler(args, {
    sessionId: "approval-config-question",
    requestInfo: { headers: { "x-agent-id": agentId } },
  });
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
  initDb(TEST_DB_PATH);
  workerId = crypto.randomUUID();
  await createAgent({ id: workerId, name: "config-worker", isLead: false, status: "idle" });
  leadId = crypto.randomUUID();
  await createAgent({ id: leadId, name: "config-lead", isLead: true, status: "idle" });

  const mcp = new McpServer({ name: "approval-config-question", version: "1.0.0" });
  registerRequestHumanInputTool(mcp);
  toolHandler = (mcp as unknown as { _registeredTools: Record<string, { handler: any }> })
    ._registeredTools["request-human-input"]!.handler;

  workflowEventBus.on("approval.resolved", (payload) => resolvedEvents.push(payload));

  server = createServer(async (req, res) => {
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
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  reloadSpy.mockRestore();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
});

beforeEach(() => {
  resetExternalChannelStateForTesting();
});

describe("create", () => {
  test("tool: a secret question defaults isSecret to true and label to the key", async () => {
    const key = uniqueKey("BITBUCKET_TOKEN");
    const out = await callTool({
      title: "Bitbucket",
      questions: [{ id: "bb", type: "config", config: { key, scope: "global" } }],
    });
    expect(out.isError).not.toBe(true);
    const stored = await getApprovalRequestById(out.structuredContent.requestId);
    const [question] = stored!.questions as Record<string, any>[];
    expect(question!.label).toBe(key);
    expect(question!.required).toBe(true);
    expect(question!.config.isSecret).toBe(true);
  });

  test("tool: agent scope defaults scopeId to the calling agent", async () => {
    const key = uniqueKey("AGENT_SCOPED");
    const out = await callTool({
      title: "Agent key",
      questions: [{ id: "a", type: "config", config: { key, scope: "agent", isSecret: false } }],
    });
    expect(out.isError).not.toBe(true);
    const stored = await getApprovalRequestById(out.structuredContent.requestId);
    expect((stored!.questions as Record<string, any>[])[0]!.config.scopeId).toBe(workerId);
  });

  test("tool: reserved and internal keys are refused", async () => {
    for (const key of ["API_KEY", "runtime_owner_id"]) {
      const out = await callTool({
        title: "Bad",
        questions: [{ id: "k", type: "config", config: { key, scope: "global" } }],
      });
      expect(out.isError).toBe(true);
      expect(JSON.stringify(out.content)).toContain(key);
    }
  });

  test("tool: options on a secret are refused", async () => {
    const out = await callTool({
      title: "Bad",
      questions: [
        {
          id: "k",
          type: "config",
          config: {
            key: uniqueKey("SECRET"),
            scope: "global",
            options: [{ value: "a", label: "A" }],
          },
        },
      ],
    });
    expect(out.isError).toBe(true);
  });

  test("tool: isSecret false over an existing secret row stores true", async () => {
    const key = uniqueKey("ALREADY_SECRET");
    await upsertSwarmConfig({ scope: "global", key, value: "x", isSecret: true });
    const out = await callTool({
      title: "Plain?",
      questions: [{ id: "k", type: "config", config: { key, scope: "global", isSecret: false } }],
    });
    expect(out.isError).not.toBe(true);
    const stored = await getApprovalRequestById(out.structuredContent.requestId);
    expect((stored!.questions as Record<string, any>[])[0]!.config.isSecret).toBe(true);
  });

  test("REST: valid question is 201; reserved key and non-any policy are 400", async () => {
    const ok = await createRequest({
      questions: [{ id: "cfg", type: "config", config: { key: uniqueKey("OK"), scope: "global" } }],
    });
    expect(ok.status).toBe(201);
    expect(ok.json.approvalRequest.questions[0].label).toMatch(/^OK_/);

    const reserved = await createRequest({
      questions: [{ id: "cfg", type: "config", config: { key: "API_KEY", scope: "global" } }],
    });
    expect(reserved.status).toBe(400);
    expect(reserved.text).toContain("API_KEY");
    expect(reserved.text).toContain("reserved");

    const all = await createRequest({
      approvers: { policy: "all" },
      questions: [
        { id: "cfg", type: "config", config: { key: uniqueKey("ALL"), scope: "global" } },
      ],
    });
    expect(all.status).toBe(400);
    expect(all.text).toContain("approvers.policy");
  });

  test("REST: a non-config question still needs a label", async () => {
    const res = await createRequest({ questions: [{ id: "t", type: "text" }] });
    expect(res.status).toBe(400);
    expect(res.text).toContain("label is required");
  });

  test("executor: a bad config question fails the node", async () => {
    const registry = makeRegistry();
    const workflow = await createWorkflow({
      name: `hitl-config-bad-${crypto.randomUUID()}`,
      definition: {
        nodes: [
          {
            id: "card",
            type: "human-in-the-loop",
            config: {
              title: "Bad",
              questions: [{ id: "k", type: "config", config: { key: "API_KEY", scope: "global" } }],
              approvers: { policy: "any" },
            },
          },
        ],
      } satisfies WorkflowDefinition,
    });
    const runId = await startWorkflowExecution(workflow, {}, registry);
    const run = await getWorkflowRun(runId);
    expect(run!.status).toBe("failed");
    const [step] = await getWorkflowRunStepsByRunId(runId);
    expect(step!.error).toContain("reserved");
  });
});

describe("respond", () => {
  test("keep on an existing row writes nothing and reports its updatedAt", async () => {
    const key = uniqueKey("KEEP_ME");
    const row = await upsertSwarmConfig({ scope: "global", key, value: "old", isSecret: true });
    const id = await createConfigRequest({ key, scope: "global" });

    const get = await api("GET", `/api/approval-requests/${id}`);
    expect(get.json.approvalRequest.configState.cfg).toEqual({
      exists: true,
      isSecret: true,
      updatedAt: row.lastUpdatedAt,
    });

    const res = await respond(id, { cfg: { action: "keep" } });
    expect(res.status).toBe(200);
    expect(res.json.approvalRequest.responses.cfg).toEqual({
      key,
      scope: "global",
      scopeId: null,
      isSecret: true,
      status: "kept",
      updatedAt: row.lastUpdatedAt,
    });
    expect((await configRow(key))!.lastUpdatedAt).toBe(row.lastUpdatedAt);
  });

  test("keep with no row is 400", async () => {
    const id = await createConfigRequest({ key: uniqueKey("MISSING"), scope: "global" });
    const res = await respond(id, { cfg: { action: "keep" } });
    expect(res.status).toBe(400);
    expect(res.text).toContain("not set");
  });

  test("skip is 400 on a required question and skipped on an optional one", async () => {
    const required = await createConfigRequest({ key: uniqueKey("REQ"), scope: "global" });
    expect((await respond(required, { cfg: { action: "skip" } })).status).toBe(400);

    const key = uniqueKey("OPT");
    const optional = await createConfigRequest({ key, scope: "global" }, {}, { required: false });
    const res = await respond(optional, { cfg: { action: "skip" } });
    expect(res.status).toBe(200);
    expect(res.json.approvalRequest.responses.cfg.status).toBe("skipped");
    expect(await configRow(key)).toBeNull();
  });

  test("a rejection writes nothing and skips the config question", async () => {
    const key = uniqueKey("REJECTED");
    const res = await createRequest({
      questions: [
        { id: "ok", type: "approval", label: "Go?", required: true },
        { id: "cfg", type: "config", config: { key, scope: "global" } },
      ],
    });
    const value = `hitl-rejected-${crypto.randomUUID()}`;
    const answered = await respond(res.json.approvalRequest.id, {
      ok: { approved: false },
      cfg: { action: "set", value },
    });
    expect(answered.status).toBe(200);
    expect(answered.json.approvalRequest.status).toBe("rejected");
    expect(answered.json.approvalRequest.responses.cfg.status).toBe("skipped");
    expect(answered.text).not.toContain(value);
    expect(await configRow(key)).toBeNull();
  });

  test("a secret that fails the key's validator is 400 without echoing the value", async () => {
    const id = await createConfigRequest({ key: "DB_RETENTION_TICK_BUDGET_MS", scope: "global" });
    const value = `hitl-invalid-${crypto.randomUUID()}`;
    const res = await respond(id, { cfg: { action: "set", value } });
    expect(res.status).toBe(400);
    expect(res.text).toContain("DB_RETENTION_TICK_BUDGET_MS validation");
    expect(res.text).not.toContain(value);
    expect(await configRow("DB_RETENTION_TICK_BUDGET_MS")).toBeNull();
  });

  test("a plain key with options returns its value and shows it in configState", async () => {
    const key = uniqueKey("REGION");
    const id = await createConfigRequest({
      key,
      scope: "global",
      isSecret: false,
      options: [
        { value: "eu", label: "Europe" },
        { value: "us", label: "United States" },
      ],
      defaultValue: "eu",
    });
    expect((await respond(id, { cfg: { action: "set", value: "mars" } })).status).toBe(400);

    reloadSpy.mockClear();
    const res = await respond(id, { cfg: { action: "set", value: "us" } });
    expect(res.status).toBe(200);
    expect(res.json.approvalRequest.responses.cfg).toMatchObject({
      key,
      isSecret: false,
      status: "set",
      value: "us",
    });
    expect(res.json.approvalRequest.configState.cfg).toMatchObject({
      exists: true,
      isSecret: false,
      value: "us",
    });
    const row = await configRow(key);
    expect(row).toMatchObject({ value: "us", isSecret: 0, encrypted: 0 });
    // The global write schedules one integrations reload, after commit.
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  test("set keeps the row's envPath and description", async () => {
    const key = uniqueKey("CARRY");
    await upsertSwarmConfig({
      scope: "global",
      key,
      value: "old",
      isSecret: false,
      description: "kept description",
    });
    const id = await createConfigRequest({ key, scope: "global", isSecret: false });
    expect((await respond(id, { cfg: { action: "set", value: "new" } })).status).toBe(200);
    expect(await configRow(key)).toMatchObject({ value: "new", description: "kept description" });
  });

  test("an API-only key is treated as secret even when stored plain", async () => {
    const key = "TRANSCRIPTION_API_KEY";
    const stored = `hitl-api-only-${crypto.randomUUID()}`;
    await upsertSwarmConfig({ scope: "global", key, value: stored, isSecret: false });
    const created = await createRequest({
      questions: [{ id: "cfg", type: "config", config: { key, scope: "global", isSecret: false } }],
    });
    expect(created.status).toBe(201);
    expect(created.json.approvalRequest.questions[0].config.isSecret).toBe(true);
    const id = created.json.approvalRequest.id as string;

    const get = await api("GET", `/api/approval-requests/${id}`);
    expect(get.json.approvalRequest.configState.cfg.isSecret).toBe(true);
    expect(get.text).not.toContain(stored);

    const kept = await respond(id, { cfg: { action: "keep" } });
    expect(kept.status).toBe(200);
    expect(kept.json.approvalRequest.responses.cfg).not.toHaveProperty("value");
    expect(kept.text).not.toContain(stored);
  });

  test("a user without config.write.any cannot set, one with it can", async () => {
    const key = uniqueKey("USER_GRANT");
    const id = await createConfigRequest({ key, scope: "global" });
    const roleId = `approver-${crypto.randomUUID()}`;
    await getDbClient().run(
      "INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES (?, ?, '', 0, 0)",
      [roleId, roleId],
    );
    await getDbClient().run("INSERT INTO role_permissions (roleId, verb) VALUES (?, ?)", [
      roleId,
      "approval.respond",
    ]);
    const approver = await createUser({ name: "Approver only" });
    // New users start as admin (rbac-roles insert trigger); narrow this one.
    await getDbClient().run("DELETE FROM principal_roles WHERE principalId = ?", [approver.id]);
    await getDbClient().run(
      "INSERT INTO principal_roles (principalType, principalId, roleId) VALUES ('user', ?, ?)",
      [approver.id, roleId],
    );
    const actor: IdentityActor = { kind: "operator", id: "approval-config-question-test" };
    const approverToken = (await mintToken(approver.id, "approver", actor)).plaintext;

    const denied = await respond(
      id,
      { cfg: { action: "set", value: "nope" } },
      { Authorization: `Bearer ${approverToken}` },
    );
    expect(denied.status).toBe(403);
    expect(await configRow(key)).toBeNull();
    expect((await getApprovalRequestById(id))!.status).toBe("pending");

    const admin = await createUser({ name: "Config admin" });
    const adminToken = (await mintToken(admin.id, "admin", actor)).plaintext;
    const allowed = await respond(
      id,
      { cfg: { action: "set", value: "yes" } },
      { Authorization: `Bearer ${adminToken}` },
    );
    expect(allowed.status).toBe(200);
    expect(await configRow(key)).not.toBeNull();
  });

  test("an agent cannot answer a config question", async () => {
    const key = uniqueKey("AGENT_DENIED");
    const id = await createConfigRequest({ key, scope: "global" });
    const res = await respond(
      id,
      { cfg: { action: "set", value: "nope" } },
      { ...operator, "X-Agent-ID": workerId },
    );
    expect(res.status).toBe(403);
    expect(await configRow(key)).toBeNull();
    expect((await getApprovalRequestById(id))!.status).toBe("pending");
  });
});

function makeRegistry(): ExecutorRegistry {
  const deps: ExecutorDependencies = {
    db: db as typeof import("../be/db"),
    eventBus: new InProcessEventBus(),
    interpolate: (t: string) => t,
  };
  const registry = new ExecutorRegistry();
  registry.register(new HumanInTheLoopExecutor(deps));
  return registry;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting");
}

describe("no plaintext egress", () => {
  test("standalone: the secret reaches only the encrypted swarm_config row", async () => {
    const SENTINEL = `hitl-sentinel-${crypto.randomUUID()}`;
    const key = uniqueKey("BITBUCKET_TOKEN");
    const redaction = `[REDACTED:config:${key}]`;
    const taskId = await sourceTask();
    slackPayloads.length = 0;
    resolvedEvents.length = 0;

    const id = await createConfigRequest(
      { key, scope: "global" },
      { sourceTaskId: taskId, notifications: [{ channel: "slack", target: "C_CONFIG" }] },
    );
    await waitFor(async () => slackPayloads.length > 0);

    const res = await respond(id, { cfg: { action: "set", value: SENTINEL } });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SENTINEL);
    expect(res.json.approvalRequest.responses.cfg).toMatchObject({
      key,
      isSecret: true,
      status: "set",
    });
    expect(res.json.approvalRequest.responses.cfg.value).toBeUndefined();
    expect(res.json.approvalRequest.configState.cfg).not.toHaveProperty("value");

    // 1. Opened responses and the vote.
    const stored = await getApprovalRequestById(id);
    const storedJson = JSON.stringify(stored);
    expect(storedJson).not.toContain(SENTINEL);
    expect(storedJson).not.toContain(redaction);

    // 2. Slack card and the approval.resolved payload (the extension bridge
    // and workflow resume both consume this event).
    expect(JSON.stringify(slackPayloads)).not.toContain(SENTINEL);
    expect(JSON.stringify(slackPayloads)).toContain("(set on dashboard)");
    expect(resolvedEvents.length).toBe(1);
    expect(JSON.stringify(resolvedEvents)).not.toContain(SENTINEL);
    expect(JSON.stringify(resolvedEvents)).not.toContain(redaction);

    // 3. The follow-up task carries the result line only.
    const followUps = await followUpTasks(taskId);
    expect(followUps.length).toBe(1);
    const followUpJson = JSON.stringify(followUps);
    expect(followUpJson).not.toContain(SENTINEL);
    expect(followUpJson).toContain(`${key} (global, secret): set, updated `);

    // 4. Every column of every table, sealed columns opened.
    const scan = await scanDatabase([SENTINEL, redaction]);
    expect(scan.columns).toBeGreaterThan(100);
    expect(scan.hits).toEqual([]);

    // 5. Stored encrypted, decrypts to the answer.
    const row = await configRow(key);
    expect(row).toMatchObject({ isSecret: 1, encrypted: 1 });
    expect(row!.value).not.toBe(SENTINEL);
    expect(decryptSecret(row!.value, getEncryptionKey())).toBe(SENTINEL);
  });

  test("positive control: the same checks find a text answer", async () => {
    const SENTINEL2 = `hitl-control-${crypto.randomUUID()}`;
    const taskId = await sourceTask();
    const res = await createRequest({
      sourceTaskId: taskId,
      questions: [{ id: "note", type: "text", label: "Note", required: true }],
    });
    const answered = await respond(res.json.approvalRequest.id, { note: SENTINEL2 });
    expect(answered.status).toBe(200);

    const stored = await getApprovalRequestById(res.json.approvalRequest.id);
    expect(JSON.stringify(stored!.responses)).toContain(SENTINEL2);
    expect(JSON.stringify(await followUpTasks(taskId))).toContain(SENTINEL2);
    const scan = await scanDatabase([SENTINEL2]);
    expect(scan.hits).toContain("approval_requests.responses");
    expect(scan.hits).toContain("agent_tasks.task");
  });

  test("workflow: step output and run context carry only the result", async () => {
    const SENTINEL = `hitl-sentinel-wf-${crypto.randomUUID()}`;
    const key = uniqueKey("WF_TOKEN");
    const registry = makeRegistry();
    const unsubscribe = setupWorkflowResumeListener(workflowEventBus, registry);
    try {
      const workflow = await createWorkflow({
        name: `hitl-config-${crypto.randomUUID()}`,
        definition: {
          nodes: [
            {
              id: "card",
              type: "human-in-the-loop",
              config: {
                title: "Token",
                questions: [{ id: "cfg", type: "config", config: { key, scope: "global" } }],
                approvers: { policy: "any" },
              },
            },
          ],
        } satisfies WorkflowDefinition,
      });
      const runId = await startWorkflowExecution(workflow, {}, registry);
      const [waiting] = await getWorkflowRunStepsByRunId(runId);
      expect(waiting!.status).toBe("waiting");
      const request = await db.getApprovalRequestByStepId(waiting!.id);

      const res = await respond(request!.id, { cfg: { action: "set", value: SENTINEL } });
      expect(res.status).toBe(200);
      await waitFor(async () => (await getWorkflowRun(runId))!.status === "completed");

      const [step] = await getWorkflowRunStepsByRunId(runId);
      const output = step!.output as { responses: Record<string, unknown> };
      expect(output.responses.cfg).toEqual(res.json.approvalRequest.responses.cfg);
      expect(JSON.stringify(step)).not.toContain(SENTINEL);
      expect(JSON.stringify(await getWorkflowRun(runId))).not.toContain(SENTINEL);

      const scan = await scanDatabase([SENTINEL, `[REDACTED:config:${key}]`]);
      expect(scan.hits).toEqual([]);
      const row = await configRow(key);
      expect(decryptSecret(row!.value, getEncryptionKey())).toBe(SENTINEL);
    } finally {
      unsubscribe();
    }
  });
});
