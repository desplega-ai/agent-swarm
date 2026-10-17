/**
 * script.author gate for user principals, over real HTTP.
 *
 * A user token on the default admin role (grant-all) must not run, save, or launch script code,
 * expose a script as an API, open an agent MCP session by naming an agent in X-Agent-ID, or save,
 * trigger, retry or run a workflow or schedule that runs script code. A user that holds the
 * built-in script-author role may. The operator key and agent runtime tokens
 * keep their behaviour (positive controls); no bearer and an unknown user token stay 401
 * (negative controls).
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  api,
  E2E_API_KEY,
  LEAD,
  makeScratchDir,
  registerAgent,
  removeScratchDir,
  type SwarmServer,
  spawnSwarmServer,
  WORKER_A,
} from "./rbac-e2e-helpers";

setDefaultTimeout(120_000);

const SCRIPT_AUTHOR_ROLE_ID = "rbac-role-script-author";
const INLINE_SOURCE = "export default async function () { return { ran: true }; }";

let dir: string;
let server: SwarmServer;
let defaultUserToken: string;
let grantedUserToken: string;
let agentToken: string;
let scriptId: string;

function grantScriptAuthor(dbPath: string, userId: string): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.prepare(
      `INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
       VALUES ('user', ?, ?)`,
    ).run(userId, SCRIPT_AUTHOR_ROLE_ID);
  } finally {
    db.close();
  }
}

async function mintUserToken(name: string, email: string): Promise<{ id: string; token: string }> {
  const user = await api(server.base, "POST", "/api/users", { body: { name, email } });
  expect(user.status).toBe(200);
  const id = user.body.user.id as string;
  const minted = await api(server.base, "POST", `/api/users/${id}/mcp-tokens`, { body: {} });
  expect(minted.status).toBe(200);
  const token = minted.body.plaintext as string;
  expect(token).toStartWith("aswt_");
  return { id, token };
}

function runInline(bearer: string | null, agentId?: string) {
  return request("POST", "/api/scripts/run", bearer, agentId, {
    source: INLINE_SOURCE,
    args: {},
  });
}

function upsert(bearer: string, name: string) {
  return request("POST", "/api/scripts/upsert", bearer, WORKER_A, {
    name,
    source: INLINE_SOURCE,
    description: "gate test",
    scope: "agent",
  });
}

function launchDurableRun(bearer: string) {
  return request("POST", "/api/script-runs", bearer, WORKER_A, {
    source: INLINE_SOURCE,
    background: true,
  });
}

function createScriptApi(bearer: string) {
  return request("POST", `/api/scripts/${scriptId}/apis`, bearer, undefined, {
    authMode: "bearer",
  });
}

async function request(
  method: string,
  path: string,
  bearer: string | null,
  agentId: string | undefined,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
  if (agentId) headers["X-Agent-ID"] = agentId;
  const res = await fetch(`${server.base}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function mcpInitialize(bearer: string): Promise<number> {
  const res = await fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "X-Agent-ID": WORKER_A,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "script-author-gate", version: "1" },
        capabilities: {},
      },
    }),
  });
  await res.text();
  return res.status;
}

describe("script.author gate for user principals", () => {
  beforeAll(async () => {
    dir = await makeScratchDir();
    const dbPath = join(dir, "script-author.sqlite");
    // Production default: RBAC on, single runtime.
    server = await spawnSwarmServer({
      dbPath,
      logPath: join(dir, "server.log"),
      env: { RBAC_ENABLED: "true", MULTI_RUNTIME_ENABLED: "false", SCRIPT_EXECUTOR: "native" },
    });
    await registerAgent(server.base, WORKER_A, "script-author-gate-worker", false);

    defaultUserToken = (await mintUserToken("default-admin-user", "gate-default@example.com"))
      .token;
    const granted = await mintUserToken("script-author-user", "gate-granted@example.com");
    grantedUserToken = granted.token;
    grantScriptAuthor(dbPath, granted.id);

    const runtime = await api(server.base, "POST", "/api/sessions/tokens", {
      body: { agentId: WORKER_A, runtimeId: crypto.randomUUID(), ttlMs: 600_000 },
    });
    expect(runtime.status).toBe(200);
    agentToken = runtime.body.plaintext as string;

    expect((await upsert(E2E_API_KEY, "gate-api-target")).status).toBe(200);
    const listed = await api(server.base, "GET", "/api/scripts");
    expect(listed.status).toBe(200);
    scriptId = (listed.body.scripts as Array<{ id: string; name: string }>).find(
      (script) => script.name === "gate-api-target",
    )!.id;
  });

  afterAll(async () => {
    if (server) await server.stop();
    if (dir) await removeScratchDir(dir);
  });

  test("a default admin user token is refused on every script authoring path", async () => {
    const run = await runInline(defaultUserToken, WORKER_A);
    expect(run.status).toBe(403);
    expect(run.body.error).toContain("script.author");
    expect(run.body.result).toBeUndefined();

    // The gate runs before X-Agent-ID is resolved: no 400 for the missing header.
    expect((await runInline(defaultUserToken)).status).toBe(403);
    expect((await upsert(defaultUserToken, "gate-user-upsert")).status).toBe(403);
    expect((await launchDurableRun(defaultUserToken)).status).toBe(403);
    expect((await createScriptApi(defaultUserToken)).status).toBe(403);
    expect(await mcpInitialize(defaultUserToken)).toBe(403);
  });

  test("a user holding the script-author role may author scripts", async () => {
    const run = await runInline(grantedUserToken, WORKER_A);
    expect(run.status).toBe(200);
    expect(run.body.result).toEqual({ ran: true });
    expect((await upsert(grantedUserToken, "gate-granted-upsert")).status).toBe(200);
    expect((await launchDurableRun(grantedUserToken)).status).toBe(201);
    expect((await createScriptApi(grantedUserToken)).status).toBe(201);
    expect(await mcpInitialize(grantedUserToken)).toBe(200);
  });

  test("operator key and agent tokens are unchanged (positive controls)", async () => {
    const operatorRun = await runInline(E2E_API_KEY, WORKER_A);
    expect(operatorRun.status).toBe(200);
    expect(operatorRun.body.result).toEqual({ ran: true });
    expect((await upsert(E2E_API_KEY, "gate-operator-upsert")).status).toBe(200);
    expect((await createScriptApi(E2E_API_KEY)).status).toBe(201);
    expect(await mcpInitialize(E2E_API_KEY)).toBe(200);

    const agentRun = await runInline(agentToken, WORKER_A);
    expect(agentRun.status).toBe(200);
    expect(agentRun.body.result).toEqual({ ran: true });
    expect((await upsert(agentToken, "gate-agent-upsert")).status).toBe(200);
  });

  test("no bearer and an unknown user token stay 401 (negative controls)", async () => {
    expect((await runInline(null, WORKER_A)).status).toBe(401);
    expect((await runInline(`aswt_${"x".repeat(24)}`, WORKER_A)).status).toBe(401);
  });

  describe("workflows and schedules that run script code", () => {
    const SCRIPT_NODE = { id: "s", type: "script", config: { runtime: "bash", script: "true" } };
    const NOTIFY_NODE = { id: "n", type: "notify", config: { channel: "swarm", template: "hi" } };
    let workflowSeq = 0;
    let scheduleSeq = 0;
    let scriptWorkflowId: string;
    let plainWorkflowId: string;
    let failedRunId: string;
    let scriptScheduleId: string;

    const send = (method: string, path: string, bearer: string, body?: unknown) =>
      request(method, path, bearer, bearer === agentToken ? WORKER_A : undefined, body ?? {});

    function createWorkflow(bearer: string, nodes: unknown[]) {
      workflowSeq += 1;
      return send("POST", "/api/workflows", bearer, {
        name: `gate-workflow-${workflowSeq}`,
        definition: { nodes },
      });
    }

    async function workflowId(nodes: unknown[]): Promise<string> {
      const created = await createWorkflow(E2E_API_KEY, nodes);
      expect(created.status).toBe(201);
      return created.body.id as string;
    }

    function createSchedule(bearer: string, target: Record<string, unknown>) {
      scheduleSeq += 1;
      return send("POST", "/api/schedules", bearer, {
        name: `gate-schedule-${scheduleSeq}`,
        intervalMs: 86_400_000,
        ...target,
      });
    }

    async function waitForRunStatus(runId: string, status: string): Promise<void> {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const run = await api(server.base, "GET", `/api/workflow-runs/${runId}`);
        if (run.body?.run?.status === status) return;
        await Bun.sleep(200);
      }
      throw new Error(`workflow run ${runId} never reached ${status}`);
    }

    beforeAll(async () => {
      scriptWorkflowId = await workflowId([SCRIPT_NODE]);
      plainWorkflowId = await workflowId([NOTIFY_NODE]);

      const failing = await workflowId([
        { ...SCRIPT_NODE, config: { runtime: "bash", script: "exit 1" } },
      ]);
      const triggered = await api(server.base, "POST", `/api/workflows/${failing}/trigger`, {
        body: {},
      });
      expect(triggered.status).toBe(201);
      failedRunId = triggered.body.runId as string;
      await waitForRunStatus(failedRunId, "failed");

      await registerAgent(server.base, LEAD, "script-author-gate-lead", true);
      const globalScript = await request("POST", "/api/scripts/upsert", E2E_API_KEY, LEAD, {
        name: "gate-scheduled-script",
        source: INLINE_SOURCE,
        description: "gate test",
        scope: "global",
      });
      expect(globalScript.status).toBe(200);
      const schedule = await createSchedule(E2E_API_KEY, {
        targetType: "script",
        scriptName: "gate-scheduled-script",
      });
      expect(schedule.status).toBe(201);
      scriptScheduleId = schedule.body.id as string;
    });

    test("workflow saves that carry script code need script.author", async () => {
      const subWorkflow = {
        id: "sub",
        type: "sub-workflow",
        config: { workflowId: scriptWorkflowId },
      };
      const denied = await createWorkflow(defaultUserToken, [SCRIPT_NODE]);
      expect(denied.status).toBe(403);
      expect(denied.body.error).toContain("script.author");
      expect(
        (
          await createWorkflow(defaultUserToken, [
            { ...SCRIPT_NODE, type: "swarm-script", config: { scriptName: "gate-api-target" } },
          ])
        ).status,
      ).toBe(403);
      // Nested: a sub-workflow node whose target runs a script.
      expect((await createWorkflow(defaultUserToken, [subWorkflow])).status).toBe(403);

      // Full update: adding a script node, or editing a workflow that already has one.
      const target = await workflowId([NOTIFY_NODE]);
      expect(
        (
          await send("PUT", `/api/workflows/${target}`, defaultUserToken, {
            definition: { nodes: [SCRIPT_NODE] },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await send("PUT", `/api/workflows/${scriptWorkflowId}`, defaultUserToken, {
            name: "renamed",
          })
        ).status,
      ).toBe(403);

      // Bulk patch adding a script node, and a node patch turning a node into one.
      const addScript = {
        update: [{ nodeId: "n", node: { next: "s" } }],
        create: [SCRIPT_NODE],
      };
      expect(
        (await send("PATCH", `/api/workflows/${target}`, defaultUserToken, addScript)).status,
      ).toBe(403);
      expect(
        (
          await send("PATCH", `/api/workflows/${target}/nodes/n`, defaultUserToken, {
            type: "script",
            config: { runtime: "bash", script: "true" },
          })
        ).status,
      ).toBe(403);
      // Refused before anything was written.
      const unchanged = await api(server.base, "GET", `/api/workflows/${target}`);
      expect(unchanged.body.definition.nodes.map((node: { type: string }) => node.type)).toEqual([
        "notify",
      ]);

      // Granted user, operator and agent token may.
      expect((await createWorkflow(grantedUserToken, [SCRIPT_NODE])).status).toBe(201);
      expect((await createWorkflow(grantedUserToken, [subWorkflow])).status).toBe(201);
      expect(
        (await send("PATCH", `/api/workflows/${target}`, grantedUserToken, addScript)).status,
      ).toBe(200);
      expect(
        (
          await send("PUT", `/api/workflows/${target}`, grantedUserToken, {
            name: "granted-rename",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await send("PATCH", `/api/workflows/${target}/nodes/s`, grantedUserToken, {
            label: "granted",
          })
        ).status,
      ).toBe(200);
      expect((await createWorkflow(E2E_API_KEY, [SCRIPT_NODE])).status).toBe(201);
      expect(
        (await send("PUT", `/api/workflows/${target}`, E2E_API_KEY, { name: "operator-rename" }))
          .status,
      ).toBe(200);
      expect((await createWorkflow(agentToken, [SCRIPT_NODE])).status).toBe(201);
      expect(
        (await send("PATCH", `/api/workflows/${target}/nodes/s`, agentToken, { label: "agent" }))
          .status,
      ).toBe(200);
    });

    test("a workflow without script code stays open to a default user", async () => {
      const created = await createWorkflow(defaultUserToken, [NOTIFY_NODE]);
      expect(created.status).toBe(201);
      expect(
        (
          await send("PUT", `/api/workflows/${created.body.id}`, defaultUserToken, {
            name: "plain-rename",
          })
        ).status,
      ).toBe(200);
      expect(
        (await send("POST", `/api/workflows/${plainWorkflowId}/trigger`, defaultUserToken)).status,
      ).toBe(201);
    });

    test("triggering or retrying a workflow that runs scripts needs script.author", async () => {
      const trigger = (bearer: string) =>
        send("POST", `/api/workflows/${scriptWorkflowId}/trigger`, bearer);
      const retry = (bearer: string) =>
        send("POST", `/api/workflow-runs/${failedRunId}/retry`, bearer);

      const denied = await trigger(defaultUserToken);
      expect(denied.status).toBe(403);
      expect(denied.body.runId).toBeUndefined();
      expect((await retry(defaultUserToken)).status).toBe(403);

      expect((await trigger(grantedUserToken)).status).toBe(201);
      expect((await trigger(E2E_API_KEY)).status).toBe(201);
      expect((await trigger(agentToken)).status).toBe(201);

      for (const bearer of [grantedUserToken, E2E_API_KEY, agentToken]) {
        expect((await retry(bearer)).status).toBe(200);
        await waitForRunStatus(failedRunId, "failed");
      }
    });

    test("schedules that run script code need script.author", async () => {
      const scriptTarget = { targetType: "script", scriptName: "gate-scheduled-script" };
      const denied = await createSchedule(defaultUserToken, scriptTarget);
      expect(denied.status).toBe(403);
      expect(denied.body.error).toContain("script.author");
      expect(
        (
          await createSchedule(defaultUserToken, {
            targetType: "workflow",
            workflowId: scriptWorkflowId,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await send("PUT", `/api/schedules/${scriptScheduleId}`, defaultUserToken, {
            description: "x",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await send("PATCH", `/api/schedules/${scriptScheduleId}`, defaultUserToken, {
            description: "x",
          })
        ).status,
      ).toBe(403);
      expect(
        (await send("POST", `/api/schedules/${scriptScheduleId}/run`, defaultUserToken)).status,
      ).toBe(403);

      // A schedule that runs no script code stays open (control).
      expect(
        (
          await createSchedule(defaultUserToken, {
            targetType: "workflow",
            workflowId: plainWorkflowId,
          })
        ).status,
      ).toBe(201);

      expect((await createSchedule(grantedUserToken, scriptTarget)).status).toBe(201);
      expect(
        (
          await send("PUT", `/api/schedules/${scriptScheduleId}`, grantedUserToken, {
            description: "g",
          })
        ).status,
      ).toBe(200);
      expect(
        (await send("POST", `/api/schedules/${scriptScheduleId}/run`, grantedUserToken)).status,
      ).toBe(200);
      expect((await createSchedule(E2E_API_KEY, scriptTarget)).status).toBe(201);
      expect(
        (await send("POST", `/api/schedules/${scriptScheduleId}/run`, E2E_API_KEY)).status,
      ).toBe(200);
      expect((await createSchedule(agentToken, scriptTarget)).status).toBe(201);
      expect(
        (
          await send("PATCH", `/api/schedules/${scriptScheduleId}`, agentToken, {
            description: "a",
          })
        ).status,
      ).toBe(200);
    });
  });
});
