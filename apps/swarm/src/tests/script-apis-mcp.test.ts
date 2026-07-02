import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { __resetEncryptionKeyForTests } from "../be/crypto";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { insertScript } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handleCore } from "../http/core";
import { handleScripts } from "../http/scripts";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerScriptApisTool } from "../tools/script-apis";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-script-apis-mcp.sqlite";
const API_KEY = "test-script-apis-mcp-key-1234567890";

const noOpEmbeddingProvider = {
  name: "test/noop-script-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
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

const DOUBLER_SOURCE =
  "export default async function run(args) { return { doubled: (args && typeof args.value === 'number' ? args.value : 0) * 2 }; }";

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<unknown> };

type StructuredResult<T> = {
  structuredContent: { success: boolean; status: number; data?: T; error?: string };
  isError?: boolean;
};

function buildToolServer() {
  const server = new McpServer({ name: "script-apis-mcp", version: "1.0.0" });
  registerScriptApisTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return { scriptApis: registered["script-apis"]! };
}

function meta(agentId?: string) {
  const headers: Record<string, string> = {};
  if (agentId) headers["x-agent-id"] = agentId;
  return { sessionId: "script-apis-mcp", requestInfo: { headers } };
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

  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

let workerId: string;
let scriptId: string;
let savedEnv: NodeJS.ProcessEnv;
let savedFetch: typeof globalThis.fetch;

beforeAll(async () => {
  savedEnv = { ...process.env };
  savedFetch = globalThis.fetch;
  process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  __resetEncryptionKeyForTests();
  await removeDbFiles(TEST_DB_PATH);
  // initDb() no-ops and returns the existing shared `db` singleton if one is
  // already open — closeDb() first guarantees a fresh connection against
  // TEST_DB_PATH and forces resolveEncryptionKey() to actually run, instead of
  // silently reusing whatever connection (and cached key) the previous test
  // file in the run left open.
  closeDb();
  initDb(TEST_DB_PATH);
  refreshSecretScrubberCache();
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  workerId = createAgent({ name: "script-apis-mcp-worker", isLead: false, status: "idle" }).id;
  process.env.MCP_BASE_URL = "http://script-apis-mcp.test";
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("http://script-apis-mcp.test/api/scripts/")) {
      return dispatchScriptsApi(url, init);
    }
    return savedFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterAll(async () => {
  globalThis.fetch = savedFetch;
  setScriptEmbeddingProviderForTests(null);
  __resetEncryptionKeyForTests();
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
  getDb().run("DELETE FROM script_apis");
  getDb().run("DELETE FROM script_runs");
  getDb().run("DELETE FROM scripts");
  scriptId = insertScript({
    name: `doubler-${crypto.randomUUID().slice(0, 8)}`,
    scope: "agent",
    scopeId: workerId,
    source: DOUBLER_SOURCE,
    description: "Doubles a value",
    intent: "test fixture",
    signatureJson: "{}",
    argsJsonSchema: null,
    agentId: workerId,
    typeChecked: true,
  }).id;
});

describe("script-apis MCP tool", () => {
  test("create returns the plaintext bearer token once", async () => {
    const tools = buildToolServer();
    const result = (await tools.scriptApis.handler(
      { action: "create", scriptId, authMode: "bearer", label: "demo" },
      meta(workerId),
    )) as StructuredResult<{ id: string; token: string; authMode: string }>;
    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.data?.token).toMatch(/^xsk_/);
    expect(result.structuredContent.data?.authMode).toBe("bearer");
  });

  test("list masks bearer tokens by default and reveals with includeSecrets", async () => {
    const tools = buildToolServer();
    const created = (await tools.scriptApis.handler(
      { action: "create", scriptId, authMode: "bearer" },
      meta(workerId),
    )) as StructuredResult<{ id: string; token: string }>;
    const realToken = created.structuredContent.data?.token;
    expect(realToken).toBeTruthy();

    const masked = (await tools.scriptApis.handler(
      { action: "list", scriptId },
      meta(workerId),
    )) as StructuredResult<{ apis: Array<{ id: string; token: string | null }> }>;
    expect(masked.structuredContent.data?.apis[0]?.token).toBe("********");

    const revealed = (await tools.scriptApis.handler(
      { action: "list", scriptId, includeSecrets: true },
      meta(workerId),
    )) as StructuredResult<{ apis: Array<{ id: string; token: string | null }> }>;
    expect(revealed.structuredContent.data?.apis[0]?.token).toBe(realToken);
  });

  test("list returns a null token for authMode 'none'", async () => {
    const tools = buildToolServer();
    await tools.scriptApis.handler(
      { action: "create", scriptId, authMode: "none" },
      meta(workerId),
    );
    const listed = (await tools.scriptApis.handler(
      { action: "list", scriptId },
      meta(workerId),
    )) as StructuredResult<{ apis: Array<{ token: string | null }> }>;
    expect(listed.structuredContent.data?.apis[0]?.token).toBeNull();
  });

  test("rotate issues a new plaintext token", async () => {
    const tools = buildToolServer();
    const created = (await tools.scriptApis.handler(
      { action: "create", scriptId, authMode: "bearer" },
      meta(workerId),
    )) as StructuredResult<{ id: string; token: string }>;
    const endpointId = created.structuredContent.data?.id as string;
    const oldToken = created.structuredContent.data?.token;

    const rotated = (await tools.scriptApis.handler(
      { action: "rotate", scriptId, endpointId },
      meta(workerId),
    )) as StructuredResult<{ token: string }>;
    expect(rotated.structuredContent.success).toBe(true);
    expect(rotated.structuredContent.data?.token).toBeTruthy();
    expect(rotated.structuredContent.data?.token).not.toBe(oldToken);
  });

  test("update toggles enabled and relabels", async () => {
    const tools = buildToolServer();
    const created = (await tools.scriptApis.handler(
      { action: "create", scriptId, authMode: "none" },
      meta(workerId),
    )) as StructuredResult<{ id: string }>;
    const endpointId = created.structuredContent.data?.id as string;

    const updated = (await tools.scriptApis.handler(
      { action: "update", scriptId, endpointId, enabled: false, label: "renamed" },
      meta(workerId),
    )) as StructuredResult<{ enabled: boolean; label: string | null }>;
    expect(updated.structuredContent.success).toBe(true);
    expect(updated.structuredContent.data?.enabled).toBe(false);
    expect(updated.structuredContent.data?.label).toBe("renamed");
  });

  test("delete removes the endpoint", async () => {
    const tools = buildToolServer();
    const created = (await tools.scriptApis.handler(
      { action: "create", scriptId, authMode: "none" },
      meta(workerId),
    )) as StructuredResult<{ id: string }>;
    const endpointId = created.structuredContent.data?.id as string;

    const deleted = (await tools.scriptApis.handler(
      { action: "delete", scriptId, endpointId },
      meta(workerId),
    )) as StructuredResult<{ deleted: boolean }>;
    expect(deleted.structuredContent.success).toBe(true);
    expect(deleted.structuredContent.data?.deleted).toBe(true);

    const listed = (await tools.scriptApis.handler(
      { action: "list", scriptId },
      meta(workerId),
    )) as StructuredResult<{ apis: unknown[] }>;
    expect(listed.structuredContent.data?.apis).toHaveLength(0);
  });

  test("update/rotate/delete without endpointId return a clear error", async () => {
    const tools = buildToolServer();
    for (const action of ["update", "rotate", "delete"] as const) {
      const result = (await tools.scriptApis.handler(
        { action, scriptId },
        meta(workerId),
      )) as StructuredResult<unknown>;
      expect(result.structuredContent.success).toBe(false);
      expect(result.structuredContent.error).toContain("endpointId is required");
    }
  });

  test("missing agent identity short-circuits clearly", async () => {
    const tools = buildToolServer();
    const result = (await tools.scriptApis.handler(
      { action: "list", scriptId },
      meta(),
    )) as StructuredResult<unknown>;
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.error).toContain("HTTP MCP transport");
  });
});
