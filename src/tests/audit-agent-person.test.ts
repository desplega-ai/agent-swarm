/**
 * Who created / last updated a script, skill, workflow or schedule: both the
 * agent (`createdByAgentId` / `updatedByAgentId`) and the person
 * (`created_by` / `updated_by`, resolved from the caller's own source task).
 *
 * One test per write-path family and model: MCP tools, HTTP routes, the inline
 * script-run scratch auto-save, and `ctx.swarm` calls made from inside a
 * script. A creator (agent A, task requested by user A) writes first; a second
 * agent (agent B, task requested by user B) updates, so a create-time value
 * that leaked into the update columns would fail. The negative control names
 * another agent's task in X-Source-Task-Id and must leave the person NULL.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getScheduledTaskById,
  getSkillById,
  getTaskById,
  getWorkflow,
  initDb,
} from "../be/db";
import { getScript } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handleKv } from "../http/kv";
import { handleMcpBridge } from "../http/mcp-bridge";
import { handleSchedules } from "../http/schedules";
import { handleScripts } from "../http/scripts";
import { handleSkills } from "../http/skills";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";
import { registerCreateScheduleTool } from "../tools/schedules/create-schedule";
import { registerPatchScheduleTool } from "../tools/schedules/patch-schedule";
import { registerUpdateScheduleTool } from "../tools/schedules/update-schedule";
import { registerSkillCreateTool } from "../tools/skills/skill-create";
import { registerSkillInstallRemoteTool } from "../tools/skills/skill-install-remote";
import { registerSkillSyncRemoteTool } from "../tools/skills/skill-sync-remote";
import { registerSkillUpdateTool } from "../tools/skills/skill-update";
import { registerCreateWorkflowTool } from "../tools/workflows/create-workflow";
import { registerPatchWorkflowTool } from "../tools/workflows/patch-workflow";
import { registerPatchWorkflowNodeTool } from "../tools/workflows/patch-workflow-node";
import { registerUpdateWorkflowTool } from "../tools/workflows/update-workflow";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { listenOnFreePort } from "./test-net";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

const TEST_DB_PATH = "./test-audit-agent-person.sqlite";
const API_KEY = "example-test-audit-agent-person-key-1234567890";
const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

const fakeEmbeddingProvider = {
  name: "test/fake-audit-embedding",
  dimensions: 4,
  async embed() {
    return new Float32Array([1, 0, 0, 0]);
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => new Float32Array([1, 0, 0, 0]));
  },
};

type Table = "scripts" | "skills" | "workflows" | "scheduled_tasks";
type AuditRow = {
  createdByAgentId: string | null;
  updatedByAgentId: string | null;
  created_by: string | null;
  updated_by: string | null;
};

let agentA: string;
let agentB: string;
let userA: string;
let userB: string;
let taskA: string;
let taskB: string;
let bridgeServer: Server;
let bridgeUrl = "";
let savedEnv: NodeJS.ProcessEnv;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}

async function auditRow(table: Table, id: string): Promise<AuditRow> {
  const row = await getDbClient().get<AuditRow>(
    `SELECT createdByAgentId, updatedByAgentId, created_by, updated_by FROM ${table} WHERE id = ?`,
    [id],
  );
  if (!row) throw new Error(`${table} row ${id} not found`);
  return row;
}

/** Created by agent A for user A, and (when `updated`) last updated by agent B for user B. */
function expectAudit(row: AuditRow, opts: { updated: boolean }) {
  expect(row.createdByAgentId).toBe(agentA);
  expect(row.created_by).toBe(userA);
  expect(row.updatedByAgentId).toBe(opts.updated ? agentB : agentA);
  expect(row.updated_by).toBe(opts.updated ? userB : userA);
}

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> };

function toolServer(...registrars: ((server: McpServer) => void)[]): McpServer {
  const server = new McpServer({ name: "audit-agent-person", version: "1.0.0" });
  for (const register of registrars) register(server);
  return server;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
  agentId: string,
  sourceTaskId: string,
): Promise<Record<string, unknown>> {
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools[name];
  if (!tool) throw new Error(`${name} not registered`);
  const result = await tool.handler(args, {
    sessionId: "audit-session",
    requestInfo: { headers: { "x-agent-id": agentId, "x-source-task-id": sourceTaskId } },
  });
  const structured = result.structuredContent as Record<string, unknown>;
  // Whole-object match so a refusal prints its message.
  expect(structured).toMatchObject({ success: true });
  return structured;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  agentId: string | undefined,
) => Promise<boolean>;

async function http(
  handler: Handler,
  method: string,
  path: string,
  body: unknown,
  agentId: string,
  sourceTaskId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = {
    "x-agent-id": agentId,
    "x-source-task-id": sourceTaskId,
    "content-type": "application/json",
  };
  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  const handled = await handler(req, res, getPathSegments(path), parseQueryParams(path), agentId);
  expect(handled).toBe(true);
  return { status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** The SDK a script gets as `ctx.swarm`, acting for `sourceTaskId` (none when omitted). */
function scriptSdk(agentId: string, sourceTaskId?: string) {
  return createSwarmSdk(
    new SwarmConfig({
      system: {
        apiKey: { value: API_KEY, isSecret: true },
        agentId: { value: agentId, isSecret: false },
        mcpBaseUrl: { value: bridgeUrl, isSecret: false },
        ...(sourceTaskId
          ? { auditSourceTaskId: { value: sourceTaskId, isSecret: false as const } }
          : {}),
      },
      user: {},
    }),
  );
}

const unique = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const skillContent = (name: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: Audit test skill\n---\n${body}\n`;
const WORKFLOW_DEFINITION = {
  nodes: [{ id: "n1", type: "notify", config: { channel: "swarm", template: "hello" } }],
};

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  setScriptEmbeddingProviderForTests(fakeEmbeddingProvider);

  // Leads, so both may write global scripts and swarm-scope skills.
  agentA = (await createAgent({ name: "audit-agent-a", isLead: true, status: "idle" })).id;
  agentB = (await createAgent({ name: "audit-agent-b", isLead: true, status: "idle" })).id;
  userA = (await createUser({ name: "Audit User A", email: "audit-a@example.com" })).id;
  userB = (await createUser({ name: "Audit User B", email: "audit-b@example.com" })).id;
  taskA = (await createTaskExtended("audit task A", { agentId: agentA, requestedByUserId: userA }))
    .id;
  taskB = (await createTaskExtended("audit task B", { agentId: agentB, requestedByUserId: userB }))
    .id;

  bridgeServer = createHttpServer(async (req, res) => {
    const agentId = req.headers["x-agent-id"] as string | undefined;
    const segments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    // The SDK reaches some tools through their REST route, others through the bridge.
    for (const handler of [
      handleMcpBridge,
      handleWorkflows,
      handleSchedules,
      handleSkills,
      handleKv,
    ]) {
      if (await handler(req, res, segments, query, agentId)) return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  bridgeUrl = `http://localhost:${await listenOnFreePort(bridgeServer)}`;
  process.env.MCP_BASE_URL = bridgeUrl;
});

afterAll(async () => {
  await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
  closeDb();
  setScriptEmbeddingProviderForTests(null);
  await removeDbFiles();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

// ─── Scripts ────────────────────────────────────────────────────────────────

describe("scripts audit", () => {
  const source = (n: number) => `export default async () => ${n};`;

  test("HTTP upsert: create and a later update by another agent", async () => {
    const name = unique("audit-script");
    const created = await http(
      handleScripts,
      "POST",
      "/api/scripts/upsert",
      { name, source: source(1), scope: "global" },
      agentA,
      taskA,
    );
    expect(created.status).toBe(200);
    const script = await getScript({ name, scope: "global" });
    expectAudit(await auditRow("scripts", script!.id), { updated: false });

    await http(
      handleScripts,
      "POST",
      "/api/scripts/upsert",
      { name, source: source(2), scope: "global" },
      agentB,
      taskB,
    );
    expectAudit(await auditRow("scripts", script!.id), { updated: true });

    // The four fields ride the get and list responses.
    const detail = await http(
      handleScripts,
      "GET",
      `/api/scripts/${script!.id}`,
      undefined,
      agentA,
      taskA,
    );
    expect(detail.json.script).toMatchObject({
      createdByAgentId: agentA,
      updatedByAgentId: agentB,
      createdBy: userA,
      updatedBy: userB,
    });
    const list = await http(
      handleScripts,
      "GET",
      "/api/scripts?scope=global",
      undefined,
      agentA,
      taskA,
    );
    expect((list.json.scripts as { id: string }[]).find((s) => s.id === script!.id)).toMatchObject({
      createdByAgentId: agentA,
      updatedByAgentId: agentB,
      createdBy: userA,
      updatedBy: userB,
    });
  });

  test("negative control: another agent's source task leaves the person NULL", async () => {
    const name = unique("audit-script-foreign");
    await http(
      handleScripts,
      "POST",
      "/api/scripts/upsert",
      { name, source: source(3), scope: "global" },
      agentA,
      taskB,
    );
    const row = await auditRow("scripts", (await getScript({ name, scope: "global" }))!.id);
    expect(row.createdByAgentId).toBe(agentA);
    expect(row.created_by).toBeNull();
    expect(row.updated_by).toBeNull();
  });

  spawnTest(
    "inline run: the scratch auto-save and the run's ctx.swarm writes carry the person",
    async () => {
      const scheduleName = unique("audit-ctx-run-schedule");
      const run = await http(
        handleScripts,
        "POST",
        "/api/scripts/run",
        {
          intent: unique("audit scratch"),
          source: `export default async (_args: unknown, ctx: any) => {
            const r = await ctx.swarm.schedule_create({
              name: "${scheduleName}", intervalMs: 3600000, taskTemplate: "audit",
            });
            return r.success;
          };`,
        },
        agentA,
        taskA,
      );
      expect(run.status).toBe(200);
      expect(run.json).toMatchObject({ result: true });
      const slug = (run.json.autoSaved as { slug: string }).slug;
      const scratch = await getScript({ name: slug, scope: "agent", scopeId: agentA });
      expectAudit(await auditRow("scripts", scratch!.id), { updated: false });

      // The run request's task travelled into the script's SDK call (audit header).
      const scheduleId = (
        await getDbClient().get<{ id: string }>("SELECT id FROM scheduled_tasks WHERE name = ?", [
          scheduleName,
        ])
      )?.id;
      expectAudit(await auditRow("scheduled_tasks", scheduleId!), { updated: false });
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

// ─── Workflows ──────────────────────────────────────────────────────────────

describe("workflows audit", () => {
  const tools = () =>
    toolServer(
      registerCreateWorkflowTool,
      registerUpdateWorkflowTool,
      registerPatchWorkflowTool,
      registerPatchWorkflowNodeTool,
    );

  async function createViaTool(): Promise<string> {
    const out = await callTool(
      tools(),
      "create-workflow",
      { name: unique("audit-wf"), definition: WORKFLOW_DEFINITION },
      agentA,
      taskA,
    );
    return (out.workflow as { id: string }).id;
  }

  test("MCP create-workflow, then update / patch / node-patch by another agent", async () => {
    const updates: [string, (id: string) => Record<string, unknown>][] = [
      ["update-workflow", (id) => ({ id, description: "updated" })],
      [
        "patch-workflow",
        (id) => ({
          id,
          update: [{ nodeId: "n1", node: { config: { channel: "swarm", template: "p" } } }],
        }),
      ],
      [
        "patch-workflow-node",
        (id) => ({ id, nodeId: "n1", config: { channel: "swarm", template: "q" } }),
      ],
    ];
    for (const [tool, args] of updates) {
      const id = await createViaTool();
      expectAudit(await auditRow("workflows", id), { updated: false });
      await callTool(tools(), tool, args(id), agentB, taskB);
      expectAudit(await auditRow("workflows", id), { updated: true });
    }
  });

  test("HTTP create and update, with the fields on get and list", async () => {
    const created = await http(
      handleWorkflows,
      "POST",
      "/api/workflows",
      { name: unique("audit-wf-http"), definition: WORKFLOW_DEFINITION },
      agentA,
      taskA,
    );
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expectAudit(await auditRow("workflows", id), { updated: false });

    const put = await http(
      handleWorkflows,
      "PUT",
      `/api/workflows/${id}`,
      { description: "via http" },
      agentB,
      taskB,
    );
    expect(put.status).toBe(200);
    expectAudit(await auditRow("workflows", id), { updated: true });

    expect(await getWorkflow(id)).toMatchObject({
      createdByAgentId: agentA,
      updatedByAgentId: agentB,
      createdBy: userA,
      updatedBy: userB,
    });
    const list = await http(handleWorkflows, "GET", "/api/workflows", undefined, agentA, taskA);
    expect((list.json as unknown as { id: string }[]).find((w) => w.id === id)).toMatchObject({
      createdByAgentId: agentA,
      updatedByAgentId: agentB,
      createdBy: userA,
      updatedBy: userB,
    });
  });

  test("ctx.swarm workflow_create", async () => {
    const result = (await scriptSdk(agentA, taskA).workflow_create({
      name: unique("audit-wf-sdk"),
      definition: WORKFLOW_DEFINITION,
    })) as { success: boolean; data: { id: string } };
    expect(result).toMatchObject({ success: true });
    expectAudit(await auditRow("workflows", result.data.id), { updated: false });
  });

  test("negative control: another agent's source task leaves the person NULL", async () => {
    const id = await createViaTool();
    await callTool(tools(), "update-workflow", { id, description: "spoof" }, agentA, taskB);
    const row = await auditRow("workflows", id);
    expect(row.updatedByAgentId).toBe(agentA);
    expect(row.updated_by).toBeNull();
  });
});

// ─── Schedules ──────────────────────────────────────────────────────────────

describe("schedules audit", () => {
  const tools = () =>
    toolServer(registerCreateScheduleTool, registerUpdateScheduleTool, registerPatchScheduleTool);

  async function createViaTool(sourceTaskId = taskA): Promise<string> {
    const out = await callTool(
      tools(),
      "create-schedule",
      { name: unique("audit-sched"), intervalMs: 3_600_000, taskTemplate: "audit" },
      agentA,
      sourceTaskId,
    );
    return (out.schedule as { id: string }).id;
  }

  test("MCP create-schedule, then update / patch by another agent", async () => {
    for (const tool of ["update-schedule", "patch-schedule"]) {
      const scheduleId = await createViaTool();
      expectAudit(await auditRow("scheduled_tasks", scheduleId), { updated: false });
      await callTool(tools(), tool, { scheduleId, intervalMs: 7_200_000 }, agentB, taskB);
      expectAudit(await auditRow("scheduled_tasks", scheduleId), { updated: true });
    }
  });

  test("HTTP create and update, with the fields on get", async () => {
    const created = await http(
      handleSchedules,
      "POST",
      "/api/schedules",
      { name: unique("audit-sched-http"), intervalMs: 3_600_000, taskTemplate: "audit" },
      agentA,
      taskA,
    );
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expectAudit(await auditRow("scheduled_tasks", id), { updated: false });

    const put = await http(
      handleSchedules,
      "PUT",
      `/api/schedules/${id}`,
      { description: "via http" },
      agentB,
      taskB,
    );
    expect(put.status).toBe(200);
    expectAudit(await auditRow("scheduled_tasks", id), { updated: true });
    expect(await getScheduledTaskById(id)).toMatchObject({
      createdByAgentId: agentA,
      updatedByAgentId: agentB,
      createdBy: userA,
      updatedBy: userB,
    });
  });

  test("ctx.swarm schedule_create", async () => {
    const result = (await scriptSdk(agentA, taskA).schedule_create({
      name: unique("audit-sched-sdk"),
      intervalMs: 3_600_000,
      taskTemplate: "audit",
    })) as { success: boolean; data: { id: string } };
    expect(result).toMatchObject({ success: true });
    expectAudit(await auditRow("scheduled_tasks", result.data.id), { updated: false });
  });

  test("negative control: another agent's source task leaves the person NULL", async () => {
    const id = await createViaTool(taskB);
    const row = await auditRow("scheduled_tasks", id);
    expect(row.createdByAgentId).toBe(agentA);
    expect(row.created_by).toBeNull();
  });
});

// ─── Skills ─────────────────────────────────────────────────────────────────

describe("skills audit", () => {
  const tools = () =>
    toolServer(
      registerSkillCreateTool,
      registerSkillUpdateTool,
      registerSkillInstallRemoteTool,
      registerSkillSyncRemoteTool,
    );
  const realFetch = globalThis.fetch;

  /** Serve SKILL.md for the remote-skill tools without leaving the process. */
  function stubGithub(content: string) {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://raw.githubusercontent.com/")) return new Response(content);
      return realFetch(input, init);
    }) as typeof fetch;
  }

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  async function createViaTool(sourceTaskId = taskA): Promise<string> {
    const name = unique("audit-skill");
    const out = await callTool(
      tools(),
      "skill-create",
      { content: skillContent(name) },
      agentA,
      sourceTaskId,
    );
    return (out.skill as { id: string }).id;
  }

  test("MCP skill-create, then skill-update by another agent", async () => {
    const skillId = await createViaTool();
    expectAudit(await auditRow("skills", skillId), { updated: false });
    await callTool(tools(), "skill-update", { skillId, isEnabled: false }, agentB, taskB);
    expectAudit(await auditRow("skills", skillId), { updated: true });
    expect(await getSkillById(skillId)).toMatchObject({
      createdByAgentId: agentA,
      updatedByAgentId: agentB,
      createdBy: userA,
      updatedBy: userB,
    });
  });

  test("MCP skill-install-remote, then skill-sync-remote by another agent", async () => {
    const name = unique("audit-remote-skill");
    const repo = `audit-org/${name}`;
    try {
      stubGithub(skillContent(name, "v1"));
      const out = await callTool(
        tools(),
        "skill-install-remote",
        { sourceRepo: repo },
        agentA,
        taskA,
      );
      const skillId = (out.skill as { id: string }).id;
      expectAudit(await auditRow("skills", skillId), { updated: false });

      stubGithub(skillContent(name, "v2"));
      await callTool(tools(), "skill-sync-remote", { skillId }, agentB, taskB);
      expectAudit(await auditRow("skills", skillId), { updated: true });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("HTTP create, update and file upsert, with the fields on get and list", async () => {
    const created = await http(
      handleSkills,
      "POST",
      "/api/skills",
      { content: skillContent(unique("audit-skill-http")) },
      agentA,
      taskA,
    );
    expect(created.status).toBe(201);
    const id = (created.json.skill as { id: string }).id;
    expectAudit(await auditRow("skills", id), { updated: false });

    const put = await http(
      handleSkills,
      "PUT",
      `/api/skills/${id}`,
      { isEnabled: false },
      agentB,
      taskB,
    );
    expect(put.status).toBe(200);
    expectAudit(await auditRow("skills", id), { updated: true });

    // Reset the update pair, then prove a bundled-file write sets it again.
    await getDbClient().run(
      "UPDATE skills SET updated_by = NULL, updatedByAgentId = NULL WHERE id = ?",
      [id],
    );
    const file = await http(
      handleSkills,
      "PUT",
      `/api/skills/${id}/files/notes.md`,
      { content: "notes" },
      agentB,
      taskB,
    );
    expect(file.status).toBe(200);
    expectAudit(await auditRow("skills", id), { updated: true });

    const list = await http(handleSkills, "GET", "/api/skills", undefined, agentA, taskA);
    expect((list.json.skills as { id: string }[]).find((s) => s.id === id)).toMatchObject({
      createdByAgentId: agentA,
      updatedByAgentId: agentB,
      createdBy: userA,
      updatedBy: userB,
    });
  });

  test("ctx.swarm skill_create", async () => {
    const result = (await scriptSdk(agentA, taskA).skill_create({
      content: skillContent(unique("audit-skill-sdk")),
    })) as { success: boolean; data: { skill: { id: string } } };
    expect(result).toMatchObject({ success: true });
    expectAudit(await auditRow("skills", result.data.skill.id), { updated: false });
  });

  test("negative control: another agent's source task leaves the person NULL", async () => {
    const id = await createViaTool(taskB);
    const row = await auditRow("skills", id);
    expect(row.createdByAgentId).toBe(agentA);
    expect(row.created_by).toBeNull();
  });
});

// ─── ctx.swarm task context ─────────────────────────────────────────────────

// The run's task rides X-Audit-Source-Task-Id, which only the audit resolvers
// read. X-Source-Task-Id would also rescope kv and send-task to that task.
describe("ctx.swarm sends the run's task for audit only", () => {
  let scheduleTask: string;

  beforeAll(async () => {
    scheduleTask = (
      await createTaskExtended("audit schedule run", {
        agentId: agentA,
        requestedByUserId: userA,
        contextKey: "task:schedule:abc",
      })
    ).id;
  });

  /** Runs inline `body` as a script for agent A's schedule task; returns its result. */
  async function runForScheduleTask(body: string): Promise<unknown> {
    const run = await http(
      handleScripts,
      "POST",
      "/api/scripts/run",
      {
        intent: unique("audit task context"),
        source: `export default async (_args: unknown, ctx: any) => { ${body} };`,
      },
      agentA,
      scheduleTask,
    );
    expect(run.status).toBe(200);
    return run.json.result;
  }

  spawnTest(
    "kv_set with no namespace lands in the agent namespace",
    async () => {
      const key = unique("state");
      await runForScheduleTask(`await ctx.swarm.kv_set({ key: "${key}", value: "x" }); return 1;`);
      // A run with no task (or one for another task) reads the same state.
      expect(await scriptSdk(agentA).kv_getOrNull({ key })).toMatchObject({ value: "x" });
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  spawnTest(
    "task_send infers no parent from the run's task",
    async () => {
      const childId = await runForScheduleTask(`
        const r = await ctx.swarm.task_send({
          task: "${unique("audit child")}", agentId: "${agentB}",
          routingReason: "skill", routingNote: "audit test dispatch to agent B",
        });
        return r.data.task.id;`);
      expect(typeof childId).toBe("string");
      const child = await getTaskById(childId as string);
      expect(child?.parentTaskId).toBeUndefined();
      expect(child?.dispatchedByTaskId).toBeUndefined();
      expect(child?.contextKey).not.toBe("task:schedule:abc");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test("negative control: another agent's task in the audit header leaves the person NULL", async () => {
    const result = (await scriptSdk(agentA, taskB).workflow_create({
      name: unique("audit-wf-sdk-foreign"),
      definition: WORKFLOW_DEFINITION,
    })) as { success: boolean; data: { id: string } };
    expect(result).toMatchObject({ success: true });
    const row = await auditRow("workflows", result.data.id);
    expect(row.createdByAgentId).toBe(agentA);
    expect(row.created_by).toBeNull();
  });
});
