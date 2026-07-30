import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApiRegistryClient } from "../scripts-runtime/api-client";
import { runScript } from "../scripts-runtime/loader";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const resources = { memoryMb: 2048, cpuTimeSec: 20, maxStdoutBytes: 1_048_576 };

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
  test("runs a trivial transform", async () => {
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

  test("ctx.stdlib.fetch returns a Response and fetchJson returns parsed JSON", async () => {
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

  test("ctx.swarm bridge round-trips kv_set then kv_get", async () => {
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

  test("bare stdlib imports resolve through runtime shims", async () => {
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

  test("timeout kills a running script", async () => {
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

  test("stdout is capped and marked truncated", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources: { ...resources, maxStdoutBytes: 128 },
      source: "export default async () => { console.log('x'.repeat(2048)); return 'ok'; };",
    });

    expect(output.result).toBe("ok");
    expect(output.truncated.stdout).toBe(true);
    expect(output.stdout.length).toBeLessThanOrEqual(128);
  });

  test("AbortSignal aborts a running script", async () => {
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

  test("subprocess env is stripped to the explicit allowlist", async () => {
    process.env.API_KEY = "legacy-secret-that-must-not-leak";
    process.env.AGENT_SWARM_API_KEY = "preferred-secret-that-must-not-leak";
    refreshSecretScrubberCache();

    const output = await runScript({
      agentId: "agent-1",
      resources,
      source: `
        export default async () => ({
          keys: Object.keys(process.env).sort(),
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

  test("SCRIPT_RUNTIME_DIR bundle path works (compiled binary mode regression)", async () => {
    // Simulate compiled binary mode: pre-build bundles to a temp dir and set
    // SCRIPT_RUNTIME_DIR so the executor uses them instead of import.meta.url paths.
    const tmpdir = `${process.env.TMPDIR ?? "/tmp"}/script-runtime-test-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${tmpdir}`;
    try {
      const runtimeSrc = new URL("../scripts-runtime", import.meta.url).pathname;
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

  test("args arrives as a parsed object, not a JSON string", async () => {
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

  test("args parsed correctly in compiled binary mode (SCRIPT_RUNTIME_DIR)", async () => {
    // Same regression exercised through the compiled-binary (SCRIPT_RUNTIME_DIR) code path.
    const tmpdir = `${process.env.TMPDIR ?? "/tmp"}/script-runtime-test-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${tmpdir}`;
    try {
      const runtimeSrc = new URL("../scripts-runtime", import.meta.url).pathname;
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

  test("zod import works in compiled binary mode (SCRIPT_RUNTIME_DIR)", async () => {
    const tmpdir = `${process.env.TMPDIR ?? "/tmp"}/script-runtime-test-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${tmpdir}`;
    try {
      const runtimeSrc = new URL("../scripts-runtime", import.meta.url).pathname;
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

  test("argsSchema rejects invalid args with a formatted Zod error", async () => {
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

  test("argsSchema applies .default() values when fields are omitted", async () => {
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

  test("script without argsSchema still works (backward-compat)", async () => {
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
