import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runScript } from "../scripts-runtime/loader";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const savedEnv = { ...process.env };
const resources = { memoryMb: 2048, cpuTimeSec: 20, maxStdoutBytes: 1_048_576 };

beforeEach(() => {
  process.env.AGENT_SWARM_API_KEY = "runtime-test-secret-1234567890";
  delete process.env.API_KEY;
  process.env.MCP_BASE_URL = "http://localhost:3013";
  refreshSecretScrubberCache();
});

afterEach(() => {
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
});
