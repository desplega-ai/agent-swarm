import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as preflightAlerts from "../automation-preflight-alert";
import {
  closeDb,
  createUser,
  createWorkflow,
  createWorkflowRun,
  getDbClient,
  getWorkflowRun,
  initDb,
  listWorkflowRuns,
  updateWorkflowRun,
  upsertSwarmConfig,
} from "../be/db";
import * as idempotencyDb from "../be/db/workflow-idempotency";
import { mintToken, revokeToken } from "../be/users";
import { resolveHttpRequestAuth } from "../http/auth";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleWorkflows } from "../http/workflows";
import type { Workflow, WorkflowDefinition, WorkflowRun } from "../types";
import { beginRequestAuthScope, setRequestAuth } from "../utils/request-auth-context";
import { getExecutorRegistry, recoverIncompleteRuns, startWorkflowExecution } from "../workflows";
import { listenOnFreePort } from "./test-net";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const TEST_DB_PATH = "./test-workflow-idempotency.sqlite";
const API_KEY = "workflow-idempotency-test-api-key";
const ACTOR = { kind: "system", id: "workflow-idempotency-test" } as const;

// ─── Test server: the real auth resolution, then the workflow routes ─────────

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    beginRequestAuthScope();
    const auth = await resolveHttpRequestAuth(req, API_KEY);
    if (!auth) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    setRequestAuth(req, auth);
    // Commit everything, then lose the response on the wire.
    if (req.headers["x-test-drop-response"]) {
      res.writeHead = (() => {
        req.socket.destroy();
        return res;
      }) as unknown as typeof res.writeHead;
      res.end = (() => res) as unknown as typeof res.end;
    }
    try {
      const handled = await handleWorkflows(
        req,
        res,
        getPathSegments(req.url || ""),
        parseQueryParams(req.url || ""),
        req.headers["x-agent-id"] as string | undefined,
      );
      if (!handled) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}

let baseUrl = "";
const agentA = crypto.randomUUID();
const agentB = crypto.randomUUID();

interface CallOptions {
  key?: string;
  body?: unknown;
  /** Sent verbatim instead of `JSON.stringify(body)`. */
  rawBody?: string;
  bearer?: string;
  agentId?: string | null;
  dropResponse?: boolean;
}

interface CallResult {
  status: number;
  body: any;
  replayed: boolean;
}

async function call(method: string, path: string, opts: CallOptions = {}): Promise<CallResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.bearer ?? API_KEY}`,
  };
  const agentId = opts.agentId === undefined ? agentA : opts.agentId;
  if (agentId) headers["X-Agent-ID"] = agentId;
  if (opts.key !== undefined) headers["Idempotency-Key"] = opts.key;
  if (opts.dropResponse) headers["x-test-drop-response"] = "1";
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : undefined,
    replayed: res.headers.get("idempotent-replayed") === "true",
  };
}

const createCall = (body: unknown, opts: CallOptions = {}) =>
  call("POST", "/api/workflows", { ...opts, body });
const triggerCall = (workflowId: string, body: unknown, opts: CallOptions = {}) =>
  call("POST", `/api/workflows/${workflowId}/trigger`, { ...opts, body });

const newKey = () => `key-${crypto.randomUUID()}`;
const uniqueName = () => `idem-${crypto.randomUUID()}`;

function instantDefinition(): WorkflowDefinition {
  return { nodes: [{ id: "n1", type: "notify", config: { channel: "swarm", template: "hi" } }] };
}

async function makeWorkflow(overrides: Partial<Parameters<typeof createWorkflow>[0]> = {}) {
  return createWorkflow({ name: uniqueName(), definition: instantDefinition(), ...overrides });
}

async function countWorkflowsNamed(name: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM workflows WHERE name = ?",
    [name],
  );
  return row?.n ?? 0;
}

async function countSteps(workflowId: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM workflow_run_steps
      WHERE runId IN (SELECT id FROM workflow_runs WHERE workflowId = ?)`,
    [workflowId],
  );
  return row?.n ?? 0;
}

async function countRecords(workflowId?: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    workflowId
      ? "SELECT COUNT(*) AS n FROM workflow_idempotency_keys WHERE workflowId = ?"
      : "SELECT COUNT(*) AS n FROM workflow_idempotency_keys",
    workflowId ? [workflowId] : [],
  );
  return row?.n ?? 0;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "skipped"]);

async function waitForTerminalRun(runId: string): Promise<WorkflowRun> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = await getWorkflowRun(runId);
    if (run && TERMINAL.has(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${run?.status}`);
    await Bun.sleep(10);
  }
}

/**
 * Hold every request at its idempotency lookup until `parties` requests have
 * looked the key up, so all of them see it unused before any one commits.
 */
function holdLookupsUntil(parties: number) {
  const original = idempotencyDb.findAcceptedWorkflowOperation;
  let arrived = 0;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return spyOn(idempotencyDb, "findAcceptedWorkflowOperation").mockImplementation(async (scope) => {
    const found = await original(scope);
    if (++arrived === parties) release();
    await allArrived;
    return found;
  });
}

// A real file instead of the preload's in-memory template: the restart tests
// reopen it and the cross-process test opens it from child processes.
const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedWorkflowIdempotencyTemplate?: Uint8Array;
};

async function restartDb(): Promise<void> {
  closeDb();
  initDb(TEST_DB_PATH);
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let server: Server;

beforeAll(async () => {
  testGlobals.__savedWorkflowIdempotencyTemplate = testGlobals.__testMigrationTemplate;
  testGlobals.__testMigrationTemplate = undefined;
  closeDb();
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  server = createTestServer();
  baseUrl = `http://localhost:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  testGlobals.__testMigrationTemplate = testGlobals.__savedWorkflowIdempotencyTemplate;
  testGlobals.__savedWorkflowIdempotencyTemplate = undefined;
  await removeDbFiles();
});

afterEach(() => {
  mock.restore();
});

// ─── Create ──────────────────────────────────────────────────────────────────

describe("POST /api/workflows with Idempotency-Key", () => {
  test("a retry returns the original workflow and creates no second one", async () => {
    const key = newKey();
    const body = { name: uniqueName(), definition: instantDefinition() };

    const first = await createCall(body, { key });
    const retry = await createCall(body, { key });

    expect(first.status).toBe(201);
    expect(first.replayed).toBe(false);
    expect(retry.status).toBe(201);
    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual(first.body);
    expect(await countWorkflowsNamed(body.name)).toBe(1);
    expect(await countRecords(first.body.id)).toBe(1);
  });

  test("object key order does not change the request; array order does", async () => {
    const key = newKey();
    const name = uniqueName();
    const definition = JSON.stringify(instantDefinition());
    const first = await call("POST", "/api/workflows", {
      key,
      rawBody: `{"name":"${name}","requiredParams":["A","B"],"definition":${definition}}`,
    });
    const reordered = await call("POST", "/api/workflows", {
      key,
      rawBody: `{"definition":${definition},"requiredParams":["A","B"],"name":"${name}"}`,
    });
    const swapped = await call("POST", "/api/workflows", {
      key,
      rawBody: `{"name":"${name}","requiredParams":["B","A"],"definition":${definition}}`,
    });

    expect(first.status).toBe(201);
    expect(reordered.status).toBe(201);
    expect(reordered.replayed).toBe(true);
    expect(reordered.body.id).toBe(first.body.id);
    expect(swapped.status).toBe(409);
    expect(await countWorkflowsNamed(name)).toBe(1);
  });

  test("a different request under the same key is a 409 and creates nothing", async () => {
    const key = newKey();
    const first = await createCall(
      { name: uniqueName(), definition: instantDefinition() },
      { key },
    );
    const otherName = uniqueName();
    const conflict = await createCall(
      { name: otherName, definition: instantDefinition() },
      { key },
    );

    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toContain("different request");
    expect(await countWorkflowsNamed(otherName)).toBe(0);
  });

  test("a retry gets the saved snapshot, warnings included, after the workflow changed", async () => {
    const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const key = newKey();
      const body = {
        name: uniqueName(),
        definition: {
          nodes: [
            {
              id: "qualify",
              type: "system-one-decision",
              inputs: { lead: "trigger.lead" },
              config: {
                state: "{{lead}}",
                questions: { fit: { type: "noul", instructions: "Is this a real lead?" } },
                returns: { fit: { type: "noul" } },
              },
            },
          ],
        },
      };
      const first = await createCall(body, { key });
      expect(first.status).toBe(201);
      expect(first.body.warnings).toHaveLength(1);

      // Rename it and configure the key: a recomputed view would differ on both.
      const renamed = await call("PUT", `/api/workflows/${first.body.id}`, {
        body: { name: uniqueName() },
      });
      expect(renamed.status).toBe(200);
      await upsertSwarmConfig({
        scope: "global",
        key: "TYPESAFE_API_KEY",
        value: "tsk_example-idempotency-key.0123456789",
        isSecret: true,
      });

      const retry = await createCall(body, { key });
      expect(retry.replayed).toBe(true);
      expect(retry.body).toEqual(first.body);
      expect(retry.body.name).toBe(body.name);
      expect(retry.body.warnings).toEqual(first.body.warnings);
    } finally {
      await getDbClient().run("DELETE FROM swarm_config WHERE key = 'TYPESAFE_API_KEY'");
      if (savedOpenRouterKey !== undefined) process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    }
  });

  test("a request rejected before it is accepted does not use up the key", async () => {
    const key = newKey();
    const name = uniqueName();
    const invalid = await createCall(
      { name, definition: { nodes: [{ id: "x", type: "no-such-executor", config: {} }] } },
      { key },
    );
    const valid = await createCall({ name, definition: instantDefinition() }, { key });

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(201);
    expect(valid.replayed).toBe(false);
    expect(await countWorkflowsNamed(name)).toBe(1);
  });

  test("a failure inside the accepting transaction leaves neither workflow nor key", async () => {
    const key = newKey();
    const body = { name: uniqueName(), definition: instantDefinition() };
    spyOn(idempotencyDb, "recordAcceptedWorkflowOperation").mockRejectedValueOnce(
      new Error("disk I/O error"),
    );

    const failed = await createCall(body, { key });
    expect(failed.status).toBe(500);
    expect(await countWorkflowsNamed(body.name)).toBe(0);

    const retry = await createCall(body, { key });
    expect(retry.status).toBe(201);
    expect(retry.replayed).toBe(false);
    expect(await countWorkflowsNamed(body.name)).toBe(1);
  });

  test("a response lost after the commit: the retry gets the committed workflow", async () => {
    const key = newKey();
    const body = { name: uniqueName(), definition: instantDefinition() };

    await expect(createCall(body, { key, dropResponse: true })).rejects.toThrow();
    expect(await countWorkflowsNamed(body.name)).toBe(1);

    const retry = await createCall(body, { key });
    expect(retry.status).toBe(201);
    expect(retry.replayed).toBe(true);
    expect(retry.body.name).toBe(body.name);
    expect(await countWorkflowsNamed(body.name)).toBe(1);
  });

  test("the guarantee survives a restart", async () => {
    const key = newKey();
    const body = { name: uniqueName(), definition: instantDefinition() };
    const first = await createCall(body, { key });

    await restartDb();

    const retry = await createCall(body, { key });
    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual(first.body);
    expect(await countWorkflowsNamed(body.name)).toBe(1);
  });

  test("concurrent requests with one key create one workflow", async () => {
    const key = newKey();
    const body = { name: uniqueName(), definition: instantDefinition() };
    holdLookupsUntil(2);

    const results = await Promise.all([createCall(body, { key }), createCall(body, { key })]);

    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    expect(await countWorkflowsNamed(body.name)).toBe(1);
  });

  test("the stored response is sealed", async () => {
    const key = newKey();
    const literal = `literal-input-${crypto.randomUUID()}`;
    const first = await createCall(
      { name: uniqueName(), definition: instantDefinition(), input: { TOKEN: literal } },
      { key },
    );
    const row = await getDbClient().get<{ responseBody: string; keyHash: string }>(
      "SELECT responseBody, keyHash FROM workflow_idempotency_keys WHERE workflowId = ?",
      [first.body.id],
    );

    expect(row?.responseBody.startsWith("sealed:v1:")).toBe(true);
    expect(row?.responseBody).not.toContain(literal);
    expect(row?.keyHash).not.toContain(key);
  });

  test("deleting the workflow retires the key: 410, nothing is created again", async () => {
    const key = newKey();
    const body = { name: uniqueName(), definition: instantDefinition() };
    const first = await createCall(body, { key });
    expect((await call("DELETE", `/api/workflows/${first.body.id}`)).status).toBe(204);

    const retry = await createCall(body, { key });

    expect(retry.status).toBe(410);
    expect(await countWorkflowsNamed(body.name)).toBe(0);
    const row = await getDbClient().get<{ responseBody: string | null; resourceDeletedAt: string }>(
      "SELECT responseBody, resourceDeletedAt FROM workflow_idempotency_keys WHERE workflowId = ?",
      [first.body.id],
    );
    expect(row?.responseBody).toBeNull();
    expect(row?.resourceDeletedAt).toBeTruthy();
  });

  test("keys are scoped to the caller", async () => {
    const key = newKey();
    // Each caller sends its own request (names are unique) under one key: in
    // a shared scope every request after the first would be a 409.
    const body = () => ({ name: uniqueName(), definition: instantDefinition() });
    const userBody = body();
    const userA = await createUser({ name: "idem-user-a" });
    const userB = await createUser({ name: "idem-user-b" });
    const tokenA = (await mintToken(userA.id, null, ACTOR)).plaintext;
    const tokenB = (await mintToken(userB.id, null, ACTOR)).plaintext;

    const results = [
      await createCall(body(), { key, agentId: agentA }),
      await createCall(body(), { key, agentId: agentB }),
      await createCall(body(), { key, agentId: null }),
      await createCall(userBody, { key, bearer: tokenA, agentId: null }),
      await createCall(body(), { key, bearer: tokenB, agentId: null }),
    ];

    expect(results.map((r) => [r.status, r.replayed])).toEqual(
      Array.from({ length: 5 }, () => [201, false]),
    );
    expect(new Set(results.map((r) => r.body.id)).size).toBe(5);
    // A user's key follows the user, not the token.
    const tokenA2 = (await mintToken(userA.id, null, ACTOR)).plaintext;
    const sameUser = await createCall(userBody, { key, bearer: tokenA2, agentId: null });
    expect(sameUser.replayed).toBe(true);
    expect(sameUser.body.id).toBe(results[3]!.body.id);
  });

  test("a revoked token cannot replay", async () => {
    const key = newKey();
    const body = { name: uniqueName(), definition: instantDefinition() };
    const user = await createUser({ name: "idem-user-revoked" });
    const token = await mintToken(user.id, null, ACTOR);
    expect((await createCall(body, { key, bearer: token.plaintext, agentId: null })).status).toBe(
      201,
    );

    await revokeToken(token.tokenId, ACTOR);
    const retry = await createCall(body, { key, bearer: token.plaintext, agentId: null });

    expect(retry.status).toBe(401);
    expect(retry.replayed).toBe(false);
    expect(await countWorkflowsNamed(body.name)).toBe(1);
  });

  test("a malformed key is a 400 and nothing is created", async () => {
    const name = uniqueName();
    for (const key of ["has space", "x".repeat(256)]) {
      const res = await createCall({ name, definition: instantDefinition() }, { key });
      expect(res.status).toBe(400);
    }
    expect(await countWorkflowsNamed(name)).toBe(0);
  });

  test("without a key nothing is recorded or replayed, as before", async () => {
    const body = { name: uniqueName(), definition: instantDefinition() };
    const before = await countRecords();

    const first = await createCall(body);
    // Same request again: the workflow name is taken, as it always was.
    const second = await createCall(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(500);
    expect(second.replayed).toBe(false);
    expect(await countWorkflowsNamed(body.name)).toBe(1);
    expect(await countRecords()).toBe(before);
  });
});

// ─── Trigger ─────────────────────────────────────────────────────────────────

describe("POST /api/workflows/{id}/trigger with Idempotency-Key", () => {
  test("a retry returns the original run and dispatches nothing", async () => {
    const workflow = await makeWorkflow();
    const key = newKey();

    const first = await triggerCall(workflow.id, { n: 1 }, { key });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ runId: expect.any(String), skipped: false });
    expect((await waitForTerminalRun(first.body.runId)).status).toBe("completed");
    const steps = await countSteps(workflow.id);
    expect(steps).toBe(1);

    const retry = await triggerCall(workflow.id, { n: 1 }, { key });

    expect(retry.status).toBe(201);
    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual(first.body);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
    expect(await countSteps(workflow.id)).toBe(steps);
  });

  test("object key order does not change the payload; a different payload is a 409", async () => {
    const workflow = await makeWorkflow();
    const key = newKey();
    const path = `/api/workflows/${workflow.id}/trigger`;

    const first = await call("POST", path, { key, rawBody: '{"a":1,"b":{"c":2,"d":[1,2]}}' });
    const reordered = await call("POST", path, { key, rawBody: '{"b":{"d":[1,2],"c":2},"a":1}' });
    const different = await call("POST", path, { key, rawBody: '{"a":1,"b":{"c":2,"d":[2,1]}}' });

    expect(first.status).toBe(201);
    expect(reordered.replayed).toBe(true);
    expect(reordered.body).toEqual(first.body);
    expect(different.status).toBe(409);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
  });

  test("the same key on another workflow is a separate operation", async () => {
    const one = await makeWorkflow();
    const two = await makeWorkflow();
    const key = newKey();

    const a = await triggerCall(one.id, {}, { key });
    const b = await triggerCall(two.id, {}, { key });

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.replayed).toBe(false);
    expect(a.body.runId).not.toBe(b.body.runId);
  });

  test("a cooldown skip is the accepted result and replays as it was", async () => {
    const workflow = await makeWorkflow({ cooldown: { hours: 1 } });
    const firstKey = newKey();
    const secondKey = newKey();

    const started = await triggerCall(workflow.id, {}, { key: firstKey });
    const skipped = await triggerCall(workflow.id, {}, { key: secondKey });
    expect(started.body.skipped).toBe(false);
    expect(skipped.body.skipped).toBe(true);

    const startedRetry = await triggerCall(workflow.id, {}, { key: firstKey });
    const skippedRetry = await triggerCall(workflow.id, {}, { key: secondKey });

    expect(startedRetry.body).toEqual(started.body);
    expect(skippedRetry.body).toEqual(skipped.body);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(2);
  });

  test("a setup failure is accepted once and alerts once", async () => {
    const notify = spyOn(preflightAlerts, "notifyAutomationPreflightFailure").mockResolvedValue(
      undefined,
    );
    const workflow = await makeWorkflow({ requiredParams: ["REPO_URL"] });
    const key = newKey();

    const first = await triggerCall(workflow.id, {}, { key });
    const retry = await triggerCall(workflow.id, {}, { key });

    expect(first.status).toBe(201);
    expect((await getWorkflowRun(first.body.runId))?.status).toBe("failed");
    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual(first.body);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("a readiness failure is an accepted, failed run", async () => {
    const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const workflow = await makeWorkflow({
        definition: {
          nodes: [
            {
              id: "qualify",
              type: "system-one-decision",
              inputs: { lead: "trigger.lead" },
              config: {
                state: "{{lead}}",
                questions: { fit: { type: "noul", instructions: "Real lead?" } },
                returns: { fit: { type: "noul" } },
              },
            },
          ],
        },
      });
      const key = newKey();

      const first = await triggerCall(workflow.id, { lead: "x" }, { key });
      const retry = await triggerCall(workflow.id, { lead: "x" }, { key });

      expect((await getWorkflowRun(first.body.runId))?.status).toBe("failed");
      expect(retry.replayed).toBe(true);
      expect(retry.body).toEqual(first.body);
      expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
    } finally {
      if (savedOpenRouterKey !== undefined) process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    }
  });

  test("a replay leaves a completed, failed or cancelled run as it is", async () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const workflow = await makeWorkflow();
      const key = newKey();
      const first = await triggerCall(workflow.id, {}, { key });
      await waitForTerminalRun(first.body.runId);
      await updateWorkflowRun(first.body.runId, { status, error: `set ${status}` });
      const steps = await countSteps(workflow.id);

      const retry = await triggerCall(workflow.id, {}, { key });

      expect(retry.body).toEqual(first.body);
      const run = await getWorkflowRun(first.body.runId);
      expect(run?.status).toBe(status);
      expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
      expect(await countSteps(workflow.id)).toBe(steps);
    }
  });

  test("replays after the workflow was disabled or its trigger schema changed", async () => {
    const workflow = await makeWorkflow();
    const key = newKey();
    const first = await triggerCall(workflow.id, { n: 1 }, { key });

    const edited = await call("PUT", `/api/workflows/${workflow.id}`, {
      body: {
        enabled: false,
        triggerSchema: { type: "object", required: ["mustHave"] },
      },
    });
    expect(edited.status).toBe(200);

    const retry = await triggerCall(workflow.id, { n: 1 }, { key });
    const fresh = await triggerCall(workflow.id, { n: 1 }, { key: newKey() });

    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(fresh.status).toBe(400);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
  });

  test("a keyed trigger with a null body is accepted and replays, like the no-key control", async () => {
    const workflow = await makeWorkflow();
    const key = newKey();
    const path = `/api/workflows/${workflow.id}/trigger`;

    const control = await call("POST", path, { rawBody: "null" });
    const first = await call("POST", path, { key, rawBody: "null" });
    const retry = await call("POST", path, { key, rawBody: "null" });

    expect(control.status).toBe(201);
    expect(first.status).toBe(201);
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual(first.body);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(2);
  });

  test("a trigger-schema rejection does not use up the key", async () => {
    const workflow = await makeWorkflow({
      triggerSchema: { type: "object", required: ["pr"] },
    });
    const key = newKey();

    const rejected = await triggerCall(workflow.id, {}, { key });
    const accepted = await triggerCall(workflow.id, { pr: 1 }, { key });

    expect(rejected.status).toBe(400);
    expect(accepted.status).toBe(201);
    expect(accepted.replayed).toBe(false);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
  });

  test("a failure inside the run transaction leaves neither run nor key", async () => {
    const workflow = await makeWorkflow();
    const key = newKey();
    spyOn(idempotencyDb, "recordAcceptedWorkflowOperation").mockRejectedValueOnce(
      new Error("disk I/O error"),
    );

    const failed = await triggerCall(workflow.id, {}, { key });
    expect(failed.status).toBe(500);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(0);
    expect(await countRecords(workflow.id)).toBe(0);

    const retry = await triggerCall(workflow.id, {}, { key });
    expect(retry.status).toBe(201);
    expect(retry.replayed).toBe(false);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
  });

  test("an accept hook that throws rolls the run back and walks nothing", async () => {
    const workflow = await makeWorkflow();

    await expect(
      startWorkflowExecution(workflow, {}, getExecutorRegistry(), {
        triggerType: "api",
        accept: async () => {
          throw new idempotencyDb.IdempotencyKeyTakenError();
        },
      }),
    ).rejects.toBeInstanceOf(idempotencyDb.IdempotencyKeyTakenError);

    expect(await listWorkflowRuns(workflow.id)).toHaveLength(0);
    expect(await countSteps(workflow.id)).toBe(0);
  });

  test("a response lost after the commit: the retry gets the run, which ran once", async () => {
    const workflow = await makeWorkflow();
    const key = newKey();

    await expect(triggerCall(workflow.id, {}, { key, dropResponse: true })).rejects.toThrow();
    const [run] = await listWorkflowRuns(workflow.id);
    expect(run).toBeDefined();

    const retry = await triggerCall(workflow.id, {}, { key });

    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual({ runId: run!.id, skipped: false });
    expect((await waitForTerminalRun(run!.id)).status).toBe("completed");
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
    expect(await countSteps(workflow.id)).toBe(1);
  });

  test("a crash between the commit and the walk: the retry replays, recovery runs it once", async () => {
    const workflow = await makeWorkflow();
    const key = newKey();
    const body = { n: 1 };
    // What the trigger commits before its walk: the run, its initial context
    // and the key, in one transaction. The process then dies.
    const runId = crypto.randomUUID();
    await getDbClient().transaction(async () => {
      await createWorkflowRun({ id: runId, workflowId: workflow.id, triggerType: "api" });
      await updateWorkflowRun(runId, { context: { trigger: body } });
      await idempotencyDb.recordAcceptedWorkflowOperation(
        {
          principal: `agent:${agentA}`,
          operation: "workflow.trigger",
          targetId: workflow.id,
          key,
          fingerprint: idempotencyDb.workflowRequestFingerprint("workflow.trigger", body),
        },
        { workflowId: workflow.id, runId, status: 201, body: { runId, skipped: false } },
      );
    });
    await restartDb();

    const retry = await triggerCall(workflow.id, body, { key });
    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual({ runId, skipped: false });
    expect(await countSteps(workflow.id)).toBe(0);

    await recoverIncompleteRuns(getExecutorRegistry());

    expect((await waitForTerminalRun(runId)).status).toBe("completed");
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
    expect(await countSteps(workflow.id)).toBe(1);
  });

  test("concurrent requests with one key start one run", async () => {
    const workflow = await makeWorkflow();
    const key = newKey();
    holdLookupsUntil(2);

    const results = await Promise.all([
      triggerCall(workflow.id, { n: 1 }, { key }),
      triggerCall(workflow.id, { n: 1 }, { key }),
    ]);

    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
    expect(await countSteps(workflow.id)).toBe(1);
  });

  test(
    "concurrent requests on independent DB connections start one run",
    async () => {
      const workflow = await makeWorkflow();
      const key = newKey();
      const barrierDir = await mkdtemp(join(tmpdir(), "workflow-idempotency-"));
      try {
        const fixture = join(import.meta.dir, "fixtures", "workflow-idempotency-trigger.child.ts");
        const children = [1, 2].map((n) =>
          runChild(["bun", fixture, TEST_DB_PATH, workflow.id, key, barrierDir, String(n)], {
            env: { ...process.env },
          }),
        );
        // Release both only once both found the key unused.
        const looked = [1, 2].map((n) => Bun.file(join(barrierDir, `looked-${n}`)));
        const deadline = Date.now() + 20_000;
        while (!(await Promise.all(looked.map((file) => file.exists()))).every(Boolean)) {
          if (Date.now() > deadline) throw new Error("trigger children never reached the barrier");
          await Bun.sleep(10);
        }
        await Bun.write(join(barrierDir, "go"), "");

        const outputs = (await Promise.all(children)).map((result, i) => {
          expectChildOk(result, `trigger child ${i + 1}`);
          return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
            runId: string;
            replayed: boolean;
          };
        });

        expect(outputs[0]!.runId).toBe(outputs[1]!.runId);
        expect(outputs.filter((o) => o.replayed)).toHaveLength(1);
        expect(await listWorkflowRuns(workflow.id)).toHaveLength(1);
        expect(await countRecords(workflow.id)).toBe(1);
      } finally {
        await rm(barrierDir, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test("the database rejects a second record for one scope", async () => {
    const workflow = await makeWorkflow();
    const insert = () =>
      getDbClient().run(
        `INSERT INTO workflow_idempotency_keys
           (id, principal, operation, targetId, keyHash, requestFingerprint, workflowId,
            responseStatus, createdAt)
         VALUES (?, 'operator', 'workflow.trigger', ?, 'same-hash', 'fp', ?, 201, ?)`,
        [crypto.randomUUID(), workflow.id, workflow.id, new Date().toISOString()],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE constraint failed/);
  });

  test("deleting the workflow retires the key: 410, nothing is started", async () => {
    const workflow = await makeWorkflow();
    const key = newKey();
    expect((await triggerCall(workflow.id, {}, { key })).status).toBe(201);
    expect((await call("DELETE", `/api/workflows/${workflow.id}`)).status).toBe(204);

    const retry = await triggerCall(workflow.id, {}, { key });

    expect(retry.status).toBe(410);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(0);
  });

  test("keys are scoped to the caller", async () => {
    const workflow = await makeWorkflow();
    const key = newKey();

    const a = await triggerCall(workflow.id, {}, { key, agentId: agentA });
    const b = await triggerCall(workflow.id, {}, { key, agentId: agentB });

    expect(b.replayed).toBe(false);
    expect(a.body.runId).not.toBe(b.body.runId);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(2);
  });

  test("without a key every request starts a run, as before", async () => {
    const workflow: Workflow = await makeWorkflow();

    const first = await triggerCall(workflow.id, { n: 1 });
    const second = await triggerCall(workflow.id, { n: 1 });

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.runId).not.toBe(second.body.runId);
    expect(await listWorkflowRuns(workflow.id)).toHaveLength(2);
    expect(await countRecords(workflow.id)).toBe(0);
  });
});
