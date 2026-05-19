import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handleCore } from "../http/core";
import { handleScripts } from "../http/scripts";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerScriptDeleteTool } from "../tools/script-delete";
import { registerScriptRunTool } from "../tools/script-run";
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
  registerScriptUpsertTool(server);
  registerScriptDeleteTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return {
    search: registered["script-search"]!,
    run: registered["script-run"]!,
    upsert: registered["script-upsert"]!,
    del: registered["script-delete"]!,
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
    if (!(await handleScripts(req, res, pathSegments, queryParams, agentId))) {
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
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
  setScriptEmbeddingProviderForTests(fakeEmbeddingProvider);
  workerId = createAgent({ name: "scripts-mcp-worker", isLead: false, status: "idle" }).id;
  process.env.MCP_BASE_URL = "http://scripts-mcp-e2e.test";
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("http://scripts-mcp-e2e.test/api/scripts/")) {
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

  test("stdio-style missing agent identity short-circuits clearly", async () => {
    const tools = buildToolServer();
    const result = (await tools.search.handler({ query: "anything" }, meta())) as StructuredResult<{
      error: string;
    }>;
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.error).toContain("HTTP MCP transport");
  });

  test("typed SDK fixture passes upsert typecheck and wrong arg type fails", async () => {
    const tools = buildToolServer();
    const source = `
      import type { ScriptContext, SwarmSdk } from "swarm-sdk";
      const compileOnly = (swarm: SwarmSdk) => swarm.memory_search({ query: "foo" });
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
