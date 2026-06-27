import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handleCore } from "../http/core";
import { handleScriptRuns } from "../http/script-runs";
import { handleScripts } from "../http/scripts";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerScriptDeleteTool } from "../tools/script-delete";
import { registerScriptRunTool } from "../tools/script-run";
import { registerScriptRunsTools } from "../tools/script-runs";
import { registerScriptSearchTool } from "../tools/script-search";
import { registerScriptUpsertTool } from "../tools/script-upsert";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-scripts-mcp-e2e.sqlite";
const API_KEY = "test-scripts-mcp-key-1234567890";

function fakeEmbedding(text: string): Float32Array {
  const lower = text.toLowerCase();
  return new Float32Array([
    lower.includes("multiply") ? 1 : 0,
    lower.includes("seven") ? 1 : 0,
    lower.includes("memory") ? 1 : 0,
    lower.includes("typed") ? 1 : 0,
  ]);
}

const fakeEmbeddingProvider = {
  name: "test/fake-script-embedding",
  dimensions: 4,
  async embed(text: string) {
    return fakeEmbedding(text);
  },
  async embedBatch(texts: string[]) {
    return Promise.all(texts.map(fakeEmbedding));
  },
};

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type StructuredResult<T> = {
  structuredContent: {
    success: boolean;
    status: number;
    data?: T;
    error?: string;
  };
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function buildToolServer() {
  const server = new McpServer({ name: "scripts-mcp-e2e", version: "1.0.0" });
  registerScriptSearchTool(server);
  registerScriptRunTool(server);
  registerScriptRunsTools(server);
  registerScriptUpsertTool(server);
  registerScriptDeleteTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return {
    search: registered["script-search"]!,
    run: registered["script-run"]!,
    upsert: registered["script-upsert"]!,
    del: registered["script-delete"]!,
    launchScriptRun: registered["launch-script-run"]!,
    getScriptRun: registered["get-script-run"]!,
    listScriptRuns: registered["list-script-runs"]!,
  };
}

function meta(agentId?: string) {
  const headers: Record<string, string> = {};
  if (agentId) headers["x-agent-id"] = agentId;
  return { sessionId: "scripts-mcp-e2e", requestInfo: { headers } };
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers as Record<string, string>;
}

async function dispatchScriptsApi(url: string, init: RequestInit = {}): Promise<Response> {
  const parsedUrl = new URL(url);
  const headers = Object.fromEntries(
    Object.entries(headersRecord(init.headers)).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  const body = init.body === undefined ? undefined : String(init.body);
  const req = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = `${parsedUrl.pathname}${parsedUrl.search}`;
  req.headers = headers;

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

  const agentId = headers["x-agent-id"];
  if (!(await handleCore(req, res, agentId, API_KEY))) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (
      !(await handleScripts(req, res, pathSegments, queryParams, agentId)) &&
      !(await handleScriptRuns(req, res, pathSegments, queryParams, agentId))
    ) {
      res.writeHead(404);
      res.end("Not Found");
    }
  }

  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let workerId: string;
let savedEnv: NodeJS.ProcessEnv;
let savedFetch: typeof globalThis.fetch;

beforeAll(async () => {
  savedEnv = { ...process.env };
  savedFetch = globalThis.fetch;
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  process.env.SCRIPT_RUN_SUPERVISOR_DISABLE = "true";
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
  setScriptEmbeddingProviderForTests(fakeEmbeddingProvider);
  workerId = createAgent({ name: "scripts-mcp-worker", isLead: false, status: "idle" }).id;
  process.env.MCP_BASE_URL = "http://scripts-mcp-e2e.test";
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (
      url.startsWith("http://scripts-mcp-e2e.test/api/scripts/") ||
      url.startsWith("http://scripts-mcp-e2e.test/api/script-runs")
    ) {
      return dispatchScriptsApi(url, init);
    }
    return savedFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterAll(async () => {
  globalThis.fetch = savedFetch;
  setScriptEmbeddingProviderForTests(null);
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
  getDb().run("DELETE FROM scripts");
  getDb().run("DELETE FROM script_run_journal");
  getDb().run("DELETE FROM script_runs");
});

describe("script_ MCP HTTP proxy tools", () => {
  test("exercise script-upsert -> script-search -> script-run -> script-delete", async () => {
    const tools = buildToolServer();
    const source = `export default async (args: { value: number }) => ({ result: args.value * 7 });`;

    const upsert = (await tools.upsert.handler(
      { name: "times-seven", source, description: "Multiply", intent: "MCP E2E" },
      meta(workerId),
    )) as StructuredResult<{ name: string; version: number }>;
    expect(upsert.structuredContent.success).toBe(true);
    expect(upsert.structuredContent.data?.name).toBe("times-seven");

    const search = (await tools.search.handler(
      { query: "seven", limit: 5 },
      meta(workerId),
    )) as StructuredResult<{ results: Array<{ name: string }> }>;
    expect(search.structuredContent.success).toBe(true);
    expect(search.structuredContent.data?.results.map((item) => item.name)).toContain(
      "times-seven",
    );

    const run = (await tools.run.handler(
      { name: "times-seven", args: { value: 6 }, intent: "MCP run" },
      meta(workerId),
    )) as StructuredResult<{ result: { result: number } }>;
    expect(run.structuredContent.success).toBe(true);
    expect(run.structuredContent.data?.result).toEqual({ result: 42 });

    const del = (await tools.del.handler(
      { name: "times-seven", scope: "agent" },
      meta(workerId),
    )) as StructuredResult<{ deleted: boolean }>;
    expect(del.structuredContent.success).toBe(true);
    expect(del.structuredContent.data?.deleted).toBe(true);
  });

  test("persists a successful inline run with kind 'inline' and no journal", async () => {
    const tools = buildToolServer();
    const source = `export default async (args: { value: number }) => ({ doubled: args.value * 2 });`;

    const run = (await tools.run.handler(
      { source, args: { value: 21 }, intent: "inline persist e2e" },
      meta(workerId),
    )) as StructuredResult<{ result: { doubled: number } }>;
    expect(run.structuredContent.success).toBe(true);
    expect(run.structuredContent.data?.result).toEqual({ doubled: 42 });

    const listed = (await tools.listScriptRuns.handler(
      { limit: 10, offset: 0 },
      meta(workerId),
    )) as StructuredResult<{
      runs: Array<{ id: string; kind: string; status: string }>;
      total: number;
    }>;
    expect(listed.structuredContent.data?.total).toBe(1);
    const inlineRun = listed.structuredContent.data?.runs[0];
    expect(inlineRun?.kind).toBe("inline");
    expect(inlineRun?.status).toBe("completed");

    const detail = (await tools.getScriptRun.handler(
      { id: inlineRun?.id },
      meta(workerId),
    )) as StructuredResult<{ run: { kind: string }; journal: unknown[] }>;
    expect(detail.structuredContent.data?.run.kind).toBe("inline");
    expect(detail.structuredContent.data?.journal).toEqual([]);
  });

  test("persists a failed inline run with kind 'inline' and an error", async () => {
    const tools = buildToolServer();
    const source = `export default async () => { throw new Error("boom"); };`;

    const run = (await tools.run.handler(
      { source, intent: "inline failure e2e" },
      meta(workerId),
    )) as StructuredResult<unknown>;
    expect(run.structuredContent.success).toBe(true);

    const listed = (await tools.listScriptRuns.handler(
      { limit: 10, offset: 0 },
      meta(workerId),
    )) as StructuredResult<{
      runs: Array<{ kind: string; status: string; error?: string }>;
    }>;
    const failed = listed.structuredContent.data?.runs[0];
    expect(failed?.kind).toBe("inline");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBeTruthy();
  });

  test("stdio-style missing agent identity short-circuits clearly", async () => {
    const tools = buildToolServer();
    const result = (await tools.search.handler({ query: "anything" }, meta())) as StructuredResult<{
      error: string;
    }>;
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.error).toContain("HTTP MCP transport");
  });

  test("launches, lists, and inspects durable script workflow runs", async () => {
    const tools = buildToolServer();
    const source = `export default async function main() { return { ok: true }; }`;

    const launched = (await tools.launchScriptRun.handler(
      { source, args: { input: true }, scriptName: "mcp-script-workflow" },
      meta(workerId),
    )) as StructuredResult<{ id: string; status: string; url: string }>;
    expect(launched.structuredContent.success).toBe(true);
    expect(launched.structuredContent.status).toBe(201);
    expect(launched.structuredContent.data?.status).toBe("running");
    const runId = launched.structuredContent.data?.id;
    expect(runId).toBeTruthy();

    const listed = (await tools.listScriptRuns.handler(
      { status: "running", limit: 10, offset: 0 },
      meta(workerId),
    )) as StructuredResult<{ runs: Array<{ id: string }>; total: number }>;
    expect(listed.structuredContent.success).toBe(true);
    expect(listed.structuredContent.data?.total).toBe(1);
    expect(listed.structuredContent.data?.runs[0]?.id).toBe(runId);

    const detail = (await tools.getScriptRun.handler(
      { id: runId },
      meta(workerId),
    )) as StructuredResult<{ run: { id: string; status: string }; journal: unknown[] }>;
    expect(detail.structuredContent.success).toBe(true);
    expect(detail.structuredContent.data?.run.id).toBe(runId);
    expect(detail.structuredContent.data?.run.status).toBe("running");
    expect(detail.structuredContent.data?.journal).toEqual([]);
  });

  test("typed SDK fixture passes upsert typecheck and wrong arg type fails", async () => {
    const tools = buildToolServer();
    const source = `
      import type { ScriptContext, SwarmSdk } from "swarm-sdk";
      const compileOnly = (swarm: SwarmSdk) => swarm.memory_search({ query: "foo", intent: "test" });
      export default async (_args: unknown, ctx: ScriptContext) => {
        void compileOnly;
        return { hasMemorySearch: typeof ctx.swarm.memory_search === "function" };
      };
    `;

    const upsert = (await tools.upsert.handler(
      { name: "typed-sdk", source, description: "Typed SDK fixture", intent: "typecheck" },
      meta(workerId),
    )) as StructuredResult<{ name: string }>;
    expect(upsert.structuredContent.success).toBe(true);

    const run = (await tools.run.handler(
      { name: "typed-sdk", args: {}, intent: "typed SDK run" },
      meta(workerId),
    )) as StructuredResult<{ result: { hasMemorySearch: boolean } }>;
    expect(run.structuredContent.success).toBe(true);
    expect(run.structuredContent.data?.result).toEqual({ hasMemorySearch: true });

    const bad = (await tools.upsert.handler(
      {
        name: "typed-sdk-bad",
        source: `
          import type { ScriptContext } from "swarm-sdk";
          export default async (_args: unknown, ctx: ScriptContext) =>
            ctx.swarm.memory_search({ query: 123 });
        `,
        description: "Bad SDK fixture",
        intent: "typecheck",
      },
      meta(workerId),
    )) as StructuredResult<{ diagnostics: string[] }>;
    expect(bad.structuredContent.success).toBe(false);
    expect(bad.structuredContent.error).toBe("typecheck_failed");
  });
});
