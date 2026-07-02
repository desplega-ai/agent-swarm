import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rm, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeDb, createAgent, getDb, initDb, listScriptRunJournalSteps } from "../be/db";
import { handleCore } from "../http/core";
import { handleScriptRuns } from "../http/script-runs";
import { handleScripts } from "../http/scripts";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-script-workflows-runtime-e2e.sqlite";
const WORKFLOW_RUNTIME_DIR = "./test-script-workflows-runtime";
const API_KEY = "test-script-workflows-runtime-key-1234567890";

let agentId: string;
let server: Server;
let baseUrl: string;
let savedEnv: NodeJS.ProcessEnv;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("No server address"));
      else resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const agentId = req.headers["x-agent-id"] as string | undefined;
  if (await handleCore(req, res, agentId, API_KEY)) return;
  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");
  if (await handleScriptRuns(req, res, pathSegments, queryParams, agentId)) return;
  if (await handleScripts(req, res, pathSegments, queryParams, agentId)) return;
  res.writeHead(404);
  res.end("Not Found");
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
  const deadline = Date.now() + 10_000;
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
  delete process.env.SCRIPT_RUN_SUPERVISOR_DISABLE;
  await rm(WORKFLOW_RUNTIME_DIR, { recursive: true, force: true });
  await Bun.$`bun build ./src/script-workflows/harness.ts --target bun --no-splitting --outfile ${WORKFLOW_RUNTIME_DIR}/harness.bundle.js`.quiet();
  process.env.SCRIPT_WORKFLOW_RUNTIME_DIR = WORKFLOW_RUNTIME_DIR;
  refreshSecretScrubberCache();

  const agent = createAgent({ name: "script-workflow-e2e-worker", isLead: false, status: "idle" });
  agentId = agent.id;
  server = createServer((req, res) => {
    route(req, res).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });
  const port = await listen(server);
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

beforeEach(() => {
  getDb().run("DELETE FROM script_run_journal");
  getDb().run("DELETE FROM script_runs");
});

describe("script workflow runtime", () => {
  test("runs a durable one-off script and replays a completed step", async () => {
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

    const journal = listScriptRunJournalSteps(id);
    expect(journal).toHaveLength(1);
    expect(journal[0]?.stepKey).toBe("double");
    expect(journal[0]?.stepType).toBe("swarm-script");
  });
});
