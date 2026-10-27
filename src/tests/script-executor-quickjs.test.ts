import { afterAll, describe, expect, test } from "bun:test";
import { QuickJSScriptExecutor, quickJSWorkerCount } from "../scripts-runtime/executors/quickjs";
import type { ExecutorInput } from "../scripts-runtime/executors/types";
import { DEFAULT_SCRIPT_RESOURCES } from "../scripts-runtime/executors/types";

// Behavior specific to the quickjs executor. The shared contract lives in
// script-executor-conformance.test.ts. No test here spawns a process.

const requests: Array<{ method: string; path: string; auth: string | null; agent: string | null }> =
  [];
const kv = new Map<string, unknown>();
// Requests to /hang (or kv key "hang") never get a response. The test reads
// how many of them the client aborted.
const hang = { started: 0, aborted: 0 };
const slow = { inFlight: 0, maxInFlight: 0 };
function hangUntilAborted(req: Request): Promise<Response> {
  hang.started++;
  return new Promise((resolve) => {
    req.signal.addEventListener("abort", () => {
      hang.aborted++;
      resolve(new Response("aborted"));
    });
  });
}
async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) return false;
    await Bun.sleep(10);
  }
  return true;
}
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    requests.push({
      method: req.method,
      path: url.pathname,
      auth: req.headers.get("authorization"),
      agent: req.headers.get("x-agent-id"),
    });
    if (url.pathname === "/hang" || url.pathname === "/api/kv/hang") return hangUntilAborted(req);
    if (url.pathname === "/slow") {
      slow.inFlight++;
      slow.maxInFlight = Math.max(slow.maxInFlight, slow.inFlight);
      await Bun.sleep(30);
      slow.inFlight--;
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/api/kv/")) {
      const key = decodeURIComponent(url.pathname.slice("/api/kv/".length));
      if (req.method === "PUT") {
        const body = (await req.json()) as { value: unknown };
        kv.set(key, body.value);
        return Response.json({ key, value: body.value });
      }
      return Response.json({ key, value: kv.get(key) ?? null });
    }
    if (url.pathname === "/echo") {
      return Response.json(
        { method: req.method, body: await req.text(), custom: req.headers.get("x-custom") },
        { headers: { "x-reply": "yes" } },
      );
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});
afterAll(() => server.stop(true));

const baseUrl = `http://127.0.0.1:${server.port}`;
// The documented binary body caps (scripts-runtime guide).
const MAX_BINARY_BODY_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_BINARY_BODY_BYTES = 64 * 1024 * 1024;
const executor = new QuickJSScriptExecutor();

function input(source: string, overrides: Partial<ExecutorInput> = {}): ExecutorInput {
  return {
    source,
    args: null,
    configPayload: {
      system: {
        apiKey: { value: "quickjs-test-secret", isSecret: true },
        agentId: { value: "agent-q", isSecret: false },
        mcpBaseUrl: { value: baseUrl, isSecret: false },
      },
      user: { REGION: { value: "eu", isSecret: false } },
    },
    resources: { ...DEFAULT_SCRIPT_RESOURCES, wallClockMs: 5_000, ...overrides.resources },
    fsMode: "none",
    network: "open",
    ...overrides,
  };
}

describe("quickjs executor", () => {
  for (const [moduleName, fields] of [
    ["zod", "email: z.string().email(), n: z.number().int()"],
    ["zod/mini", "email: z.email(), n: z.int()"],
  ]) {
    test(`runs TypeScript with a tree-shaken ${moduleName} argsSchema`, async () => {
      const source = `import * as z from "${moduleName}";
export const argsSchema = z.object({ ${fields} });
type Args = z.infer<typeof argsSchema>;
export default async function (args: Args) {
  return { domain: args.email.split("@")[1], double: args.n * 2 };
}`;
      const ok = await executor.run({ ...input(source), args: { email: "a@b.co", n: 3 } });
      expect(ok.error).toBeUndefined();
      expect(ok.result).toEqual({ domain: "b.co", double: 6 });

      const bad = await executor.run({ ...input(source), args: { email: "nope", n: 1.5 } });
      expect(bad.error).toBe("eval_error");
      expect(bad.runtimeError?.message).toContain("argsSchema validation failed:");
      expect(bad.runtimeError?.message).toContain("email");
    });
  }

  test("accepts args that arrive as a JSON string", async () => {
    const output = await executor.run({
      ...input("export default async (args) => args.x + 1;"),
      args: JSON.stringify({ x: 41 }),
    });
    expect(output.result).toBe(42);
  });

  test("maps runtime errors back to the original TypeScript line", async () => {
    const source = `type T = { a: number };

function explode(value: T): never {
  throw new Error("boom " + value.a);
}

export default async (args: T) => explode(args);
`;
    const output = await executor.run({ ...input(source), args: { a: 7 } });
    expect(output.error).toBe("eval_error");
    expect(output.runtimeError?.message).toBe("boom 7");
    expect(output.runtimeError?.userScriptLine).toBe(4);
    expect(output.runtimeError?.userFrames[0]?.file).toBe("user-script.ts");
    expect(output.stderr).toContain("user-script.ts:4:");
  });

  test("adds the (args, ctx) hint when ctx members are read off undefined", async () => {
    const output = await executor.run(
      input("export default async (ctx) => { const { log } = ctx.api; return log; };"),
    );
    expect(output.error).toBe("eval_error");
    expect((output.runtimeError as { ctxSignatureHint?: string }).ctxSignatureHint).toContain(
      "args comes first",
    );
  });

  test("reports syntax errors as eval_error with the build diagnostic", async () => {
    const output = await executor.run(input("export default async () => { return (; };"));
    expect(output.error).toBe("eval_error");
    expect(output.runtimeError?.name).toBe("BuildError");
    expect(output.stderr.length).toBeGreaterThan(0);
  });

  test("interrupts a synchronous busy loop and keeps the worker usable", async () => {
    const looped = await executor.run(
      input("export default async () => { while (true) {} };", {
        resources: { ...DEFAULT_SCRIPT_RESOURCES, wallClockMs: 200 },
      }),
    );
    expect(looped.error).toBe("timeout");
    expect(looped.exitCode).toBe(124);

    const after = await executor.run(input("export default async () => 'alive';"));
    expect(after.result).toBe("alive");
  });

  test("times out a promise that never settles", async () => {
    const output = await executor.run(
      input("export default async () => new Promise(() => {});", {
        resources: { ...DEFAULT_SCRIPT_RESOURCES, wallClockMs: 150 },
      }),
    );
    expect(output.error).toBe("timeout");
  });

  test("enforces the heap limit as oom", async () => {
    const output = await executor.run(
      // Growing one array hits the limit in ~100 ms. Many small strings make
      // QuickJS's GC thrash near the limit, which takes seconds to fail.
      input(
        "export default async () => { const a = []; for (let i = 0; i < 1e9; i++) a.push(i); };",
        {
          resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 16, wallClockMs: 10_000 },
        },
      ),
    );
    expect(output.error).toBe("oom");
  });

  test("an abort kills a busy script and the pool recovers", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const output = await executor.run(
      input("export default async () => { while (true) {} };", {
        signal: controller.signal,
        resources: { ...DEFAULT_SCRIPT_RESOURCES, wallClockMs: 10_000 },
      }),
    );
    expect(output.error).toBe("killed");

    const after = await executor.run(input("export default async () => 'recovered';"));
    expect(after.result).toBe("recovered");
  });

  test("exposes no process, filesystem, or module globals", async () => {
    // Read off globalThis: Bun.build constant-folds a bare `typeof require` to "function".
    const output = await executor.run(
      input(`export default async () => ({
  process: typeof globalThis.process,
  bun: typeof globalThis.Bun,
  require: typeof globalThis.require,
})`),
    );
    expect(output.result).toEqual({ process: "undefined", bun: "undefined", require: "undefined" });
  });

  test("glob and grep fail with a clear message", async () => {
    const output = await executor.run(
      input("export default async (_args, ctx) => ctx.stdlib.glob('*.ts');"),
    );
    expect(output.error).toBe("eval_error");
    expect(output.runtimeError?.message).toContain("not available in the quickjs executor");
  });

  test("routes console output to stdout and stderr", async () => {
    const output = await executor.run(
      input(
        "export default async (_args, ctx) => { console.log('hello', { a: 1 }); ctx.logger.error('bad'); return 1; };",
      ),
    );
    expect(output.stdout).toBe('hello {"a":1}\n');
    expect(output.stderr).toBe("bad\n");
  });

  test("setTimeout runs callbacks through the host clock", async () => {
    const output = await executor.run(
      input(`export default async () => {
  const order: string[] = [];
  const cancelled = setTimeout(() => order.push("cancelled"), 5);
  clearTimeout(cancelled);
  await new Promise((resolve) => setTimeout(() => { order.push("fired"); resolve(null); }, 10));
  return order;
};`),
    );
    expect(output.result).toEqual(["fired"]);
  });

  test("ctx.swarm calls go through the host with the swarm identity", async () => {
    requests.length = 0;
    const output = await executor.run(
      input(`export default async (_args, ctx) => {
  await ctx.swarm.kv_set({ key: "greeting", value: "hi" });
  const got = await ctx.swarm.kv_get({ key: "greeting" });
  return got.data.value;
};`),
    );
    expect(output.error).toBeUndefined();
    expect(output.result).toBe("hi");
    expect(requests.map((r) => r.method)).toEqual(["PUT", "GET"]);
    expect(requests.every((r) => r.auth === "Bearer quickjs-test-secret")).toBe(true);
    expect(requests.every((r) => r.agent === "agent-q")).toBe(true);
  });

  test("fetch returns a Response-like object with headers and a text body", async () => {
    const output = await executor.run(
      input(`export default async () => {
  const response = await fetch("${baseUrl}/echo", {
    method: "POST",
    headers: { "X-Custom": "c1" },
    body: JSON.stringify({ n: 1 }),
  });
  return { status: response.status, ok: response.ok, reply: response.headers.get("x-reply"), body: await response.json() };
};`),
    );
    expect(output.result).toEqual({
      status: 200,
      ok: true,
      reply: "yes",
      body: { method: "POST", body: '{"n":1}', custom: "c1" },
    });
  });

  test("fetch rejects non-string bodies", async () => {
    const output = await executor.run(
      input(
        `export default async () => fetch("${baseUrl}/echo", { method: "POST", body: { n: 1 } });`,
      ),
    );
    expect(output.error).toBe("eval_error");
    expect(output.runtimeError?.message).toContain("fetch body must be a string");
  });

  // Parity with native lives in script-executor-conformance.test.ts. These
  // are the documented limits of the shims.
  test("shims refuse what they do not implement, with a clear error", async () => {
    const output = await executor.run(
      input(`export default async () => {
  const attempt = (run) => { try { run(); return "ok"; } catch (e) { return e.name + ": " + e.message; } };
  return {
    latin1: attempt(() => new TextDecoder("latin1")),
    floatRandom: attempt(() => crypto.getRandomValues(new Float64Array(2))),
    subtle: typeof crypto.subtle,
  };
};`),
    );
    expect(output.result).toEqual({
      latin1: 'RangeError: quickjs executor: TextDecoder supports utf-8 only, not "latin1"',
      floatRandom: "TypeError: crypto.getRandomValues: the argument must be an integer TypedArray",
      subtle: "undefined",
    });
  });

  test("binary bodies reach the host through ctx.stdlib.fetch too", async () => {
    const output = await executor.run(
      input(
        `export default async (_args, ctx) => (await ctx.stdlib.fetch("${baseUrl}/echo", { method: "POST", body: new TextEncoder().encode("é!") })).json();`,
      ),
    );
    expect(output.result).toMatchObject({ method: "POST", body: "é!" });
  });

  test("user config values stay redacted until unwrapped", async () => {
    const output = await executor.run(
      input(`export default async (_args, ctx) => {
  const region = ctx.swarm.config.get("REGION");
  return {
    wrapped: region,
    text: String(region),
    value: ctx.stdlib.Redacted.value(region),
    meta: ctx.stdlib.Redacted.meta(region),
    missing: ctx.swarm.config.get("NOPE") === undefined,
  };
};`),
    );
    expect(output.result).toEqual({
      wrapped: "<redacted>",
      text: "<redacted>",
      value: "eu",
      meta: { type: "user", isSecret: false },
      missing: true,
    });
  });

  test("a non-serializable result is an eval_error", async () => {
    const output = await executor.run(
      input("export default async () => { const a: any = {}; a.self = a; return a; };"),
    );
    expect(output.error).toBe("eval_error");
    expect(output.runtimeError?.message).toContain("not JSON-serializable");
  });

  test("recycles a worker whose WASM memory grew past the threshold", async () => {
    await executor.run(input("export default async () => 1;"));
    const before = quickJSWorkerCount();
    const big = await executor.run(
      input(
        "export default async () => { const a = []; for (let i = 0; i < 3e6; i++) a.push({ i }); return a.length; };",
      ),
    );
    expect(big.result).toBe(3e6);
    expect(quickJSWorkerCount()).toBe(before - 1);

    const after = await executor.run(input("export default async () => 'fresh';"));
    expect(after.result).toBe("fresh");
  });

  test("host calls only reach own api/mcp/room members", async () => {
    const output = await executor.run(
      input(`export default async () => {
  const call = (path: string) => (globalThis as any).__host_call(path, "[]");
  return [
    JSON.parse(await call("swarm.room.constructor")).error?.message,
    JSON.parse(await call("swarm.constructor")).error?.message,
    JSON.parse(await call("api.__proto__.x")).error?.message,
  ];
};`),
    );
    expect(output.result).toEqual([
      "ctx.swarm.room.constructor is not a function",
      "ctx.swarm.constructor is not a function",
      "ctx.api.__proto__.x is not a function",
    ]);
  });

  test("aborts a host fetch the script did not await when the run returns", async () => {
    await executor.run(input("export default async () => 0;"));
    const workers = quickJSWorkerCount();
    const before = { ...hang };
    const output = await executor.run(
      // The 100 ms wait lets the request reach the server before the run ends.
      input(`export default async () => {
  void fetch("${baseUrl}/hang");
  await new Promise((resolve) => setTimeout(resolve, 100));
  return 1;
};`),
    );
    expect(output.result).toBe(1);
    expect(hang.started).toBe(before.started + 1);
    expect(await waitFor(() => hang.aborted > before.aborted)).toBe(true);
    // The run aborted and settled the fetch itself, so the pool kept the worker.
    // Terminating the worker is only the fallback for calls that do not settle.
    expect(quickJSWorkerCount()).toBe(workers);
  });

  test("aborts a pending host fetch when the run times out", async () => {
    const before = hang.aborted;
    const output = await executor.run(
      input(`export default async () => (await fetch("${baseUrl}/hang")).text();`, {
        resources: { ...DEFAULT_SCRIPT_RESOURCES, wallClockMs: 200 },
      }),
    );
    expect(output.error).toBe("timeout");
    expect(await waitFor(() => hang.aborted > before)).toBe(true);

    const after = await executor.run(input("export default async () => 'next';"));
    expect(after.result).toBe("next");
  });

  test("aborts ctx.swarm host calls too", async () => {
    await executor.run(input("export default async () => 0;"));
    const workers = quickJSWorkerCount();
    const before = { ...hang };
    const output = await executor.run(
      input(
        `export default async (_args, ctx) => {
  void ctx.swarm.kv_get({ key: "hang" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  return 1;
};`,
      ),
    );
    expect(output.result).toBe(1);
    expect(hang.started).toBe(before.started + 1);
    expect(await waitFor(() => hang.aborted > before.aborted)).toBe(true);
    expect(quickJSWorkerCount()).toBe(workers);
  });

  test("caps concurrent host calls per run and queues the rest", async () => {
    slow.maxInFlight = 0;
    const output = await executor.run(
      input(`export default async () => {
  const replies = await Promise.all(
    Array.from({ length: 40 }, () => fetch("${baseUrl}/slow").then((r) => r.json())),
  );
  return replies.filter((r: any) => r.ok).length;
};`),
    );
    expect(output.result).toBe(40);
    expect(slow.maxInFlight).toBeGreaterThan(1);
    expect(slow.maxInFlight).toBeLessThanOrEqual(16);
  });

  test("rejects host calls beyond the per-run pending limit", async () => {
    const output = await executor.run(
      input(`export default async () => {
  const calls = Array.from({ length: 1100 }, () => fetch("${baseUrl}/slow").then(() => "ok", (e) => e.message));
  const results = await Promise.all(calls);
  return results.filter((r) => r !== "ok").length > 0 ? results.find((r) => r !== "ok") : "none";
};`),
    );
    expect(output.result).toContain("Too many pending host calls");
  });

  // The sandbox controls bodyBase64, so these call the bridge directly, past
  // the prelude's own encoding, and check that no request reaches the server.
  const bridgeSend = `const send = async (bodyBase64: unknown) =>
    JSON.parse(await (globalThis as any).__host_call("fetch", JSON.stringify([{ url: "${baseUrl}/sink", method: "POST", bodyBase64 }]))).error?.message ?? "sent";`;

  test("rejects a malformed binary body before any fetch starts", async () => {
    const before = requests.length;
    const output = await executor.run(
      input(`export default async () => {
  ${bridgeSend}
  return [await send(123), await send({ length: 4 }), await send("!!!!"), await send("AAA"), await send("AA=A")];
};`),
    );
    expect(output.result).toEqual([
      "fetch bodyBase64 must be a string",
      "fetch bodyBase64 must be a string",
      "fetch bodyBase64 is not valid base64",
      "fetch bodyBase64 is not valid base64",
      "fetch bodyBase64 is not valid base64",
    ]);
    expect(requests.length).toBe(before);
  });

  test("rejects an oversized binary body before any fetch starts", async () => {
    const before = requests.length;
    const encodedLimit = Math.ceil(MAX_BINARY_BODY_BYTES / 3) * 4;
    const output = await executor.run(
      input(`export default async () => {
  ${bridgeSend}
  return {
    encoded: await send("A".repeat(${encodedLimit + 4})),
    decoded: await send("A".repeat(${encodedLimit})),
    atLimit: await send("A".repeat(${encodedLimit - 4}) + "AA=="),
  };
};`),
    );
    const tooLarge = `fetch binary body exceeds the ${MAX_BINARY_BODY_BYTES}-byte limit of the quickjs executor`;
    expect(output.result).toEqual({ encoded: tooLarge, decoded: tooLarge, atLimit: "sent" });
    // Only the body at the limit reached the server.
    expect(requests.length).toBe(before + 1);
  });

  test("caps the binary bodies one run can have pending", async () => {
    const before = { ...hang };
    const encodedLimit = Math.ceil(MAX_BINARY_BODY_BYTES / 3) * 4;
    const output = await executor.run(
      input(
        `export default async () => {
  // Decodes to exactly MAX_BINARY_BODY_BYTES; four fill the per-run budget.
  const args = JSON.stringify([{ url: "${baseUrl}/hang", method: "POST", bodyBase64: "A".repeat(${encodedLimit - 4}) + "AA==" }]);
  const call = async () => JSON.parse(await (globalThis as any).__host_call("fetch", args)).error?.message ?? "sent";
  const held = [call(), call(), call(), call()];
  return call();
};`,
        { resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 1024, wallClockMs: 10_000 } },
      ),
    );
    expect(output.result).toBe(
      `Pending fetch binary bodies in one script run exceed ${MAX_PENDING_BINARY_BODY_BYTES} bytes`,
    );
    expect(await waitFor(() => hang.started === before.started + 4)).toBe(true);
    expect(await waitFor(() => hang.aborted === before.aborted + 4)).toBe(true);
  }, 30_000);

  test("queues runs beyond the pool size", async () => {
    const outputs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        executor.run({ ...input("export default async (args) => args.i * 2;"), args: { i } }),
      ),
    );
    expect(outputs.map((o) => o.result)).toEqual(Array.from({ length: 12 }, (_, i) => i * 2));
  });
});

describe("quickjs egress policy", () => {
  const deny = { allowPrivate: false, allowlist: null };
  const probe = `export default async (_args, ctx) => {
  const attempt = async (run) => { try { return "ok:" + (await run()); } catch (e) { return "err:" + e.message; } };
  return {
    fetch: await attempt(async () => (await fetch("${baseUrl}/echo")).status),
    stdlibFetch: await attempt(async () => (await ctx.stdlib.fetch("${baseUrl}/echo")).status),
    fetchJson: await attempt(async () => (await ctx.stdlib.fetchJson("${baseUrl}/echo")).method),
  };
};`;

  test("denies loopback fetches from script code by default", async () => {
    requests.length = 0;
    const output = await executor.run(input(probe, { network: deny }));
    expect(output.error).toBeUndefined();
    const result = output.result as Record<string, string>;
    for (const value of Object.values(result)) {
      expect(value).toStartWith("err:Script egress refused");
      expect(value).toContain("SCRIPT_EGRESS_ALLOWLIST");
    }
    expect(requests.filter((r) => r.path === "/echo")).toHaveLength(0);
  });

  test("control: the same probe reaches loopback with network open", async () => {
    const output = await executor.run(input(probe));
    expect(output.result).toEqual({ fetch: "ok:200", stdlibFetch: "ok:200", fetchJson: "ok:GET" });
  });

  test("an allowlist entry or SCRIPT_EGRESS_ALLOW_PRIVATE opens the private host", async () => {
    const port = new URL(baseUrl).port;
    const listed = await executor.run(
      input(probe, { network: { allowPrivate: false, allowlist: [`127.0.0.1:${port}`] } }),
    );
    expect((listed.result as Record<string, string>).fetch).toBe("ok:200");

    const otherPort = await executor.run(
      input(probe, { network: { allowPrivate: false, allowlist: ["127.0.0.1:1"] } }),
    );
    expect((otherPort.result as Record<string, string>).fetch).toContain(
      "not in SCRIPT_EGRESS_ALLOWLIST",
    );

    const allowPrivate = await executor.run(
      input(probe, { network: { allowPrivate: true, allowlist: null } }),
    );
    expect((allowPrivate.result as Record<string, string>).fetch).toBe("ok:200");
  });

  test("ctx.swarm still reaches the swarm API under the deny policy", async () => {
    requests.length = 0;
    const output = await executor.run(
      input(
        `export default async (_args, ctx) => {
  await ctx.swarm.kv_set({ key: "egress", value: "fine" });
  return (await ctx.swarm.kv_get({ key: "egress" })).data.value;
};`,
        { network: deny },
      ),
    );
    expect(output.error).toBeUndefined();
    expect(output.result).toBe("fine");
    expect(requests.every((r) => r.auth === "Bearer quickjs-test-secret")).toBe(true);
  });

  test("script code cannot read the host bearer or runtime id", async () => {
    const output = await executor.run(
      input(
        `export default async (_args, ctx) => {
  const read = (value) => { try { return ctx.stdlib.Redacted.value(value); } catch (e) { return "err:" + e.message; } };
  return {
    apiKey: read(ctx.swarm.config.apiKey),
    runtimeInstanceId: read(ctx.swarm.config.runtimeInstanceId),
    apiKeyMeta: ctx.stdlib.Redacted.meta(ctx.swarm.config.apiKey),
    agentId: read(ctx.swarm.config.agentId),
    mcpBaseUrl: read(ctx.swarm.config.mcpBaseUrl),
  };
};`,
        {
          configPayload: {
            ...input("").configPayload,
            system: {
              ...input("").configPayload.system,
              runtimeInstanceId: { value: "runtime-1", isSecret: false },
            },
          },
        },
      ),
    );
    expect(output.error).toBeUndefined();
    const result = output.result as Record<string, unknown>;
    expect(result.apiKey).toStartWith("err:host-only credential");
    expect(result.runtimeInstanceId).toStartWith("err:host-only credential");
    expect(result.apiKeyMeta).toEqual({ type: "system", isSecret: true });
    expect(result.agentId).toBe("agent-q");
    expect(result.mcpBaseUrl).toBe(baseUrl);
    expect(JSON.stringify(output)).not.toContain("quickjs-test-secret");
  });
});

describe("quickjs hostValidatedArgs (#2011)", () => {
  const countedStructuralScript = `
import { z } from "zod";
export const argsSchema = z.object({
  value: z.number(),
  label: z.string().optional(),
});
let parseCalls = 0;
const origParse = argsSchema.parse.bind(argsSchema);
argsSchema.parse = ((v: unknown) => {
  parseCalls++;
  return origParse(v);
}) as typeof argsSchema.parse;

export default async function (args: z.infer<typeof argsSchema>) {
  return { doubled: args.value * 2, label: args.label ?? null, parseCalls };
}
`;

  test("skips duplicate argsSchema.parse when hostValidatedArgs is true and schema is structural", async () => {
    const out = await executor.run(
      input(countedStructuralScript, {
        args: { value: 21, label: "ok" },
        hostValidatedArgs: true,
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ doubled: 42, label: "ok", parseCalls: 0 });
  });

  test("still runs argsSchema.parse when hostValidatedArgs is omitted or false", async () => {
    const out = await executor.run(input(countedStructuralScript, { args: { value: 21 } }));
    expect(out.exitCode).toBe(0);
    expect(out.result).toEqual({ doubled: 42, label: null, parseCalls: 1 });
  });

  test("still runs argsSchema.parse when args contain extra keys that Zod strips", async () => {
    const out = await executor.run(
      input(countedStructuralScript, {
        args: { value: 21, extra: "stripped-by-zod" },
        hostValidatedArgs: true,
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.result).toEqual({ doubled: 42, label: null, parseCalls: 1 });
  });

  test("still runs argsSchema.parse when schema uses defaults, transforms, or refinements", async () => {
    const scriptWithDefaultsAndTransforms = `
import { z } from "zod";
export const argsSchema = z.object({
  value: z.number().default(10),
  tag: z.string().transform((s) => s.toUpperCase()),
});
let parseCalls = 0;
const origParse = argsSchema.parse.bind(argsSchema);
argsSchema.parse = ((v: unknown) => {
  parseCalls++;
  return origParse(v);
}) as typeof argsSchema.parse;

export default async function (args: z.infer<typeof argsSchema>) {
  return { value: args.value, tag: args.tag, parseCalls };
}
`;
    const out = await executor.run(
      input(scriptWithDefaultsAndTransforms, {
        args: { tag: "hello" },
        hostValidatedArgs: true,
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.result).toEqual({ value: 10, tag: "HELLO", parseCalls: 1 });
  });

  test("caller-supplied args payload cannot spoof the trusted host validation marker", async () => {
    const out = await executor.run(
      input(countedStructuralScript, {
        args: {
          value: 7,
          hostValidatedArgs: true,
          __swarm_host_validated_args: true,
        },
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.result).toEqual({ doubled: 14, label: null, parseCalls: 1 });
  });

  test("retains Zod property semantics on inherited Object.prototype keys (constructor, toString) and reverse numeric enum keys", async () => {
    for (const propName of ["constructor", "toString"] as const) {
      const protoScript = `
import { z } from "zod";
export const argsSchema = z.object({
  ${propName}: z.string().nullable().optional(),
});
export default async function (args: z.infer<typeof argsSchema>) {
  return { val: args.${propName} ?? null };
}
`;
      const out = await executor.run(
        input(protoScript, {
          args: {},
          hostValidatedArgs: true,
        }),
      );
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain("argsSchema validation failed");
    }

    const numericEnumScript = `
import { z } from "zod";
export const argsSchema = z.object({
  mode: z.enum({ 0: "Read", Read: 0 }).nullable(),
});
export default async function (args: z.infer<typeof argsSchema>) {
  return { mode: args.mode };
}
`;
    const rejected = await executor.run(
      input(numericEnumScript, {
        args: { mode: "Read" },
        hostValidatedArgs: true,
      }),
    );
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("argsSchema validation failed");

    const accepted = await executor.run(
      input(numericEnumScript, {
        args: { mode: 0 },
        hostValidatedArgs: true,
      }),
    );
    expect(accepted.exitCode).toBe(0);
    expect(accepted.result).toEqual({ mode: 0 });
  });
});
