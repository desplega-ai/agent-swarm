import { afterAll, describe, expect, test } from "bun:test";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { buildGuestWorkflowCtx } from "../script-workflows/guest-ctx";
import { buildCtx } from "../scripts-runtime/ctx";
import { QuickJSScriptExecutor } from "../scripts-runtime/executors/quickjs";
import { runQuickJSJob } from "../scripts-runtime/executors/quickjs-runner";
import { DEFAULT_SCRIPT_RESOURCES } from "../scripts-runtime/executors/types";
import { assertNamespaces, SDK_NAMESPACES } from "../scripts-runtime/sdk-allowlist";
import { SwarmConfig } from "../scripts-runtime/swarm-config";

// kv_list takes a REST route, app_list the MCP bridge: both unwrap paths.
const FIXTURE = { kv: ["list"], app: ["list"] } as const;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/kv")) {
      if (url.searchParams.get("prefix") === "boom") {
        return Response.json({ error: "kaboom" }, { status: 500 });
      }
      return Response.json({ entries: [{ key: "a" }], total: 1 });
    }
    if (url.pathname === "/api/mcp-bridge") {
      const { args } = (await req.json()) as { args: { fail?: boolean } };
      return Response.json(
        args.fail
          ? { success: false, message: "app refused" }
          : { success: true, message: "1 app", apps: [{ id: "x" }] },
      );
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});
afterAll(() => server.stop(true));

const configPayload = {
  system: {
    apiKey: { value: "ns-test-secret", isSecret: true },
    agentId: { value: "agent-ns", isSecret: false },
    mcpBaseUrl: { value: `http://127.0.0.1:${server.port}`, isSecret: false },
  },
  user: {},
};

describe("assertNamespaces", () => {
  test("accepts the production registry and the fixture", () => {
    expect(() => assertNamespaces(SDK_NAMESPACES)).not.toThrow();
    expect(() => assertNamespaces(FIXTURE)).not.toThrow();
  });

  test("rejects reserved, malformed and unmapped namespaces", () => {
    expect(() => assertNamespaces({ swarm: ["list"] })).toThrow("reserved");
    expect(() => assertNamespaces({ step: ["list"] })).toThrow("reserved");
    expect(() => assertNamespaces({ "kv-x": ["list"] })).toThrow("invalid name");
    expect(() => assertNamespaces({ kv: ["__proto__"] })).toThrow("invalid name");
    expect(() => assertNamespaces({ kv: ["explode"] })).toThrow("kv_explode");
  });
});

describe("native ctx namespaces", () => {
  const ctx = buildCtx({ swarmConfig: new SwarmConfig(configPayload), namespaces: FIXTURE });
  const kv = ctx.kv as Record<string, (args?: unknown) => Promise<unknown>>;
  const app = ctx.app as Record<string, (args?: unknown) => Promise<unknown>>;

  test("unwraps REST and bridge payloads", async () => {
    expect(await kv.list?.({ prefix: "a" })).toEqual({ entries: [{ key: "a" }], total: 1 });
    expect(await app.list?.({})).toEqual({ message: "1 app", apps: [{ id: "x" }] });
  });

  test("throws on a non-2xx and on a tool refusal", async () => {
    await expect(kv.list?.({ prefix: "boom" })).rejects.toThrow(
      "ctx.kv.list failed with 500: kaboom",
    );
    await expect(app.list?.({ fail: true })).rejects.toThrow("ctx.app.list failed: app refused");
  });

  test("namespace clients are frozen", () => {
    expect(Object.isFrozen(kv)).toBe(true);
  });

  test("the production registry adds no ctx keys today", () => {
    const plain = buildCtx({ swarmConfig: new SwarmConfig(configPayload) });
    expect(Object.keys(plain).sort()).toEqual(
      [
        ...Object.keys(SDK_NAMESPACES),
        "api",
        "fs",
        "logger",
        "mcp",
        "sh",
        "stdlib",
        "swarm",
      ].sort(),
    );
  });
});

describe("quickjs ctx namespaces", () => {
  const modulePromise = newQuickJSWASMModuleFromVariant(variant);
  const run = async (source: string) => {
    const { output } = await runQuickJSJob(await modulePromise, {
      source,
      args: null,
      configPayload,
      resources: { ...DEFAULT_SCRIPT_RESOURCES, wallClockMs: 5_000 },
      network: "open",
      namespaces: FIXTURE,
    });
    return output;
  };

  test("exposes frozen namespaces that unwrap and throw like native", async () => {
    const output = await run(`export default async (_args, ctx) => {
  let refusal = "";
  try { await ctx.app.list({ fail: true }); } catch (e) { refusal = (e as Error).message; }
  return {
    keys: Object.keys(ctx).sort(),
    frozen: Object.isFrozen(ctx.kv),
    list: await ctx.kv.list({ prefix: "a" }),
    apps: await ctx.app.list({}),
    refusal,
  };
};`);
    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({
      keys: ["api", "app", "fs", "kv", "logger", "mcp", "sh", "stdlib", "swarm"],
      frozen: true,
      list: { entries: [{ key: "a" }], total: 1 },
      apps: { message: "1 app", apps: [{ id: "x" }] },
      refusal: "ctx.app.list failed: app refused",
    });
  });

  test("host calls only reach own namespace methods", async () => {
    const output = await run(`export default async () => {
  const call = (path: string) => (globalThis as any).__host_call(path, "[]");
  return [
    JSON.parse(await call("kv.constructor")).error?.message,
    JSON.parse(await call("kv.__proto__")).error?.message,
    JSON.parse(await call("kv.get")).error?.message,
  ];
};`);
    expect(output.result).toEqual([
      "ctx.kv.constructor is not a function",
      "ctx.kv.__proto__ is not a function",
      "ctx.kv.get is not a function",
    ]);
  });

  test("the production registry adds no ctx keys today", async () => {
    const executor = new QuickJSScriptExecutor();
    const output = await executor.run({
      source: "export default async (_args, ctx) => Object.keys(ctx).sort();",
      args: null,
      configPayload,
      resources: { ...DEFAULT_SCRIPT_RESOURCES, wallClockMs: 5_000 },
      fsMode: "none",
      network: "open",
    });
    expect(output.result).toEqual(
      [
        ...Object.keys(SDK_NAMESPACES),
        "api",
        "fs",
        "logger",
        "mcp",
        "sh",
        "stdlib",
        "swarm",
      ].sort(),
    );
  });
});

describe("workflow guest ctx namespaces", () => {
  test("calls the flat capability and unwraps it", async () => {
    const calls: string[] = [];
    const ctx = buildGuestWorkflowCtx({
      runId: "run-1",
      agentId: "agent-ns",
      args: null,
      namespaces: FIXTURE,
      invokeTool: async (path, argsJson) => {
        calls.push(`${path} ${argsJson}`);
        const fail = (JSON.parse(argsJson) as { fail?: boolean }).fail;
        return JSON.stringify(
          fail ? { success: false, message: "no" } : { success: true, entries: [] },
        );
      },
    });
    const kv = ctx.kv as Record<string, (args?: unknown) => Promise<unknown>>;
    expect(await kv.list?.({ prefix: "p" })).toEqual({ entries: [] });
    await expect(kv.list?.({ fail: true })).rejects.toThrow("ctx.kv.list failed: no");
    expect(calls[0]).toBe('swarm.kv_list {"prefix":"p"}');
    expect(Object.isFrozen(kv)).toBe(true);
  });
});

describe("script types", () => {
  test("every registered namespace has a ScriptContext key", async () => {
    const dts = await Bun.file(
      new URL("../scripts-runtime/types/swarm-sdk.d.ts", import.meta.url),
    ).text();
    const block = dts.slice(dts.indexOf("export interface ScriptContext {"));
    const body = block.slice(0, block.indexOf("\n  }\n"));
    for (const ns of Object.keys(SDK_NAMESPACES))
      expect(body).toMatch(new RegExp(`\\n\\s+${ns}: `));
  });
});
