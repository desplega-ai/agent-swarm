import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { handleCore } from "../http/core";
import { handleScriptRuns } from "../http/script-runs";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-script-runs-http.sqlite";
const API_KEY = "test-script-runs-http-key-1234567890";

let agentId: string;
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

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  process.env.APP_URL = "https://app.example.test";
  process.env.SCRIPT_RUN_SUPERVISOR_DISABLE = "true";
  delete process.env.API_KEY;
  refreshSecretScrubberCache();

  const agent = createAgent({ name: "script-runs-worker", isLead: false, status: "idle" });
  agentId = agent.id;
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
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
  delete process.env.SCRIPT_RUN_CONCURRENCY_CAP;
  delete process.env.SCRIPT_RUN_MAX_STEPS;
  delete process.env.SCRIPT_RUN_MAX_AGENT_TASKS;
  delete process.env.SCRIPT_RUN_MAX_WALL_MS;
  process.env.SCRIPT_RUN_SUPERVISOR_DISABLE = "true";
});

type TestResponse = {
  status: number;
  text: string;
  json: () => Promise<unknown>;
};

async function dispatch(
  path: string,
  init: RequestInit & { agentId?: string } = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.agentId !== undefined) headers["X-Agent-ID"] = init.agentId;
  const req = Readable.from(init.body ? [Buffer.from(String(init.body))] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

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

  const requestAgentId = req.headers["x-agent-id"] as string | undefined;
  if (!(await handleCore(req, res, requestAgentId, API_KEY))) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (!(await handleScriptRuns(req, res, pathSegments, queryParams, requestAgentId))) {
      res.writeHead(404);
      res.end("Not Found");
    }
  }

  return {
    status,
    text,
    json: async () => JSON.parse(text),
  };
}

function createBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: "export default async function main() { return { ok: true }; }",
    args: { ok: true },
    ...extra,
  });
}

describe("/api/script-runs HTTP", () => {
  test("creates and lists a script run", async () => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody({ scriptName: "daily-report" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; status: string; url: string };
    expect(body.status).toBe("running");
    expect(body.url).toBe(`https://app.example.test/script-runs/${body.id}`);

    const listed = await dispatch("/api/script-runs", { agentId });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { runs: Array<{ id: string }>; total: number };
    expect(listBody.total).toBe(1);
    expect(listBody.runs[0]?.id).toBe(body.id);
  });

  test("returns the existing run for an idempotency key", async () => {
    const first = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody({ idempotencyKey: "stable-key" }),
    });
    const firstBody = (await first.json()) as { id: string };

    const second = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody({ idempotencyKey: "stable-key" }),
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);
  });

  test("rejects obvious literal labels inside loops before launch", async () => {
    const rejected = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody({
        source:
          'export default async function main(args, ctx) { for (const item of args.items) { await ctx.step.agentTask("process", { task: item.task }); } }',
      }),
    });
    expect(rejected.status).toBe(400);
    const body = (await rejected.json()) as { error: string; violations: Array<{ label: string }> };
    expect(body.error).toBe("label_lint_violation");
    expect(body.violations[0]?.label).toBe("process");
  });

  test("records and replays journal steps through internal routes", async () => {
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id } = (await created.json()) as { id: string };

    const recorded = await dispatch(`/api/internal/script-runs/${id}/steps`, {
      method: "POST",
      agentId,
      body: JSON.stringify({
        stepKey: "summarize",
        stepType: "raw-llm",
        config: { prompt: "hello" },
        status: "completed",
        result: { text: "hi" },
      }),
    });
    expect(recorded.status).toBe(201);

    const replayed = await dispatch(`/api/internal/script-runs/${id}/steps/summarize`, {
      agentId,
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual({
      stepKey: "summarize",
      stepType: "raw-llm",
      result: { text: "hi" },
    });
  });

  test("aborts the run when the journal step cap is exceeded", async () => {
    process.env.SCRIPT_RUN_MAX_STEPS = "1";
    const created = await dispatch("/api/script-runs", {
      method: "POST",
      agentId,
      body: createBody(),
    });
    const { id } = (await created.json()) as { id: string };

    const first = await dispatch(`/api/internal/script-runs/${id}/steps`, {
      method: "POST",
      agentId,
      body: JSON.stringify({
        stepKey: "one",
        stepType: "swarm-script",
        status: "completed",
        result: 1,
      }),
    });
    expect(first.status).toBe(201);

    const second = await dispatch(`/api/internal/script-runs/${id}/steps`, {
      method: "POST",
      agentId,
      body: JSON.stringify({
        stepKey: "two",
        stepType: "swarm-script",
        status: "completed",
        result: 2,
      }),
    });
    expect(second.status).toBe(429);

    const detail = await dispatch(`/api/script-runs/${id}`, { agentId });
    const body = (await detail.json()) as { run: { status: string; error?: string } };
    expect(body.run.status).toBe("aborted_limit");
    expect(body.run.error).toContain("SCRIPT_RUN_MAX_STEPS");
  });
});
