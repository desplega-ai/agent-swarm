import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createApiRegistryClient } from "../scripts-runtime/api-client";
import { runScript } from "../scripts-runtime/loader";
import {
  readScriptSdkJsonResponse,
  SCRIPT_SDK_RESPONSE_LIMIT_BYTES,
} from "../scripts-runtime/response-limit";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const resources = { memoryMb: 2048, cpuTimeSec: 20, maxStdoutBytes: 1_048_576 };
// The pre-push hook sets this only when its file-backed Bun sandbox probe exits
// 134 under the shared UID's RLIMIT_NPROC. CI leaves it unset and runs these tests.
const spawnTest = test.skipIf(process.env.SWARM_SKIP_SANDBOX_SPAWN_TESTS === "1");

beforeEach(() => {
  process.env.AGENT_SWARM_API_KEY = "runtime-test-secret-1234567890";
  delete process.env.API_KEY;
  process.env.MCP_BASE_URL = "http://localhost:3013";
  refreshSecretScrubberCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

describe("runScript", () => {
  test("script SDK accepts responses above the model-context ceiling", async () => {
    const blob = "x".repeat(20_000);
    const parsed = (await readScriptSdkJsonResponse(Response.json({ blob }), "ctx.swarm.test")) as {
      blob: string;
    };
    expect(parsed.blob).toBe(blob);
  });

  test("script SDK hard guard throws loudly instead of truncating", async () => {
    const response = new Response("{}", {
      headers: { "content-length": String(SCRIPT_SDK_RESPONSE_LIMIT_BYTES + 1) },
    });
    await expect(readScriptSdkJsonResponse(response, "ctx.swarm.test")).rejects.toThrow(
      /exceeded the .* hard limit/,
    );

    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"blob":"0123456789"}'));
          controller.close();
        },
      }),
    );
    await expect(readScriptSdkJsonResponse(streamed, "ctx.swarm.test", 10)).rejects.toThrow(
      /ctx\.swarm\.test exceeded the 10-byte hard limit/,
    );
  });

  spawnTest("runs a trivial transform", async () => {
    const output = await runScript({
      agentId: "agent-1",
      args: { x: 1 },
      resources,
      source: "export default async (args) => args.x + 1;",
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toBe(2);
    expect(output.exitCode).toBe(0);
  });

  spawnTest("ctx.stdlib.fetch returns a Response and fetchJson returns parsed JSON", async () => {
    const output = await runScript({
      agentId: "agent-1",
      args: { url: 'data:application/json,{"ok":true}' },
      resources,
      source: `
        export default async (args, ctx) => {
          const response = await ctx.stdlib.fetch(args.url);
          const parsed = await ctx.stdlib.fetchJson(args.url);
          return { status: response.status, parsed };
        };
      `,
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({ status: 200, parsed: { ok: true } });
  });

  spawnTest("ctx.swarm bridge round-trips kv_set then kv_get", async () => {
    const entries = new Map<string, unknown>();
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        expect(req.headers.get("authorization")).toBe("Bearer runtime-test-secret-1234567890");
        expect(req.headers.get("x-agent-id")).toBe("agent-1");

        const url = new URL(req.url);
        if (req.method === "PUT" && url.pathname.startsWith("/api/kv/")) {
          const key = decodeURIComponent(url.pathname.slice("/api/kv/".length));
          const body = (await req.json()) as { value: unknown };
          entries.set(key, body.value);
          return Response.json({ key, value: body.value });
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/kv/")) {
          const key = decodeURIComponent(url.pathname.slice("/api/kv/".length));
          return Response.json({ key, value: entries.get(key) ?? null });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    try {
      const output = await runScript({
        agentId: "agent-1",
        mcpBaseUrl: `http://127.0.0.1:${server.port}`,
        resources,
        source: `
          export default async (_args, ctx) => {
            await ctx.swarm.kv_set({ key: "bridge-smoke", value: { ok: true } });
            return await ctx.swarm.kv_get({ key: "bridge-smoke" });
          };
        `,
      });

      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({
        success: true,
        status: 200,
        data: { key: "bridge-smoke", value: { ok: true } },
      });
    } finally {
      server.stop(true);
    }
  });

  spawnTest("ctx.swarm exposes nullable KV reads and both hard-delete names", async () => {
    const deleted: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const key = decodeURIComponent(url.pathname.slice("/api/kv/".length));
        if (req.method === "GET" && key === "present") {
          return Response.json({
            namespace: "task:agent:agent-1",
            key,
            value: { ok: true },
            valueType: "json",
            expiresAt: null,
            createdAt: 1,
            updatedAt: 1,
          });
        }
        if (req.method === "GET" && key === "forbidden") {
          return Response.json({ error: "denied" }, { status: 403 });
        }
        if (req.method === "GET") {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        if (req.method === "DELETE") {
          deleted.push(key);
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: "unexpected request" }, { status: 500 });
      },
    });

    try {
      const output = await runScript({
        agentId: "agent-1",
        mcpBaseUrl: `http://127.0.0.1:${server.port}`,
        resources,
        source: `
          export default async (_args, ctx) => {
            const present = await ctx.swarm.kv_getOrNull({ key: "present" });
            const missing = await ctx.swarm.kv_getOrNull({ key: "missing" });
            const legacyMiss = await ctx.swarm.kv_get({ key: "missing" });
            const canonicalDelete = await ctx.swarm.kv_delete({ key: "canonical" });
            const legacyDelete = await ctx.swarm.kv_del({ key: "legacy" });
            let forbidden = "did not throw";
            try {
              await ctx.swarm.kv_getOrNull({ key: "forbidden" });
            } catch (error) {
              forbidden = String(error.message ?? error);
            }
            return { present, missing, legacyMiss, canonicalDelete, legacyDelete, forbidden };
          };
        `,
      });

      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({
        present: {
          namespace: "task:agent:agent-1",
          key: "present",
          value: { ok: true },
          valueType: "json",
          expiresAt: null,
          createdAt: 1,
          updatedAt: 1,
        },
        missing: null,
        legacyMiss: {
          success: false,
          status: 404,
          data: { error: "not found" },
        },
        canonicalDelete: { success: true, status: 204, data: {} },
        legacyDelete: { success: true, status: 204, data: {} },
        forbidden: "swarm-sdk: kv_getOrNull failed with 403: denied",
      });
      expect(deleted).toEqual(["canonical", "legacy"]);
    } finally {
      server.stop(true);
    }
  });

  spawnTest("bare stdlib imports resolve through runtime shims", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources,
      source: `
        import { table } from "stdlib";
        export default async () => table([{ a: 1 }]);
      `,
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toContain("a");
    expect(output.result).toContain("1");
  });

  spawnTest("timeout kills a running script", async () => {
    const started = Date.now();
    const output = await runScript({
      agentId: "agent-1",
      timeoutMs: 150,
      resources: { ...resources, wallClockMs: 150 },
      source: "export default async () => new Promise(() => {});",
    });

    expect(output.error).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  spawnTest("stdout is capped and marked truncated", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources: { ...resources, maxStdoutBytes: 128 },
      source: "export default async () => { console.log('x'.repeat(2048)); return 'ok'; };",
    });

    expect(output.result).toBe("ok");
    expect(output.truncated.stdout).toBe(true);
    expect(output.stdout.length).toBeLessThanOrEqual(128);
  });

  spawnTest("AbortSignal aborts a running script", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();

    const output = await runScript({
      agentId: "agent-1",
      signal: controller.signal,
      resources,
      source: "export default async () => new Promise(() => {});",
    });

    expect(output.error).toBe("killed");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  spawnTest("subprocess env is stripped to the explicit allowlist", async () => {
    process.env.API_KEY = "legacy-secret-that-must-not-leak";
    process.env.AGENT_SWARM_API_KEY = "preferred-secret-that-must-not-leak";
    refreshSecretScrubberCache();

    const output = await runScript({
      agentId: "agent-1",
      resources,
      // Bun >= 1.4 injects BUN_FEATURE_FLAG_NO_ORPHANS=1 into the harness in
      // response to its own --no-orphans flag (so nested Bun children inherit
      // it); Bun 1.3 does not. That one runtime-owned key is excluded so the
      // rest of the comparison stays exact and any other injection still fails.
      source: `
        export default async () => ({
          keys: Object.keys(process.env).filter((k) => k !== "BUN_FEATURE_FLAG_NO_ORPHANS").sort(),
          apiKey: process.env.API_KEY,
          agentSwarmApiKey: process.env.AGENT_SWARM_API_KEY,
        });
      `,
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({
      keys: [
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "SWARM_SCRIPT_ARGS_FILE",
        "SWARM_SCRIPT_ERROR_FILE",
        "SWARM_SCRIPT_RESULT_FILE",
        "SWARM_SCRIPT_SOURCE_FILE",
        "SWARM_SCRIPT_TMPDIR",
        "TMPDIR",
      ],
    });
  });

  test("workspace-rw is rejected in v1", async () => {
    const output = await runScript({
      agentId: "agent-1",
      fsMode: "workspace-rw",
      source: "export default async () => true;",
    });

    expect(output.error).toBe("executor_error");
    expect(output.stderr).toContain("workspace-rw");
  });

  spawnTest("SCRIPT_RUNTIME_DIR bundle path works (compiled binary mode regression)", async () => {
    // Simulate compiled binary mode: pre-build bundles to a temp dir and set
    // SCRIPT_RUNTIME_DIR so the executor uses them instead of import.meta.url paths.
    const tmpdir = `${process.env.TMPDIR ?? "/tmp"}/script-runtime-test-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${tmpdir}`;
    try {
      const runtimeSrc = fileURLToPath(new URL("../scripts-runtime", import.meta.url));
      await Bun.$`bun build ${runtimeSrc}/eval-harness.ts --target bun --no-splitting --outfile ${tmpdir}/eval-harness.bundle.js`.quiet();
      await Bun.$`bun build ${runtimeSrc}/stdlib/index.ts --target bun --no-splitting --outfile ${tmpdir}/stdlib.bundle.js`.quiet();
      await Bun.$`bun build ${runtimeSrc}/swarm-sdk.ts --target bun --no-splitting --outfile ${tmpdir}/swarm-sdk.bundle.js`.quiet();

      process.env.SCRIPT_RUNTIME_DIR = tmpdir;

      const output = await runScript({
        agentId: "agent-1",
        args: { x: 42 },
        resources,
        source: "export default async (args) => args.x * 2;",
      });

      expect(output.error).toBeUndefined();
      expect(output.result).toBe(84);
      expect(output.exitCode).toBe(0);
    } finally {
      delete process.env.SCRIPT_RUNTIME_DIR;
      await Bun.$`rm -rf ${tmpdir}`;
    }
  });

  spawnTest("args arrives as a parsed object, not a JSON string", async () => {
    // Regression: eval-harness must deliver a parsed object to user code even
    // when the caller serializes args as a JSON string (double-serialization).
    // Before the fix, property access like args.foo would always be undefined.
    const output = await runScript({
      agentId: "agent-1",
      args: { foo: "bar" },
      resources,
      source: `
        export default async (args) => {
          if (typeof args !== "object" || args === null) throw new Error("args is not an object: " + typeof args);
          if (args.foo !== "bar") throw new Error("args.foo expected 'bar', got: " + args.foo);
          return { ok: true, foo: args.foo };
        };
      `,
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({ ok: true, foo: "bar" });
    expect(output.exitCode).toBe(0);
  });

  spawnTest("args parsed correctly in compiled binary mode (SCRIPT_RUNTIME_DIR)", async () => {
    // Same regression exercised through the compiled-binary (SCRIPT_RUNTIME_DIR) code path.
    const tmpdir = `${process.env.TMPDIR ?? "/tmp"}/script-runtime-test-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${tmpdir}`;
    try {
      const runtimeSrc = fileURLToPath(new URL("../scripts-runtime", import.meta.url));
      await Bun.$`bun build ${runtimeSrc}/eval-harness.ts --target bun --no-splitting --outfile ${tmpdir}/eval-harness.bundle.js`.quiet();
      await Bun.$`bun build ${runtimeSrc}/stdlib/index.ts --target bun --no-splitting --outfile ${tmpdir}/stdlib.bundle.js`.quiet();
      await Bun.$`bun build ${runtimeSrc}/swarm-sdk.ts --target bun --no-splitting --outfile ${tmpdir}/swarm-sdk.bundle.js`.quiet();

      process.env.SCRIPT_RUNTIME_DIR = tmpdir;

      const output = await runScript({
        agentId: "agent-1",
        args: { foo: "bar" },
        resources,
        source: `
          export default async (args) => {
            if (typeof args !== "object" || args === null) throw new Error("args is not an object: " + typeof args);
            if (args.foo !== "bar") throw new Error("args.foo expected 'bar', got: " + args.foo);
            return { ok: true, foo: args.foo };
          };
        `,
      });

      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({ ok: true, foo: "bar" });
      expect(output.exitCode).toBe(0);
    } finally {
      delete process.env.SCRIPT_RUNTIME_DIR;
      await Bun.$`rm -rf ${tmpdir}`;
    }
  });

  spawnTest("zod import works in compiled binary mode (SCRIPT_RUNTIME_DIR)", async () => {
    const tmpdir = `${process.env.TMPDIR ?? "/tmp"}/script-runtime-test-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${tmpdir}`;
    try {
      const runtimeSrc = fileURLToPath(new URL("../scripts-runtime", import.meta.url));
      await Bun.$`bun build ${runtimeSrc}/eval-harness.ts --target bun --no-splitting --outfile ${tmpdir}/eval-harness.bundle.js`.quiet();
      await Bun.$`bun build ${runtimeSrc}/stdlib/index.ts --target bun --no-splitting --outfile ${tmpdir}/stdlib.bundle.js`.quiet();
      await Bun.$`bun build ${runtimeSrc}/swarm-sdk.ts --target bun --no-splitting --outfile ${tmpdir}/swarm-sdk.bundle.js`.quiet();
      const zodEntry = Bun.resolveSync("zod", import.meta.dir);
      await Bun.$`bun build ${zodEntry} --target bun --no-splitting --outfile ${tmpdir}/zod.bundle.js`.quiet();

      process.env.SCRIPT_RUNTIME_DIR = tmpdir;

      const output = await runScript({
        agentId: "agent-1",
        args: { name: "test" },
        resources,
        source: `
          import { z } from "zod";
          export const argsSchema = z.object({ name: z.string() });
          export default async (args: z.infer<typeof argsSchema>) => ({ greeting: "hello " + args.name });
        `,
      });

      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({ greeting: "hello test" });
      expect(output.exitCode).toBe(0);
    } finally {
      delete process.env.SCRIPT_RUNTIME_DIR;
      await Bun.$`rm -rf ${tmpdir}`;
    }
  });

  spawnTest("argsSchema rejects invalid args with a formatted Zod error", async () => {
    const output = await runScript({
      agentId: "agent-1",
      args: {},
      resources,
      source: `
        import { z } from "zod";
        export const argsSchema = z.object({
          repo: z.string(),
        });
        export default async (args: z.infer<typeof argsSchema>) => ({ repo: args.repo });
      `,
    });

    expect(output.error).toBeDefined();
    expect(output.exitCode).not.toBe(0);
    expect(output.stderr).toContain("argsSchema validation failed");
    expect(output.stderr).toContain("repo");
  });

  spawnTest("argsSchema applies .default() values when fields are omitted", async () => {
    const output = await runScript({
      agentId: "agent-1",
      args: { repo: "owner/name" },
      resources,
      source: `
        import { z } from "zod";
        export const argsSchema = z.object({
          repo: z.string(),
          limit: z.number().default(10),
        });
        export default async (args: z.infer<typeof argsSchema>) => ({ repo: args.repo, limit: args.limit });
      `,
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({ repo: "owner/name", limit: 10 });
    expect(output.exitCode).toBe(0);
  });

  spawnTest("script without argsSchema still works (backward-compat)", async () => {
    const output = await runScript({
      agentId: "agent-1",
      args: { value: 42 },
      resources,
      source: `
        export default async (args: { value: number }) => ({ doubled: args.value * 2 });
      `,
    });

    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({ doubled: 84 });
    expect(output.exitCode).toBe(0);
  });

  test("ctx.api GraphQL client posts JSON body with credential placeholders", async () => {
    let observed: {
      url: string;
      method: string;
      contentType: string | null;
      authorization: string | null;
      body: unknown;
    } | null = null;
    globalThis.fetch = (async (input, init) => {
      observed = {
        url: String(input),
        method: init?.method ?? "GET",
        contentType: new Headers(init?.headers).get("content-type"),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({ data: { country: { name: "Ukraine", capital: "Kyiv" } } });
    }) as typeof fetch;

    const client = createApiRegistryClient([
      {
        slug: "countries",
        kind: "graphql",
        baseUrl: "https://countries.vendor.test/graphql",
        credential: {
          configKey: "COUNTRIES_KEY",
          headerTemplate: "Authorization: Bearer [REDACTED:COUNTRIES_KEY]",
        },
      },
    ]);

    const result = await client.countries.graphql(
      "query Country($code: ID!) { country(code: $code) { name capital } }",
      {
        code: "UA",
      },
    );

    expect(result).toEqual({ country: { name: "Ukraine", capital: "Kyiv" } });
    expect(observed).toEqual({
      url: "https://countries.vendor.test/graphql",
      method: "POST",
      contentType: "application/json",
      authorization: "Bearer [REDACTED:COUNTRIES_KEY]",
      body: {
        query: "query Country($code: ID!) { country(code: $code) { name capital } }",
        variables: { code: "UA" },
      },
    });
  });

  test("ctx.api OpenAPI client preserves the baseUrl path prefix for absolute spec paths", async () => {
    let observedUrl = "";
    globalThis.fetch = (async (input) => {
      observedUrl = String(input);
      return Response.json({ ok: true });
    }) as typeof fetch;

    const client = createApiRegistryClient([
      {
        slug: "petstore",
        kind: "openapi",
        baseUrl: "https://petstore.vendor.test/api/v3",
        credential: null,
        operations: [
          {
            name: "getInventory",
            method: "GET",
            path: "/store/inventory",
            parameters: [],
            hasBody: false,
            successStatus: "200",
            requestType: "PetstoreGetInventoryArgs",
            responseType: "PetstoreGetInventoryResponse",
          },
        ],
      },
    ]);

    await client.petstore.getInventory({});
    expect(observedUrl).toBe("https://petstore.vendor.test/api/v3/store/inventory");
  });

  test("ctx.api OpenAPI client default path still parses 2xx bodies", async () => {
    const client = createApiRegistryClient(
      [
        {
          slug: "repos",
          kind: "openapi",
          baseUrl: "https://api.vendor.test",
          credential: null,
          operations: [
            {
              name: "getRepo",
              method: "GET",
              path: "/repos/{owner}/{repo}",
              parameters: [
                { name: "owner", in: "path", required: true, schema: {} },
                { name: "repo", in: "path", required: true, schema: {} },
              ],
              hasBody: false,
              successStatus: "200",
              responseSchema: {},
              requestType: "ReposGetRepoArgs",
              responseType: "ReposGetRepoResponse",
            },
          ],
        },
      ],
      {
        fetch: (async () =>
          Response.json({ full_name: "desplega-ai/agent-swarm" })) as typeof fetch,
      },
    );

    await expect(
      client.repos.getRepo({ path: { owner: "desplega-ai", repo: "agent-swarm" } }),
    ).resolves.toEqual({ full_name: "desplega-ai/agent-swarm" });
  });

  test("ctx.api OpenAPI client enriches default non-2xx errors", async () => {
    const client = createApiRegistryClient(
      [
        {
          slug: "repos",
          kind: "openapi",
          baseUrl: "https://api.vendor.test",
          credential: null,
          operations: [
            {
              name: "getRepo",
              method: "GET",
              path: "/repos/{owner}/{repo}",
              parameters: [
                { name: "owner", in: "path", required: true, schema: {} },
                { name: "repo", in: "path", required: true, schema: {} },
              ],
              hasBody: false,
              successStatus: "200",
              responseSchema: {},
              requestType: "ReposGetRepoArgs",
              responseType: "ReposGetRepoResponse",
            },
          ],
        },
      ],
      {
        fetch: (async () =>
          Response.json(
            { error: "missing" },
            { status: 404, statusText: "Not Found" },
          )) as typeof fetch,
      },
    );

    try {
      await client.repos.getRepo({ path: { owner: "desplega-ai", repo: "missing" } });
      throw new Error("expected request to throw");
    } catch (error) {
      const err = error as Error & {
        status?: number;
        statusText?: string;
        body?: unknown;
        response?: Response;
      };
      expect(err.message).toBe("ctx.api.repos.getRepo failed with 404");
      expect(err.status).toBe(404);
      expect(err.statusText).toBe("Not Found");
      expect(err.body).toEqual({ error: "missing" });
      expect(err.response?.status).toBe(404);
      expect(await err.response?.json()).toEqual({ error: "missing" });
    }
  });

  test("ctx.api OpenAPI client raw mode returns binary 2xx responses without parsing", async () => {
    let observedAuthorization: string | null = null;
    const client = createApiRegistryClient(
      [
        {
          slug: "studioApi",
          kind: "openapi",
          baseUrl: "https://studio.vendor.test",
          credential: {
            configKey: "STUDIO_API_KEY",
            headerTemplate: "Authorization: Bearer [REDACTED:STUDIO_API_KEY]",
          },
          operations: [
            {
              name: "downloadRenderFile",
              method: "GET",
              path: "/renders/{id}/file",
              parameters: [{ name: "id", in: "path", required: true, schema: {} }],
              hasBody: false,
              successStatus: "200",
              responseSchema: {},
              requestType: "StudioApiDownloadRenderFileArgs",
              responseType: "StudioApiDownloadRenderFileResponse",
            },
          ],
        },
      ],
      {
        fetch: (async (_input, init) => {
          observedAuthorization = new Headers(init?.headers).get("authorization");
          return new Response(new Uint8Array([0, 1, 255]), {
            status: 200,
            headers: { "content-type": "application/octet-stream", "x-render-id": "render-123" },
          });
        }) as typeof fetch,
      },
    );

    const result = (await client.studioApi.downloadRenderFile(
      { path: { id: "render-123" } },
      { raw: true },
    )) as { ok: boolean; status: number; headers: Record<string, string>; response: Response };

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.headers).toBeTypeOf("object");
    expect(Array.from(new Uint8Array(await result.response.arrayBuffer()))).toEqual([0, 1, 255]);
    expect(observedAuthorization).toBe("Bearer [REDACTED:STUDIO_API_KEY]");
  });

  test("ctx.api OpenAPI client raw mode returns non-2xx responses without throwing", async () => {
    const client = createApiRegistryClient(
      [
        {
          slug: "repos",
          kind: "openapi",
          baseUrl: "https://api.vendor.test",
          credential: null,
          operations: [
            {
              name: "getRepo",
              method: "GET",
              path: "/repos/{owner}/{repo}",
              parameters: [
                { name: "owner", in: "path", required: true, schema: {} },
                { name: "repo", in: "path", required: true, schema: {} },
              ],
              hasBody: false,
              successStatus: "200",
              responseSchema: {},
              requestType: "ReposGetRepoArgs",
              responseType: "ReposGetRepoResponse",
            },
          ],
        },
      ],
      {
        fetch: (async () =>
          Response.json(
            { error: "rate limited" },
            { status: 429, statusText: "Too Many Requests" },
          )) as typeof fetch,
      },
    );

    const result = (await client.repos.getRepo(
      { path: { owner: "desplega-ai", repo: "agent-swarm" } },
      { raw: true },
    )) as { ok: boolean; status: number; statusText: string; response: Response };

    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.statusText).toBe("Too Many Requests");
    expect(await result.response.json()).toEqual({ error: "rate limited" });
  });

  test("ctx.api OpenAPI client throws on an unknown top-level argument with a did-you-mean hint", async () => {
    let fetchCalled = false;
    const client = createApiRegistryClient(
      [
        {
          slug: "composio",
          kind: "openapi",
          baseUrl: "https://api.composio.test",
          credential: null,
          operations: [
            {
              name: "getV31ConnectedAccounts",
              method: "GET",
              path: "/v3/connected_accounts",
              parameters: [{ name: "user_ids", in: "query", required: false, schema: {} }],
              hasBody: false,
              successStatus: "200",
              responseSchema: {},
              requestType: "ComposioGetV31ConnectedAccountsArgs",
              responseType: "ComposioGetV31ConnectedAccountsResponse",
            },
          ],
        },
      ],
      {
        fetch: (async () => {
          fetchCalled = true;
          return Response.json({});
        }) as typeof fetch,
      },
    );

    await expect(
      client.composio.getV31ConnectedAccounts({ userIds: ["t@desplega.ai"] }),
    ).rejects.toThrow(
      'ctx.api.composio.getV31ConnectedAccounts: unknown top-level argument "userIds". ' +
        "Did you mean `query: { user_ids: ... }`? Allowed top-level keys: query.",
    );
    // Validation must reject before any network call is made.
    expect(fetchCalled).toBe(false);
  });

  test("ctx.api OpenAPI client throws on an unrelated unknown top-level argument without a hint", async () => {
    const client = createApiRegistryClient([
      {
        slug: "composio",
        kind: "openapi",
        baseUrl: "https://api.composio.test",
        credential: null,
        operations: [
          {
            name: "getV31ConnectedAccounts",
            method: "GET",
            path: "/v3/connected_accounts",
            parameters: [{ name: "user_ids", in: "query", required: false, schema: {} }],
            hasBody: false,
            successStatus: "200",
            responseSchema: {},
            requestType: "ComposioGetV31ConnectedAccountsArgs",
            responseType: "ComposioGetV31ConnectedAccountsResponse",
          },
        ],
      },
    ]);

    await expect(client.composio.getV31ConnectedAccounts({ foo: 1 })).rejects.toThrow(
      'ctx.api.composio.getV31ConnectedAccounts: unknown top-level argument "foo". ' +
        "Allowed top-level keys: query.",
    );
  });

  test("ctx.api OpenAPI client rejects a body argument on an operation with hasBody: false", async () => {
    const client = createApiRegistryClient([
      {
        slug: "composio",
        kind: "openapi",
        baseUrl: "https://api.composio.test",
        credential: null,
        operations: [
          {
            name: "getV31ConnectedAccounts",
            method: "GET",
            path: "/v3/connected_accounts",
            parameters: [{ name: "user_ids", in: "query", required: false, schema: {} }],
            hasBody: false,
            successStatus: "200",
            responseSchema: {},
            requestType: "ComposioGetV31ConnectedAccountsArgs",
            responseType: "ComposioGetV31ConnectedAccountsResponse",
          },
        ],
      },
    ]);

    await expect(
      client.composio.getV31ConnectedAccounts({ body: { user_ids: ["t@desplega.ai"] } }),
    ).rejects.toThrow(
      'ctx.api.composio.getV31ConnectedAccounts: unknown top-level argument "body". ' +
        "Allowed top-level keys: query.",
    );
  });

  test("ctx.api OpenAPI client still accepts a correctly nested query call and serializes arrays as repeated params", async () => {
    let observedUrl = "";
    const client = createApiRegistryClient(
      [
        {
          slug: "composio",
          kind: "openapi",
          baseUrl: "https://api.composio.test",
          credential: null,
          operations: [
            {
              name: "getV31ConnectedAccounts",
              method: "GET",
              path: "/v3/connected_accounts",
              parameters: [{ name: "user_ids", in: "query", required: false, schema: {} }],
              hasBody: false,
              successStatus: "200",
              responseSchema: {},
              requestType: "ComposioGetV31ConnectedAccountsArgs",
              responseType: "ComposioGetV31ConnectedAccountsResponse",
            },
          ],
        },
      ],
      {
        fetch: (async (input) => {
          observedUrl = String(input);
          return Response.json({ items: [] });
        }) as typeof fetch,
      },
    );

    const result = await client.composio.getV31ConnectedAccounts({
      query: { user_ids: ["t@desplega.ai", "eze@desplega.ai"] },
    });

    expect(result).toEqual({ items: [] });
    const url = new URL(observedUrl);
    expect(url.searchParams.getAll("user_ids")).toEqual(["t@desplega.ai", "eze@desplega.ai"]);
    expect(observedUrl).not.toContain("t@desplega.ai,eze@desplega.ai");
  });

  test("ctx.api OpenAPI client serializes array header params as a single coalesced header", async () => {
    let observedToolkitSlugs: string | null = null;
    const client = createApiRegistryClient(
      [
        {
          slug: "composio",
          kind: "openapi",
          baseUrl: "https://api.composio.test",
          credential: null,
          operations: [
            {
              name: "listToolkits",
              method: "GET",
              path: "/v3/toolkits",
              parameters: [{ name: "toolkit_slugs", in: "header", required: false, schema: {} }],
              hasBody: false,
              successStatus: "200",
              responseSchema: {},
              requestType: "ComposioListToolkitsArgs",
              responseType: "ComposioListToolkitsResponse",
            },
          ],
        },
      ],
      {
        fetch: (async (_input, init) => {
          observedToolkitSlugs = new Headers(init?.headers).get("toolkit_slugs");
          return Response.json({ items: [] });
        }) as typeof fetch,
      },
    );

    await client.composio.listToolkits({ header: { toolkit_slugs: ["gmail", "slack"] } });

    expect(observedToolkitSlugs).toBe("gmail, slack");
  });

  test("ctx.api OpenAPI client validates top-level args before making a request in raw mode", async () => {
    let fetchCalled = false;
    const client = createApiRegistryClient(
      [
        {
          slug: "repos",
          kind: "openapi",
          baseUrl: "https://api.vendor.test",
          credential: null,
          operations: [
            {
              name: "getRepo",
              method: "GET",
              path: "/repos/{owner}/{repo}",
              parameters: [
                { name: "owner", in: "path", required: true, schema: {} },
                { name: "repo", in: "path", required: true, schema: {} },
              ],
              hasBody: false,
              successStatus: "200",
              responseSchema: {},
              requestType: "ReposGetRepoArgs",
              responseType: "ReposGetRepoResponse",
            },
          ],
        },
      ],
      {
        fetch: (async () => {
          fetchCalled = true;
          return Response.json({});
        }) as typeof fetch,
      },
    );

    await expect(
      client.repos.getRepo({ owner: "desplega-ai", repo: "agent-swarm" }, { raw: true }),
    ).rejects.toThrow(/unknown top-level arguments "owner", "repo"/);
    expect(fetchCalled).toBe(false);
  });

  test("ctx.api GraphQL client throws on errors-only responses", async () => {
    globalThis.fetch = (async () =>
      Response.json({ errors: [{ message: "Cannot query field nope" }] })) as typeof fetch;

    const client = createApiRegistryClient([
      {
        slug: "countries",
        kind: "graphql",
        baseUrl: "https://countries.vendor.test/graphql",
        credential: null,
      },
    ]);

    await expect(client.countries.graphql("query { nope }")).rejects.toThrow(
      /Cannot query field nope/,
    );
  });
});
