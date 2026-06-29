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

  test("upsert typecheck failure surfaces structured diagnostics with location + identifier", async () => {
    const res = await upsert({
      name: "structured-diag",
      source: `export default async () => { return noSuchGlobal; };`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      structured: Array<{
        severity: string;
        code: number;
        message: string;
        file: string;
        line: number;
        column: number;
        identifier?: string;
      }>;
    };
    expect(body.error).toBe("typecheck_failed");
    expect(Array.isArray(body.structured)).toBe(true);
    const cantFind = body.structured.find((d) => d.code === 2304 || d.code === 2552);
    expect(cantFind).toBeDefined();
    expect(cantFind?.severity).toBe("error");
    expect(cantFind?.identifier).toBe("noSuchGlobal");
    expect(cantFind?.line).toBeGreaterThan(0);
    expect(cantFind?.column).toBeGreaterThan(0);
  });

  test("upsert typecheck surfaces 'did you mean' suggestions when TS offers one", async () => {
    const res = await upsert({
      name: "did-you-mean",
      source: `export default async () => Mat.floor(3.7);`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      structured: Array<{ code: number; suggestion?: string; identifier?: string }>;
    };
    const hint = body.structured.find((d) => d.code === 2552);
    expect(hint).toBeDefined();
    expect(hint?.identifier).toBe("Mat");
    expect(hint?.suggestion).toBe("Math");
  });

  test("upsert accepts runtime-shaped TypeScript: Promise<T>, Array<T>, Error, fetch, JSON, Date", async () => {
    // Litmus from #gtm `daily-growth-snapshot` thread — these patterns all
    // failed against the old typecheck and forced authors into `any`-everywhere
    // contortions. They MUST all pass now without any escape hatches.
    const source = `
      export default async function main(args: { url: string }): Promise<{ count: number; titles: string[]; when: string }> {
        if (typeof args.url !== "string") throw new Error("url required");
        const res = await fetch(args.url);
        const body = await res.json() as { items: Array<{ title: string }> };
        const titles: string[] = body.items.map((item) => item.title);
        const payload = { count: titles.length, titles, when: new Date().toISOString() };
        const _serialized: string = JSON.stringify(payload);
        const _all: number[] = await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
        return payload;
      }
    `;
    const res = await upsert({ name: "runtime-shaped-clean", source });
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(1);
  });

  test("inline script throws and run response carries structured runtimeError", async () => {
    const res = await dispatch("/api/scripts/run", {
      method: "POST",
      agentId: workerId,
      body: JSON.stringify({
        source: `
          export default async () => {
            const x: number = 1;
            if (x === 1) {
              throw new Error("kaboom from line 4");
            }
            return x;
          };
        `,
        intent: "runtime error",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runtimeError?: {
        name: string;
        message: string;
        stack: string;
        userScriptLine?: number;
        userScriptColumn?: number;
        userFrames: Array<{ file: string; line: number; column: number }>;
      };
      stderr: string;
      exitCode: number;
    };
    expect(body.exitCode).not.toBe(0);
    expect(body.runtimeError).toBeDefined();
    expect(body.runtimeError?.name).toBe("Error");
    expect(body.runtimeError?.message).toContain("kaboom from line 4");
    // userFrames may be empty under some Bun stack-formatting modes; when
    // present, the first user frame must point at user-script.ts.
    if (body.runtimeError?.userFrames && body.runtimeError.userFrames.length > 0) {
      expect(body.runtimeError.userFrames[0].file).toBe("user-script.ts");
      expect(body.runtimeError.userFrames[0].line).toBeGreaterThan(0);
      expect(body.runtimeError.userScriptLine).toBeGreaterThan(0);
    }
    // stderr should NOT leak the absolute tmpdir path of the harness;
    // user-script.ts must be referenced by basename.
    expect(body.stderr).not.toContain("/swarm-script-");
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

  test("non-lead agents can upsert and delete global scripts", async () => {
    const allowed = await upsert(
      { name: "global-worker-ok", scope: "global", source: validSource(2) },
      workerId,
    );
    expect(allowed.status).toBe(200);
    expect(getScript({ name: "global-worker-ok", scope: "global", scopeId: null })).toBeTruthy();

    const event = getDb()
      .prepare<{ data: string }, []>(
        "SELECT data FROM events WHERE event = 'script.global_upsert' LIMIT 1",
      )
      .get();
    expect(event).toBeTruthy();
    expect(JSON.parse(event!.data)).toMatchObject({
      isNew: true,
      changedByAgentId: workerId,
    });

    const del = await dispatch("/api/scripts/global-worker-ok?scope=global", {
      method: "DELETE",
      agentId: workerId,
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    expect(getScript({ name: "global-worker-ok", scope: "global", scopeId: null })).toBeNull();
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

  test("script_query_types returns argsJsonSchema for a script with argsSchema export", async () => {
    const source = `
      import { z } from "zod";
      export const argsSchema = z.object({
        repo: z.string(),
        limit: z.number().default(10),
      });
      export default async (args: z.infer<typeof argsSchema>) => ({ repo: args.repo });
    `;
    await upsert({ name: "schema-script", source });

    const types = await dispatch("/api/scripts/schema-script/types", { agentId: workerId });
    expect(types.status).toBe(200);
    const body = (await types.json()) as { argsJsonSchema: unknown };
    expect(body.argsJsonSchema).not.toBeNull();
    expect(typeof body.argsJsonSchema).toBe("object");
    // JSON Schema should describe the repo and limit properties
    const schema = body.argsJsonSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("repo");
    expect(schema.properties).toHaveProperty("limit");
  });

  test("script_query_types returns argsJsonSchema: null for a script without argsSchema", async () => {
    await upsert({ name: "no-schema-script", source: validSource(3) });

    const types = await dispatch("/api/scripts/no-schema-script/types", { agentId: workerId });
    expect(types.status).toBe(200);
    const body = (await types.json()) as { argsJsonSchema: unknown };
    expect(body.argsJsonSchema).toBeNull();
  });

  test("script_search includes argsJsonSchema in results", async () => {
    const source = `
      import { z } from "zod";
      export const argsSchema = z.object({ query: z.string() });
      export default async (args: z.infer<typeof argsSchema>) => ({ result: args.query });
    `;
    await upsert({ name: "search-with-schema", source, description: "search result helper" });

    const search = await dispatch("/api/scripts/search", {
      method: "POST",
      agentId: workerId,
      body: JSON.stringify({ query: "search result helper", limit: 5 }),
    });
    expect(search.status).toBe(200);
    const body = (await search.json()) as {
      results: Array<{ name: string; argsJsonSchema: unknown }>;
    };
    const result = body.results.find((r) => r.name === "search-with-schema");
    expect(result).toBeDefined();
    expect(result?.argsJsonSchema).not.toBeNull();
  });
});
