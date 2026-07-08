import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { __resetEncryptionKeyForTests } from "../be/crypto";
import { closeDb, createAgent, createMcpServer, getDb, initDb } from "../be/db";
import {
  createScriptApi,
  getScriptApiById,
  getScriptApiSecret,
  insertScript,
  listScriptApisForScript,
} from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handleCore } from "../http/core";
import { handleScripts } from "../http/scripts";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { handleX } from "../http/x";
import { refreshSecretScrubberCache, scrubSecrets } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-scripts-external-api.sqlite";
const API_KEY = "test-external-api-key-1234567890";

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

/** A trivial, import-free script: doubles `args.value`. */
const DOUBLER_SOURCE =
  "export default async function run(args) { return { doubled: (args && typeof args.value === 'number' ? args.value : 0) * 2 }; }";

let workerId: string;
let savedEnv: NodeJS.ProcessEnv;

function insertDoubler(opts: { argsJsonSchema?: string | null } = {}) {
  return insertScript({
    name: `doubler-${crypto.randomUUID().slice(0, 8)}`,
    scope: "agent",
    scopeId: workerId,
    source: DOUBLER_SOURCE,
    description: "Doubles a value",
    intent: "test fixture",
    signatureJson: "{}",
    argsJsonSchema: opts.argsJsonSchema ?? null,
    agentId: workerId,
    typeChecked: true,
  });
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  // Re-resolve the encryption key against our env key regardless of test order.
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

  const worker = createAgent({ name: "ext-api-worker", isLead: false, status: "idle" });
  workerId = worker.id;
});

afterAll(async () => {
  closeDb();
  setScriptEmbeddingProviderForTests(null);
  __resetEncryptionKeyForTests();
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
});

type TestResponse = { status: number; text: string; json: () => Promise<unknown> };

/**
 * Dispatch a request through the same pipeline as the server: handleCore (auth
 * gate) → handleScripts (management) → handleX (public execution).
 * `auth` controls the Authorization header: a string sends `Bearer <auth>`,
 * `null` omits it, default sends the swarm key.
 */
async function dispatch(
  path: string,
  init: { method?: string; body?: string; agentId?: string; auth?: string | null } = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = init.auth === undefined ? API_KEY : init.auth;
  if (auth !== null) headers.authorization = `Bearer ${auth}`;
  if (init.agentId !== undefined) headers["x-agent-id"] = init.agentId;
  if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));

  const req = Readable.from(init.body ? [Buffer.from(init.body)] : []) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
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

  const agentId = req.headers["x-agent-id"] as string | undefined;
  if (!(await handleCore(req, res, agentId, API_KEY))) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (
      !(await handleScripts(req, res, pathSegments, queryParams, agentId)) &&
      !(await handleX(req, res, pathSegments))
    ) {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
  return { status, text, json: async () => JSON.parse(text) };
}

describe("script_apis DB layer", () => {
  test("bearer endpoint stores an encrypted token that decrypts back", () => {
    const script = insertDoubler();
    const created = createScriptApi({
      scriptId: script.id,
      agentId: workerId,
      authMode: "bearer",
    });
    expect(created.token).toMatch(/^xsk_/);
    expect(created.id).toMatch(/^[a-zA-Z]{12}$/);

    const row = getDb()
      .prepare<{ bearerTokenEncrypted: string }, [string]>(
        "SELECT bearerTokenEncrypted FROM script_apis WHERE id = ?",
      )
      .get(created.id);
    // Stored value is ciphertext, not the plaintext token.
    expect(row?.bearerTokenEncrypted).toBeTruthy();
    expect(row?.bearerTokenEncrypted).not.toBe(created.token);
    // ...and round-trips via the reveal path.
    expect(getScriptApiSecret(created.id)).toBe(created.token);
  });

  test("none endpoint has no token", () => {
    const script = insertDoubler();
    const created = createScriptApi({ scriptId: script.id, agentId: workerId, authMode: "none" });
    expect(created.token).toBeNull();
    expect(getScriptApiSecret(created.id)).toBeNull();
  });

  test("revealing the secret registers it with the scrubber", () => {
    const script = insertDoubler();
    const created = createScriptApi({
      scriptId: script.id,
      agentId: workerId,
      authMode: "bearer",
    });
    const token = getScriptApiSecret(created.id) as string;
    expect(scrubSecrets(`token is ${token}`)).not.toContain(token);
  });
});

describe("management routes", () => {
  test("create → list → reveal → disable → delete", async () => {
    const script = insertDoubler();

    const create = await dispatch(`/api/scripts/${script.id}/apis`, {
      method: "POST",
      body: JSON.stringify({ authMode: "bearer", label: "demo" }),
    });
    expect(create.status).toBe(201);
    const endpoint = (await create.json()) as { id: string; token: string; authMode: string };
    expect(endpoint.authMode).toBe("bearer");
    expect(endpoint.token).toMatch(/^xsk_/);

    const list = await dispatch(`/api/scripts/${script.id}/apis`);
    const { apis } = (await list.json()) as { apis: Array<{ id: string; token?: string }> };
    expect(apis).toHaveLength(1);
    expect(apis[0]?.id).toBe(endpoint.id);
    // List never carries the secret.
    expect(apis[0]).not.toHaveProperty("token");

    const reveal = await dispatch(`/api/scripts/${script.id}/apis/${endpoint.id}/secret`);
    expect((await reveal.json()) as { token: string }).toEqual({ token: endpoint.token });

    const patch = await dispatch(`/api/scripts/${script.id}/apis/${endpoint.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect((await patch.json()) as { enabled: boolean }).toMatchObject({ enabled: false });

    const del = await dispatch(`/api/scripts/${script.id}/apis/${endpoint.id}`, {
      method: "DELETE",
    });
    expect((await del.json()) as { deleted: boolean }).toEqual({ deleted: true });
    expect(listScriptApisForScript(script.id)).toHaveLength(0);
  });

  test("create on a global script with no owner requires agentId", async () => {
    const script = insertScript({
      name: `orphan-${crypto.randomUUID().slice(0, 8)}`,
      scope: "global",
      source: DOUBLER_SOURCE,
      description: "global",
      intent: "test",
      signatureJson: "{}",
      typeChecked: true,
    });
    const res = await dispatch(`/api/scripts/${script.id}/apis`, {
      method: "POST",
      body: JSON.stringify({ authMode: "none" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("agentId");
  });
});

describe("public execution route", () => {
  test("none-mode endpoint runs and returns the wrapped envelope", async () => {
    const script = insertDoubler();
    const endpoint = createScriptApi({
      scriptId: script.id,
      agentId: workerId,
      authMode: "none",
    });

    const res = await dispatch(`/api/x/script/${endpoint.id}`, {
      method: "POST",
      body: JSON.stringify({ value: 21 }),
      auth: null,
    });
    const body = (await res.json()) as {
      ok: boolean;
      result: { doubled: number };
      error: unknown;
      durationMs: number;
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ doubled: 42 });
    expect(body.error).toBeNull();
    expect(typeof body.durationMs).toBe("number");
  });

  test("external endpoint runs receive ctx.mcp connections (parity with /api/scripts/run)", async () => {
    const mcpServer = createMcpServer({
      name: `x-mcp-${crypto.randomUUID()}`,
      transport: "http",
      scope: "global",
      url: "http://mcp.invalid.test/mcp",
    });
    const runtimeDescriptor = {
      slug: "xmcp",
      kind: "mcp",
      connectionId: crypto.randomUUID(),
      tools: [{ name: "ping", inputSchema: {} }],
    };
    getDb()
      .prepare(
        `INSERT INTO script_connections
           (id, slug, kind, scope, allowed_hosts_json, mcp_server_id, generated_runtime_json)
         VALUES (?, ?, 'mcp', 'global', '[]', ?, ?)`,
      )
      .run(
        runtimeDescriptor.connectionId,
        "xmcp",
        mcpServer.id,
        JSON.stringify(runtimeDescriptor),
      );

    const script = insertScript({
      name: `mcp-keys-${crypto.randomUUID().slice(0, 8)}`,
      scope: "agent",
      scopeId: workerId,
      source:
        "export default async function run(args, ctx) { return { slugs: Object.keys(ctx.mcp ?? {}) }; }",
      description: "Lists ctx.mcp slugs",
      intent: "test fixture",
      signatureJson: "{}",
    });
    const endpoint = createScriptApi({
      scriptId: script.id,
      agentId: workerId,
      authMode: "none",
    });

    const res = await dispatch(`/api/x/script/${endpoint.id}`, {
      method: "POST",
      body: JSON.stringify({}),
      auth: null,
    });
    const body = (await res.json()) as { ok: boolean; result: { slugs: string[] } };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.slugs).toContain("xmcp");
  });

  test("oversized body → 413 before execution, even for authMode 'none'", async () => {
    const script = insertDoubler();
    const endpoint = createScriptApi({
      scriptId: script.id,
      agentId: workerId,
      authMode: "none",
    });

    const oversized = JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) });
    const res = await dispatch(`/api/x/script/${endpoint.id}`, {
      method: "POST",
      body: oversized,
      auth: null,
    });
    expect(res.status).toBe(413);
  });

  test("bearer mode: missing/invalid token → 401, valid → 200", async () => {
    const script = insertDoubler();
    const endpoint = createScriptApi({
      scriptId: script.id,
      agentId: workerId,
      authMode: "bearer",
    });

    const missing = await dispatch(`/api/x/script/${endpoint.id}`, {
      method: "POST",
      body: JSON.stringify({ value: 1 }),
      auth: null,
    });
    expect(missing.status).toBe(401);

    const wrong = await dispatch(`/api/x/script/${endpoint.id}`, {
      method: "POST",
      body: JSON.stringify({ value: 1 }),
      auth: "xsk_wrong-token",
    });
    expect(wrong.status).toBe(401);

    const valid = await dispatch(`/api/x/script/${endpoint.id}`, {
      method: "POST",
      body: JSON.stringify({ value: 5 }),
      auth: endpoint.token as string,
    });
    expect(valid.status).toBe(200);
    expect((await valid.json()) as { ok: boolean; result: unknown }).toMatchObject({
      ok: true,
      result: { doubled: 10 },
    });
  });

  test("args validation failure returns an args_validation envelope without executing", async () => {
    const script = insertDoubler({
      argsJsonSchema: JSON.stringify({
        type: "object",
        required: ["value"],
        properties: { value: { type: "number" } },
      }),
    });
    const endpoint = createScriptApi({
      scriptId: script.id,
      agentId: workerId,
      authMode: "none",
    });

    const res = await dispatch(`/api/x/script/${endpoint.id}`, {
      method: "POST",
      body: JSON.stringify({ value: "not-a-number" }),
      auth: null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: { type: string } };
    expect(body.ok).toBe(false);
    expect(body.error.type).toBe("args_validation");
  });

  test("disabled endpoint → 404", async () => {
    const script = insertDoubler();
    const endpoint = createScriptApi({
      scriptId: script.id,
      agentId: workerId,
      authMode: "none",
    });
    getDb().run("UPDATE script_apis SET enabled = 0 WHERE id = ?", [endpoint.id]);

    const res = await dispatch(`/api/x/script/${endpoint.id}`, {
      method: "POST",
      body: JSON.stringify({ value: 1 }),
      auth: null,
    });
    expect(res.status).toBe(404);
  });

  test("usage is tracked: callCount + an apiEndpointId-tagged run", async () => {
    const script = insertDoubler();
    const endpoint = createScriptApi({
      scriptId: script.id,
      agentId: workerId,
      authMode: "none",
    });

    await dispatch(`/api/x/script/${endpoint.id}`, {
      method: "POST",
      body: JSON.stringify({ value: 2 }),
      auth: null,
    });

    const after = getScriptApiById(endpoint.id);
    expect(after?.callCount).toBe(1);

    const runs = getDb()
      .prepare<{ apiEndpointId: string }, [string]>(
        "SELECT apiEndpointId FROM script_runs WHERE apiEndpointId = ?",
      )
      .all(endpoint.id);
    expect(runs).toHaveLength(1);
  });

  test("an unparseable timeout header falls back to the default and still runs", async () => {
    const script = insertDoubler();
    const endpoint = createScriptApi({
      scriptId: script.id,
      agentId: workerId,
      authMode: "none",
    });
    const req = await dispatchWithHeader(endpoint.id, "not-a-number");
    expect(req.status).toBe(200);
    expect((await req.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });
});

/** Variant of dispatch that injects an X-Swarm-Timeout-Ms header. */
async function dispatchWithHeader(endpointId: string, timeout: string): Promise<TestResponse> {
  const req = Readable.from([Buffer.from(JSON.stringify({ value: 3 }))]) as IncomingMessage;
  req.method = "POST";
  req.url = `/api/x/script/${endpointId}`;
  req.headers = { "content-type": "application/json", "x-swarm-timeout-ms": timeout };

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

  const pathSegments = getPathSegments(req.url || "");
  await handleX(req, res, pathSegments);
  return { status, text, json: async () => JSON.parse(text) };
}
