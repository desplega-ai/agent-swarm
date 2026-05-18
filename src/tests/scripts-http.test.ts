import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { getScript, listScripts } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handleCore } from "../http/core";
import { handleScripts } from "../http/scripts";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-scripts-http.sqlite";
const API_KEY = "test-scripts-http-key-1234567890";

function fakeEmbedding(text: string): Float32Array {
  const lower = text.toLowerCase();
  return new Float32Array([
    lower.includes("lookup") ? 1 : 0,
    lower.includes("multiply") ? 1 : 0,
    lower.includes("linear") ? 1 : 0,
    lower.includes("github") ? 1 : 0,
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

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function validSource(multiplier: number) {
  return `export default async (args: { value: number }): Promise<{ result: number }> => ({ result: args.value * ${multiplier} });`;
}

let workerId: string;
let leadId: string;
let savedEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  savedEnv = { ...process.env };
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  refreshSecretScrubberCache();
  setScriptEmbeddingProviderForTests(fakeEmbeddingProvider);

  const worker = createAgent({ name: "scripts-worker", isLead: false, status: "idle" });
  const lead = createAgent({ name: "scripts-lead", isLead: true, status: "idle" });
  workerId = worker.id;
  leadId = lead.id;
});

afterAll(async () => {
  closeDb();
  setScriptEmbeddingProviderForTests(null);
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
  getDb().run("DELETE FROM events WHERE event = 'script.global_upsert'");
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

  const agentId = req.headers["x-agent-id"] as string | undefined;
  if (!(await handleCore(req, res, agentId, API_KEY))) {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (!(await handleScripts(req, res, pathSegments, queryParams, agentId))) {
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

async function upsert(body: Record<string, unknown>, agentId = workerId): Promise<TestResponse> {
  return dispatch("/api/scripts/upsert", {
    method: "POST",
    agentId,
    body: JSON.stringify(body),
  });
}

describe("/api/scripts HTTP", () => {
  test("requires X-Agent-ID", async () => {
    const res = await dispatch("/api/scripts/upsert", {
      method: "POST",
      body: JSON.stringify({ name: "missing-agent", source: validSource(2) }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("X-Agent-ID");
  });

  test("upsert round-trips body and bumps version on source change", async () => {
    const first = await upsert({
      name: "double",
      source: validSource(2),
      description: "Double values",
      intent: "Arithmetic reuse",
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ name: "double", version: 1, contentDeduped: false });

    const second = await upsert({
      name: "double",
      source: validSource(3),
      description: "Triple values",
      intent: "Arithmetic reuse",
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ name: "double", version: 2, contentDeduped: false });
  });

  test("upsert typecheck failures return diagnostics and do not write rows", async () => {
    const res = await upsert({
      name: "bad-types",
      source: `const x: number = "nope"; export default async () => x;`,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("typecheck_failed");
    expect(body.diagnostics.length).toBeGreaterThan(0);
    expect(getScript({ name: "bad-types", scope: "agent", scopeId: workerId })).toBeNull();
  });

  test("upsert rejects unknown ctx.swarm tools", async () => {
    const res = await upsert({
      name: "unknown-tool",
      source: `
        import type { ScriptContext } from "swarm-sdk";
        export default async (_args: unknown, ctx: ScriptContext) => ctx.swarm.no_such_tool({});
      `,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("typecheck_failed");
  });

  test("global upsert is lead-only and writes audit events", async () => {
    const denied = await upsert(
      { name: "global-denied", scope: "global", source: validSource(2) },
      workerId,
    );
    expect(denied.status).toBe(403);

    const allowed = await upsert(
      { name: "global-ok", scope: "global", source: validSource(2) },
      leadId,
    );
    expect(allowed.status).toBe(200);

    const event = getDb()
      .prepare<{ data: string }, []>(
        "SELECT data FROM events WHERE event = 'script.global_upsert' LIMIT 1",
      )
      .get();
    expect(event).toBeTruthy();
    expect(JSON.parse(event!.data).isNew).toBe(true);
  });

  test("global upsert promotion marks isPromotion when caller has agent script with same name", async () => {
    await upsert({ name: "promote-me", source: validSource(2) }, leadId);
    const res = await upsert(
      { name: "promote-me", scope: "global", source: validSource(3) },
      leadId,
    );
    expect(res.status).toBe(200);

    const event = getDb()
      .prepare<{ data: string }, []>(
        "SELECT data FROM events WHERE event = 'script.global_upsert' ORDER BY createdAt DESC LIMIT 1",
      )
      .get();
    expect(JSON.parse(event!.data).isPromotion).toBe(true);
  });

  test("failed promotion typecheck does not clear scratch flag", async () => {
    const inline = await dispatch("/api/scripts/run", {
      method: "POST",
      agentId: workerId,
      body: JSON.stringify({
        source: `const x: number = "runtime-ok"; export default async () => "ok";`,
        intent: "scratch promote",
      }),
    });
    expect(inline.status).toBe(200);
    const slug = (await inline.json()).autoSaved.slug as string;

    const failed = await upsert({
      name: slug,
      source: `const x: number = "no"; export default async () => x;`,
    });
    expect(failed.status).toBe(400);
    expect(getScript({ name: slug, scope: "agent", scopeId: workerId })?.isScratch).toBe(true);
  });

  test("run named scripts and inline scripts, auto-saving only successful inline source", async () => {
    await upsert({ name: "named-runner", source: validSource(4) });
    const named = await dispatch("/api/scripts/run", {
      method: "POST",
      agentId: workerId,
      body: JSON.stringify({ name: "named-runner", args: { value: 3 }, intent: "run named" }),
    });
    expect(named.status).toBe(200);
    expect((await named.json()).result).toEqual({ result: 12 });

    const inline = await dispatch("/api/scripts/run", {
      method: "POST",
      agentId: workerId,
      body: JSON.stringify({
        source: `const x: number = "not typechecked"; export default async () => ({ ok: x });`,
        intent: "inline type error still runs",
      }),
    });
    expect(inline.status).toBe(200);
    const inlineBody = await inline.json();
    expect(inlineBody.result).toEqual({ ok: "not typechecked" });
    expect(inlineBody.autoSaved.slug).toContain("scratch-inline-type-error-still-runs");

    const beforeFailed = listScripts({
      scope: "agent",
      scopeId: workerId,
      includeScratch: true,
    }).length;
    const failed = await dispatch("/api/scripts/run", {
      method: "POST",
      agentId: workerId,
      body: JSON.stringify({
        source: `export default async () => { throw new Error("boom"); };`,
        intent: "failing inline",
      }),
    });
    expect(failed.status).toBe(200);
    expect((await failed.json()).autoSaved).toBeUndefined();
    expect(listScripts({ scope: "agent", scopeId: workerId, includeScratch: true }).length).toBe(
      beforeFailed,
    );
  });

  test("workspace-rw named scripts return 501", async () => {
    await upsert({ name: "workspace", source: validSource(2), fsMode: "workspace-rw" });
    const res = await dispatch("/api/scripts/run", {
      method: "POST",
      agentId: workerId,
      body: JSON.stringify({ name: "workspace", args: { value: 1 }, intent: "workspace" }),
    });
    expect(res.status).toBe(501);
  });

  test("search, types, and delete routes work", async () => {
    await upsert({
      name: "lookup-helper",
      source: validSource(2),
      description: "Find lookup rows",
    });

    const search = await dispatch("/api/scripts/search", {
      method: "POST",
      agentId: workerId,
      body: JSON.stringify({ query: "lookup", limit: 5 }),
    });
    expect(search.status).toBe(200);
    expect((await search.json()).results[0].name).toBe("lookup-helper");

    const types = await dispatch("/api/scripts/lookup-helper/types", { agentId: workerId });
    expect(types.status).toBe(200);
    const typesBody = await types.json();
    expect(typesBody.sdkTypes).toContain("SwarmSdk");
    expect(typesBody.stdlibTypes).toContain('module "stdlib"');
    expect(typesBody.signature.argsType).toContain("value");

    const del = await dispatch("/api/scripts/lookup-helper", {
      method: "DELETE",
      agentId: workerId,
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect(getScript({ name: "lookup-helper", scope: "agent", scopeId: workerId })).toBeNull();
  });
});
