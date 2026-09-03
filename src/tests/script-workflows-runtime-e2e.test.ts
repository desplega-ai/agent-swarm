import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rm, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  closeDb,
  createAgent,
  getDbClient,
  getScriptRun,
  initDb,
  listScriptRunJournalSteps,
} from "../be/db";
import { handleCore } from "../http/core";
import { handleScriptRuns } from "../http/script-runs";
import { handleScripts } from "../http/scripts";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { MAX_ACTIVE_CAPABILITY_DISPATCHES } from "../script-workflows/executor";
import { pauseScriptRunProcess } from "../script-workflows/supervisor";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-script-workflows-runtime-e2e.sqlite";
const WORKFLOW_RUNTIME_DIR = "./test-script-workflows-runtime";
const API_KEY = "test-script-workflows-runtime-key-1234567890";
// The pre-push hook sets this only when its file-backed Bun sandbox probe exits
// 134 under the shared UID's RLIMIT_NPROC. CI leaves it unset and runs these tests.
const SKIP_SANDBOX_TESTS = process.env.SWARM_SKIP_SANDBOX_SPAWN_TESTS === "1";
const spawnTest = test.skipIf(SKIP_SANDBOX_TESTS);

let agentId: string;
let server: Server;
let baseUrl: string;
let savedEnv: NodeJS.ProcessEnv;
let heartbeatCount = 0;
let holdAgentTaskResponses = false;
let agentTaskRequestCount = 0;
let agentTaskClosedCount = 0;
const heldAgentTaskResponses = new Set<ServerResponse>();
let holdMcpBridgeResponses = false;
let mcpBridgeRequestCount = 0;
let activeMcpBridgeRequests = 0;
let maxActiveMcpBridgeRequests = 0;
const heldMcpBridgeResponses = new Set<ServerResponse>();

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const agentId = req.headers["x-agent-id"] as string | undefined;
  if (req.method === "POST" && req.url?.endsWith("/heartbeat")) heartbeatCount += 1;
  if (await handleCore(req, res, agentId, API_KEY)) return;
  if (req.method === "POST" && req.url === "/api/mcp-bridge") {
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let rawBody = "";
    for await (const chunk of req) rawBody += String(chunk);
    const requestBody = JSON.parse(rawBody) as {
      args?: { forceError?: unknown };
    };
    if (requestBody.args?.forceError === true) {
      res.writeHead(418, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "teapot" }));
      return;
    }
    if (holdMcpBridgeResponses) {
      mcpBridgeRequestCount += 1;
      activeMcpBridgeRequests += 1;
      maxActiveMcpBridgeRequests = Math.max(maxActiveMcpBridgeRequests, activeMcpBridgeRequests);
      heldMcpBridgeResponses.add(res);
      res.once("close", () => {
        activeMcpBridgeRequests -= 1;
        heldMcpBridgeResponses.delete(res);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ brokered: true }));
    return;
  }
  if (holdAgentTaskResponses && req.method === "POST" && req.url?.endsWith("/agent-task")) {
    for await (const _chunk of req) {
      // Consume the request body before holding the long-poll response open.
    }
    agentTaskRequestCount += 1;
    heldAgentTaskResponses.add(res);
    res.once("close", () => {
      agentTaskClosedCount += 1;
      heldAgentTaskResponses.delete(res);
    });
    return;
  }
  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");
  if (await handleScriptRuns(req, res, pathSegments, queryParams, agentId)) return;
  if (await handleScripts(req, res, pathSegments, queryParams, agentId)) return;
  res.writeHead(404);
  res.end("Not Found");
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(message);
}

function completeHeldAgentTasks(): void {
  for (const res of [...heldAgentTaskResponses]) {
    if (res.writableEnded || res.destroyed) continue;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ taskId: crypto.randomUUID(), taskOutput: { ok: true } }));
  }
}

function completeHeldMcpBridgeRequests(): void {
  for (const res of [...heldMcpBridgeResponses]) {
    if (res.writableEnded || res.destroyed) continue;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ brokered: true }));
  }
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "X-Agent-ID": agentId,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

async function waitForRun(
  id: string,
): Promise<{ status: string; output?: unknown; error?: string }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await api(`/api/script-runs/${id}`);
    const body = (await res.json()) as {
      run: { status: string; output?: unknown; error?: string };
    };
    if (["completed", "failed", "cancelled", "aborted_limit"].includes(body.run.status)) {
      return body.run;
    }
    await Bun.sleep(250);
  }
  throw new Error("Timed out waiting for script run");
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  process.env.API_KEY = API_KEY;
  process.env.APP_URL = "https://app.example.test";
  delete process.env.PUBLIC_MCP_BASE_URL;
  delete process.env.SCRIPT_RUN_SUPERVISOR_DISABLE;
  await rm(WORKFLOW_RUNTIME_DIR, { recursive: true, force: true });
  await Bun.$`bun build ./src/script-workflows/harness.ts --target bun --no-splitting --outfile ${WORKFLOW_RUNTIME_DIR}/harness.bundle.js`.quiet();
  process.env.SCRIPT_WORKFLOW_RUNTIME_DIR = WORKFLOW_RUNTIME_DIR;
  refreshSecretScrubberCache();

  const agent = await createAgent({
    name: "script-workflow-e2e-worker",
    isLead: false,
    status: "idle",
  });
  agentId = agent.id;
  server = createServer((req, res) => {
    route(req, res).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });
  const port = await listenOnFreePort(server, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${port}`;
  process.env.MCP_BASE_URL = baseUrl;
});

afterAll(async () => {
  await closeServer(server);
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  await rm(WORKFLOW_RUNTIME_DIR, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

beforeEach(async () => {
  completeHeldAgentTasks();
  completeHeldMcpBridgeRequests();
  heartbeatCount = 0;
  holdAgentTaskResponses = false;
  agentTaskRequestCount = 0;
  agentTaskClosedCount = 0;
  heldAgentTaskResponses.clear();
  holdMcpBridgeResponses = false;
  mcpBridgeRequestCount = 0;
  activeMcpBridgeRequests = 0;
  maxActiveMcpBridgeRequests = 0;
  heldMcpBridgeResponses.clear();
  await getDbClient().run("DELETE FROM script_run_journal");
  await getDbClient().run("DELETE FROM script_runs");
});

afterEach(() => {
  holdAgentTaskResponses = false;
  completeHeldAgentTasks();
  heldAgentTaskResponses.clear();
  holdMcpBridgeResponses = false;
  completeHeldMcpBridgeRequests();
  heldMcpBridgeResponses.clear();
});

describe("script workflow runtime", () => {
  spawnTest("runs a durable one-off script and replays a completed step", async () => {
    const source = `
      export default async function main(args, ctx) {
        const first = await ctx.step.swarmScript("double", {
          source: "export default async (args) => args.value * 2;",
          args: { value: args.value },
          intent: "script-workflow-e2e"
        });
        const second = await ctx.step.swarmScript("double", {
          source: "export default async () => 999;",
          intent: "script-workflow-e2e-should-replay"
        });
        return { runId: ctx.run.id, first, second };
      }
    `;

    const created = await api("/api/script-runs", {
      method: "POST",
      body: JSON.stringify({ source, args: { value: 7 }, background: true }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const run = await waitForRun(id);
    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({
      runId: id,
      first: { result: 14, exitCode: 0 },
      second: { result: 14, exitCode: 0 },
    });

    const journal = await listScriptRunJournalSteps(id);
    expect(journal).toHaveLength(1);
    expect(journal[0]?.stepKey).toBe("double");
    expect(journal[0]?.stepType).toBe("swarm-script");
  });

  // ─── Sandbox regressions (superagent.sh c27edfd7, finding fd866ffe) ──────

  spawnTest(
    "the durable run's user code cannot read the operator bearer from process.env",
    async () => {
      const source = `
      export default async function main() {
        return {
          apiKeyEnv: typeof process !== "undefined" ? (process.env.AGENT_SWARM_API_KEY ?? null) : "no-process",
        };
      }
    `;

      const created = await api("/api/script-runs", {
        method: "POST",
        body: JSON.stringify({ source, background: true }),
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      const run = await waitForRun(id);
      expect(run.status).toBe("completed");
      // Not the real key, not any truthy value — the env var simply isn't set
      // in the harness's process anymore (bearer travels over stdin instead).
      expect((run.output as { apiKeyEnv: unknown }).apiKeyEnv).toBeNull();
    },
  );

  spawnTest(
    "user fetch replacement cannot observe brokered swarm or lifecycle bearer",
    async () => {
      const source = `
      export default async function main(_args, ctx) {
        const observed = [];
        globalThis.fetch = async (input, init) => {
          observed.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return new Response(JSON.stringify({ intercepted: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        };
        await Bun.sleep(10_250);
        const info = await ctx.swarm.agent_info();
        let errorMessage = null;
        try {
          await ctx.swarm.agent_info({ forceError: true });
        } catch (error) {
          errorMessage = error.message;
        }
        let rejectedConfig = null;
        let rejectedUnknown = null;
        try { await ctx.swarm.config(); } catch (error) { rejectedConfig = error.message; }
        try { await ctx.swarm.future_sensitive_property(); } catch (error) { rejectedUnknown = error.message; }
        return {
          observed,
          info,
          errorMessage,
          apiKeyEnv: process.env.AGENT_SWARM_API_KEY ?? null,
          configType: typeof ctx.swarm.config,
          rejectedConfig,
          rejectedUnknown,
        };
      }
    `;

      const created = await api("/api/script-runs", {
        method: "POST",
        body: JSON.stringify({ source, background: true }),
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      const run = await waitForRun(id);
      expect(run.status).toBe("completed");
      expect(run.output).toMatchObject({
        observed: [],
        apiKeyEnv: null,
        configType: "undefined",
        errorMessage: "/api/mcp-bridge failed with 418: teapot",
        rejectedConfig: expect.stringContaining("not a function"),
        rejectedUnknown: expect.stringContaining("not a function"),
      });
      expect(heartbeatCount).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(run.output)).not.toContain(API_KEY);
      expect((run.output as { info: unknown }).info).toEqual({ brokered: true });
    },
    { timeout: 20_000 },
  );

  spawnTest("guest failures preserve the prior terminal error message shape", async () => {
    const created = await api("/api/script-runs", {
      method: "POST",
      body: JSON.stringify({
        source: `export default async function main() { throw new TypeError("guest boom"); }`,
        background: true,
      }),
    });
    const { id } = (await created.json()) as { id: string };

    const run = await waitForRun(id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("guest boom");
  });

  spawnTest("bounds active host broker work under a guest flood", async () => {
    holdMcpBridgeResponses = true;
    const callCount = MAX_ACTIVE_CAPABILITY_DISPATCHES + 4;
    const source = `
      export default async function main(_args, ctx) {
        return await Promise.all(
          Array.from({ length: ${callCount} }, () => ctx.swarm.agent_info()),
        );
      }
    `;

    const created = await api("/api/script-runs", {
      method: "POST",
      body: JSON.stringify({ source, background: true }),
    });
    const { id } = (await created.json()) as { id: string };

    await waitUntil(
      () => mcpBridgeRequestCount === MAX_ACTIVE_CAPABILITY_DISPATCHES,
      `Expected ${MAX_ACTIVE_CAPABILITY_DISPATCHES} active broker calls, observed ${mcpBridgeRequestCount}`,
    );
    await Bun.sleep(100);
    expect(mcpBridgeRequestCount).toBe(MAX_ACTIVE_CAPABILITY_DISPATCHES);
    expect(maxActiveMcpBridgeRequests).toBe(MAX_ACTIVE_CAPABILITY_DISPATCHES);

    completeHeldMcpBridgeRequests();
    await waitUntil(
      () => mcpBridgeRequestCount === callCount,
      `Expected all ${callCount} broker calls to dispatch, observed ${mcpBridgeRequestCount}`,
    );
    expect(maxActiveMcpBridgeRequests).toBeLessThanOrEqual(MAX_ACTIVE_CAPABILITY_DISPATCHES);
    completeHeldMcpBridgeRequests();

    const run = await waitForRun(id);
    expect(run.status).toBe("completed");
    expect(run.output).toHaveLength(callCount);
  });

  spawnTest(
    "dispatches more than four durable capability calls before any child finishes",
    async () => {
      holdAgentTaskResponses = true;
      const source = `
      export default async function main(_args, ctx) {
        return await Promise.all([
          ctx.step.agentTask("fanout-1", { task: "one" }),
          ctx.step.agentTask("fanout-2", { task: "two" }),
          ctx.step.agentTask("fanout-3", { task: "three" }),
          ctx.step.agentTask("fanout-4", { task: "four" }),
          ctx.step.agentTask("fanout-5", { task: "five" }),
        ]);
      }
    `;

      const created = await api("/api/script-runs", {
        method: "POST",
        body: JSON.stringify({ source, background: true }),
      });
      const { id } = (await created.json()) as { id: string };

      await waitUntil(
        () => agentTaskRequestCount === 5,
        `Expected all five agent tasks to dispatch, observed ${agentTaskRequestCount}`,
      );
      completeHeldAgentTasks();

      const run = await waitForRun(id);
      expect(run.status).toBe("completed");
      expect(await listScriptRunJournalSteps(id)).toHaveLength(5);
    },
  );

  spawnTest(
    "pausing aborts host polling without journaling or overwriting paused status",
    async () => {
      holdAgentTaskResponses = true;
      const created = await api("/api/script-runs", {
        method: "POST",
        body: JSON.stringify({
          source: `
          export default async function main(_args, ctx) {
            return await ctx.step.agentTask("paused-step", { task: "stay pending" });
          }
        `,
          background: true,
        }),
      });
      const { id } = (await created.json()) as { id: string };
      await waitUntil(() => agentTaskRequestCount === 1, "Agent task poll did not start");

      await pauseScriptRunProcess(id);
      await waitUntil(
        () => agentTaskClosedCount === 1,
        "Host-side agent task poll was not aborted",
      );
      await Bun.sleep(250);

      expect((await getScriptRun(id))?.status).toBe("paused");
      expect(await listScriptRunJournalSteps(id)).toHaveLength(0);
    },
  );

  // macOS cannot enforce the runtime's ulimit preamble (no usable RLIMIT_AS);
  // Linux CI is the enforcing environment. Skip only unblocks local macOS
  // pushes now that pre-push tests are blocking (#1216).
  test.skipIf(process.platform === "darwin" || SKIP_SANDBOX_TESTS)(
    "resource ulimits actually apply to the durable run's process tree",
    async () => {
      // Async Bun.spawn on purpose: scripts/check-test-spawn-sync.sh greps
      // src/tests/ for a synchronous spawn call (Bun's sync variant, invoked
      // with its trailing parenthesis), and that includes text inside a
      // source string like this one that the script runtime executes in its
      // own sandboxed subprocess. The ulimit is applied to that whole process
      // tree regardless of how the probe spawns its own child, so an async
      // spawn verifies the same thing without needing a gate exception.
      const source = `
      export default async function main() {
        const proc = Bun.spawn(["sh", "-c", "ulimit -v"], { stdout: "pipe" });
        const out = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        return { ulimitV: out };
      }
    `;

      const created = await api("/api/script-runs", {
        method: "POST",
        body: JSON.stringify({ source, background: true }),
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      const run = await waitForRun(id);
      expect(run.status).toBe("completed");
      const ulimitV = (run.output as { ulimitV: string }).ulimitV;
      expect(ulimitV).not.toBe("unlimited");
      expect(Number(ulimitV)).toBeGreaterThan(0);
    },
  );

  spawnTest(
    "POST /api/script-runs requires no bearer beyond normal auth — matches POST /api/scripts/run (any authenticated agent)",
    async () => {
      const created = await api("/api/script-runs", {
        method: "POST",
        body: JSON.stringify({
          source: "export default async () => ({ ok: true });",
          background: true,
        }),
      });
      // Not a 401/403 for an ordinary (non-lead) agent — RBAC posture is
      // explicitly `ungated`, not silently missing.
      expect(created.status).toBe(201);
    },
  );
});
