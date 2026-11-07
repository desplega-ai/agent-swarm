import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyExit, NativeScriptExecutor } from "../scripts-runtime/executors/native";
import { QuickJSScriptExecutor } from "../scripts-runtime/executors/quickjs";
import type {
  ExecutorInput,
  ExecutorOutput,
  ScriptExecutor,
} from "../scripts-runtime/executors/types";
import { DEFAULT_SCRIPT_RESOURCES } from "../scripts-runtime/executors/types";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

const payload = {
  system: {
    apiKey: { value: "conformance-secret", isSecret: true as const },
    agentId: { value: "agent-1", isSecret: false as const },
    mcpBaseUrl: { value: "http://localhost:3013", isSecret: false as const },
  },
  user: {},
};

function input(overrides: Partial<ExecutorInput> = {}): ExecutorInput {
  return {
    source: "export default async (args) => args.x + 1;",
    args: { x: 1 },
    configPayload: payload,
    resources: {
      ...DEFAULT_SCRIPT_RESOURCES,
      memoryMb: 2048,
      wallClockMs: 1_000,
      ...overrides.resources,
    },
    fsMode: "none",
    network: "open",
    ...overrides,
  };
}

class FakeScriptExecutor implements ScriptExecutor {
  readonly name = "fake";

  async run(runInput: ExecutorInput): Promise<ExecutorOutput> {
    if (runInput.fsMode === "workspace-rw") {
      return {
        result: undefined,
        stdout: "",
        stderr: "workspace-rw not supported",
        truncated: { stdout: false, stderr: false },
        durationMs: 0,
        exitCode: 1,
        error: "executor_error",
      };
    }

    if (runInput.signal?.aborted) {
      return {
        result: undefined,
        stdout: "",
        stderr: "",
        truncated: { stdout: false, stderr: false },
        durationMs: 0,
        exitCode: 1,
        error: "killed",
      };
    }

    const stdout = "x".repeat(runInput.resources.maxStdoutBytes + 10);
    return {
      result: runInput.configPayload.system.agentId.value,
      stdout: stdout.slice(0, runInput.resources.maxStdoutBytes),
      stderr: "",
      truncated: { stdout: true, stderr: false },
      durationMs: 1,
      exitCode: 0,
    };
  }
}

// `spawns` marks whether this executor variant shells out via Bun.spawn.
// FakeScriptExecutor is plain JS and never touches the sandbox, so it must
// keep running even when the spawn probe has disabled the native suite.
function conformance(name: string, makeExecutor: () => ScriptExecutor, spawns: boolean) {
  const spawnTest = test.skipIf(spawns && SKIP_SANDBOX_SPAWN_TESTS);

  describe(`${name} ScriptExecutor conformance`, () => {
    spawnTest("happy path run", async () => {
      const output = await makeExecutor().run(
        input({
          source: "export default async (args) => args.x + 1;",
          args: { x: 2 },
        }),
      );
      expect(output.exitCode).toBe(0);
      expect(output.error).toBeUndefined();
    });

    spawnTest("stdout cap is honored", async () => {
      const output = await makeExecutor().run(
        input({
          resources: {
            ...DEFAULT_SCRIPT_RESOURCES,
            memoryMb: 2048,
            maxStdoutBytes: 64,
            wallClockMs: 1_000,
          },
          source: "export default async () => { console.log('x'.repeat(512)); return true; };",
        }),
      );
      expect(output.stdout.length).toBeLessThanOrEqual(64);
      expect(output.truncated.stdout).toBe(true);
    });

    // Short-circuits before Bun.spawn for every executor — never spawn-dependent.
    test("workspace-rw returns executor_error", async () => {
      const output = await makeExecutor().run(input({ fsMode: "workspace-rw" }));
      expect(output.error).toBe("executor_error");
    });

    spawnTest("config payload is delivered", async () => {
      const output = await makeExecutor().run(
        input({
          source:
            "export default async (_args, ctx) => ctx.stdlib.Redacted.value(ctx.swarm.config.agentId);",
        }),
      );
      expect(output.result).toBe("agent-1");
    });
  });
}

conformance("native", () => new NativeScriptExecutor(), true);
conformance("fake", () => new FakeScriptExecutor(), false);
// Worker threads and WASM, no Bun.spawn: runs even when the spawn probe fails.
conformance("quickjs", () => new QuickJSScriptExecutor(), false);

// Each probe is plain JavaScript, so the test process (Bun) can evaluate it too:
// both executors must return exactly what Bun's own web globals return.
const echoServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const bytes = new Uint8Array(await req.arrayBuffer());
    return Response.json({
      contentType: req.headers.get("content-type"),
      bytes: Array.from(bytes),
    });
  },
});
afterAll(() => echoServer.stop(true));

const PARITY_PROBES: Record<string, string> = {
  "structuredClone graphs and built-ins": `async () => {
  class Model { constructor() { this.value = 7; } }
  const shared = { value: 1 };
  const original = { shared, again: shared, model: new Model(), array: [, undefined, -0, NaN, Infinity, 12n] };
  original.self = original;
  const copy = structuredClone(original);
  copy.shared.value = 2;
  const date = structuredClone(new Date(123));
  const regexp = /hello/gi;
  regexp.lastIndex = 4;
  const clonedRegexp = structuredClone(regexp);
  const map = new Map([[shared, shared]]);
  map.set(map, new Set([shared, map]));
  const clonedMap = structuredClone(map);
  const key = [...clonedMap.keys()][0];
  const boxed = [new Boolean(false), new Number(NaN), new String('text'), Object(12n)].map(value => {
    const cloned = structuredClone(value);
    return [typeof cloned, typeof cloned.valueOf(), String(cloned.valueOf()), cloned !== value];
  });
  return {
    cycle: copy.self === copy, shared: copy.shared === copy.again, independent: shared.value === 1,
    model: [Object.getPrototypeOf(copy.model) === Object.prototype, copy.model.value],
    array: [copy.array.length, 0 in copy.array, 1 in copy.array, Object.is(copy.array[2], -0), Number.isNaN(copy.array[3]), copy.array[4] === Infinity, String(copy.array[5])],
    date: [date instanceof Date, date.getTime()],
    regexp: [clonedRegexp instanceof RegExp, clonedRegexp.source, clonedRegexp.flags, clonedRegexp.lastIndex],
    map: [clonedMap instanceof Map, key !== shared, clonedMap.get(key) === key, clonedMap.get(clonedMap) instanceof Set, clonedMap.get(clonedMap).has(key), clonedMap.get(clonedMap).has(clonedMap)],
    boxed,
  };
}`,
  "structuredClone error subtypes": `async () => {
  const types = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError];
  const errors = types.map(Type => {
    const error = new Type('bad');
    error.extra = 'ignored';
    const cloned = structuredClone(error);
    return [cloned instanceof Type, cloned.name, cloned.message, Object.hasOwn(cloned, 'extra')];
  });
  return errors;
}`,
  "structuredClone ignores overridden binary accessors": `async () => {
  const buffer = new ArrayBuffer(16);
  new Uint8Array(buffer).set([1, 2, 3, 4]);
  buffer.slice = () => buffer;
  Object.defineProperty(buffer, 'byteLength', { get() { throw Error('byteLength'); } });
  const view = new Uint16Array(buffer, 2, 3);
  view.constructor = Array;
  for (const name of ['buffer', 'byteOffset', 'byteLength', 'length']) {
    Object.defineProperty(view, name, { get() { throw Error(name); } });
  }
  Object.defineProperty(view, Symbol.toStringTag, { get() { throw Error('tag'); } });
  const data = new DataView(buffer, 1, 4);
  const copy = structuredClone({ buffer, view, data });
  new Uint8Array(copy.buffer)[0] = 9;
  const typed = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array].map(Type => {
    const value = new Type(2);
    const cloned = structuredClone(value);
    return [cloned instanceof Type, cloned.length, cloned.buffer !== value.buffer];
  });
  return {
    independent: copy.buffer !== buffer && new Uint8Array(buffer)[0] === 1,
    bytes: Array.from(new Uint8Array(copy.buffer)),
    view: [copy.view instanceof Uint16Array, copy.view.buffer === copy.buffer, copy.view.byteOffset, copy.view.length],
    data: [copy.data instanceof DataView, copy.data.buffer === copy.buffer, copy.data.byteOffset, copy.data.byteLength],
    typed,
  };
}`,
  "structuredClone property snapshots and symbols": `async () => {
  const original = {
    get a() { delete this.b; this.c = 3; return 1; }, b: 2,
    get [Symbol.toStringTag]() { throw Error('symbol getter ran'); },
  };
  Object.defineProperty(original, '__proto__', { value: { marker: true }, enumerable: true });
  Object.defineProperty(original, 'hidden', { get() { throw Error('hidden getter ran'); } });
  const copy = structuredClone(original);
  return {
    keys: Object.keys(copy), a: copy.a, hasB: Object.hasOwn(copy, 'b'), hasC: Object.hasOwn(copy, 'c'),
    proto: [Object.getPrototypeOf(copy) === Object.prototype, Object.hasOwn(copy, '__proto__'), copy.__proto__.marker],
    symbols: Object.getOwnPropertySymbols(copy).length,
  };
}`,
  "structuredClone rejects uncloneable values": `async () => {
  const failures = [Symbol('x'), Object(Symbol('x')), () => {}, new WeakMap(), new WeakSet(), Promise.resolve(1), { nested: () => {} }];
  return failures.map(value => {
    try { structuredClone(value); return 'accepted'; } catch(error) { return error.name; }
  });
}`,
  "structuredClone argument and getter behavior": `async () => {
  const thrown = new RangeError('getter');
  const getter = { get value() { throw thrown; } };
  const copy = structuredClone({ value: 1 }, { transfer: [] });
  let missing;
  try { structuredClone(); } catch (error) { missing = error.name; }
  let sameError;
  try { structuredClone(getter); } catch (error) { sameError = error === thrown; }
  return { copy, missing, sameError };
}`,
  URL: `async () => {
  const cases = [
    ["https://user:pa ss@Example.COM:443/a/./b/../c d?q=1 2&x='y'#frag ment"],
    ["http://example.com:8080"], ["../x?y#z", "https://a.b/c/d/e"], ["//other.host/p", "https://a.b/c"],
    ["?new", "https://a.b/c/d?q#h"], ["#h2", "https://a.b/c/d?q#h"], ["mailto:someone@example.com"],
    ["foo://EXAMPLE.com/a/../b"], ["http://0x7f.1/"], ["http://[0:0:0:0:0:0:0:1]:80/"],
    ["https://münchen.de/straße"], ["http://a.b/c\\\\d"], ["file:///etc/hosts"], ["http:foo", "http://a.b/c/d"],
    ["not a url"], ["https://a.b:99999/"], ["http://exa mple.com"], ["http://256.1.1.1/"],
  ];
  const keys = ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"];
  const parsed = cases.map(([url, base]) => {
    try {
      const u = new URL(url, base);
      return Object.fromEntries(keys.map((key) => [key, u[key]]).concat([["params", [...u.searchParams]]]));
    } catch (error) {
      return { error: error.name };
    }
  });
  const u = new URL("https://a.b/p?x=1#h");
  u.searchParams.append("y", "two words");
  const linked = u.href;
  u.search = "?z=3";
  u.pathname = "/new path";
  u.port = "8443";
  u.hostname = "C.D";
  u.hash = "";
  return { parsed, linked, mutated: u.href, json: JSON.stringify({ u }), canParse: [URL.canParse("x"), URL.canParse("x", "https://a/")] };
}`,
  "URL relative state": `async () => {
  const base = "http://a/b?q#f";
  const cases = [
    "http:/x", "http:/", "http:", "http:?y", "http:#g", "http:x/../y", "http:\\\\x", "http://x", "http:///x",
    "http:/\\\\x", "https:/x", "ws:/x", "foo:/x", "file:/x",
  ];
  return cases.map((url) => {
    try { return new URL(url, base).href; } catch (error) { return error.name; }
  });
}`,
  "URL setters": `async () => {
  const run = (start, key, values) => values.map((value) => {
    const u = new URL(start);
    u[key] = value;
    return u.href;
  });
  return {
    hostname: run("http://a.b:81/p", "hostname", [
      "[::1]", "[::1]:90", "example.net:90", "c.d/e", "c.d?x", "user@c.d", "", "exa mple", "C.D", "[::1", "0x7f.1",
    ]),
    host: run("http://a.b:81/p", "host", [
      "[::1]", "[::1]:90", "c.d:90", "c.d:", "c.d:80", "c.d:99999", "c.d:9x", "user@c.d", "user:pw@c.d:9", "", "c.d/e:1", ":90",
      "user:pw@c.d", "c.d:1:2", "c.d:9/x:1", "c.d:080", "c.d:65536", "c.d:x", "[::1]:80",
    ]),
    hostNoPort: run("http://a.b/p", "host", ["c.d:80", "c.d:99999"]),
    nonSpecialHost: run("foo://a:5/p", "host", ["", "b:1", "[::1]", "b@c", "b:", "b:99999"]),
    nonSpecialEmptyHost: run("foo://a/p", "host", [""]),
    nonSpecialHostname: run("foo://u@a:5/p", "hostname", ["", "b"]),
    protocol: run("http://a.b/p", "protocol", [
      "https", "https:", "https:foo", "https://x", "ht tps", "https!", "1http", "foo", "ws:", "HTTPS", "\\thttps",
    ]),
    fileProtocol: run("file:///p", "protocol", ["http"]),
    opaqueHost: run("mailto:x@y", "host", ["z"]),
  };
}`,
  URLSearchParams: `async () => {
  const p = new URLSearchParams("?b=2&a=1&a=3&sp=a+b%20c&uni=%C3%A9&bad=%E0%A4%A");
  p.append("x y", "ä&=+");
  p.sort();
  const sorted = p.toString();
  const all = p.getAll("a");
  p.set("a", "9");
  p.delete("b");
  return {
    sorted, all, size: p.size, after: p.toString(), entries: [...p],
    has: [p.has("a"), p.has("a", "1"), p.has("zz")],
    fromObject: new URLSearchParams({ q: "hello world", n: 5 }).toString(),
    fromPairs: new URLSearchParams([["k", "v"], ["k", "w"]]).toString(),
  };
}`,
  "URLSearchParams live traversal": `async () => {
  const appended = new URLSearchParams("a=1&b=2");
  const keys = appended.keys();
  appended.append("c", "3");
  const keysAfterAppend = [...keys];

  const deleted = new URLSearchParams("a=1&b=2&c=3");
  const visited = [];
  deleted.forEach((value, key) => {
    visited.push(key + value);
    if (key === "a") deleted.delete("c");
  });

  const grown = new URLSearchParams("x=1");
  const grownVisits = [];
  grown.forEach((value, key) => {
    grownVisits.push(key);
    if (grownVisits.length < 3) grown.append("y" + grownVisits.length, value);
  });

  const shifted = new URLSearchParams("a=1&b=2&c=3");
  const entries = shifted.entries();
  const first = entries.next().value;
  shifted.delete("a");
  const rest = [...entries];

  const reset = new URLSearchParams("a=1&b=2");
  const values = reset.values();
  values.next();
  reset.set("a", "9");
  reset.sort();
  const drained = values.next();
  reset.append("z", "0");
  const afterDone = values.next();

  const linked = new URL("https://h/?a=1&b=2");
  const linkedKeys = linked.searchParams.keys();
  linked.search = "?c=3&d=4&e=5";
  const linkedRest = [...linkedKeys];

  return { keysAfterAppend, visited, grownVisits, first, rest, drained, afterDone, linkedRest };
}`,
  base64: `async () => {
  const attempt = (run) => { try { return run(); } catch (error) { return error.name; } };
  return {
    encode: ["", "f", "fo", "foo", "foob", "fooba", "foobar", "\\u00ff\\u0000\\u0080", 123, null, undefined].map((value) => btoa(value)),
    decode: ["", "Zg", "Zg==", "Zm8=", "Zm9v", " Zm 9v\\n", "Zm9vYg", "/+8=", "AP+A"].map((value) => atob(value)),
    decodeBad: ["Z", "Zg=", "Zg===", "Z=g=", "Zm9v!", "Zm9v=", "===="].map((value) => attempt(() => atob(value))),
    encodeBad: attempt(() => btoa("é👋")),
    roundTrip: atob(btoa(String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i)))).length,
  };
}`,
  TextEncoder: `async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode("héllo 👋 \\uD800x");
  const decoder = new TextDecoder();
  const wave = encoder.encode("👋é");
  const streamed = [decoder.decode(wave.subarray(0, 2), { stream: true }), decoder.decode(wave.subarray(2, 5), { stream: true }), decoder.decode(wave.subarray(5))];
  let fatal = "accepted";
  try { new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xc3])); } catch (error) { fatal = error.name; }
  const target = new Uint8Array(5);
  return {
    bytes: Array.from(bytes),
    roundTrip: decoder.decode(bytes),
    replaced: decoder.decode(new Uint8Array([0x61, 0xff, 0xe2, 0x82, 0x62, 0xf0, 0x9f, 0x91])),
    streamed, fatal,
    bom: decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
    fromBuffer: decoder.decode(new Uint8Array([104, 105]).buffer),
    encodeInto: [encoder.encodeInto("aé👋", target), Array.from(target)],
  };
}`,
  setInterval: `async () => {
  let ticks = 0;
  await new Promise((resolve) => {
    const id = setInterval((step) => {
      ticks += step;
      if (ticks === 3) { clearInterval(id); resolve(); }
    }, 5, 1);
  });
  let crossCleared = 0;
  const other = setInterval(() => { crossCleared++; }, 5);
  clearTimeout(other);
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { ticks, crossCleared };
}`,
  crypto: `async () => {
  const uuids = [crypto.randomUUID(), crypto.randomUUID()];
  const words = new Uint32Array(8);
  const same = crypto.getRandomValues(words) === words;
  let quota = "accepted";
  try { crypto.getRandomValues(new Uint8Array(65537)); } catch (error) { quota = error.name; }
  return {
    v4: uuids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)),
    distinct: uuids[0] !== uuids[1],
    same,
    filled: words.some((word) => word !== 0),
    quota,
  };
}`,
  "fetch bodies": `async ({ base }) => {
  const send = async (body, headers) => (await fetch(base, { method: "POST", body, headers })).json();
  return {
    uint8: await send(new Uint8Array([0, 1, 254, 255])),
    view: await send(new Uint16Array([1, 2]).subarray(1)),
    buffer: await send(new Uint8Array([7, 8, 9]).buffer, { "content-type": "application/octet-stream" }),
    form: await send(new URLSearchParams({ a: "1 2", b: "é" })),
    formTyped: await send(new URLSearchParams("x=1"), { "Content-Type": "text/plain" }),
  };
}`,
};

// Imports the probe as a module, so Bun's own globals compute the expectation.
async function runInBun(probe: string, args: unknown): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "parity-probe-"));
  try {
    const file = join(dir, "probe.js");
    await Bun.write(file, `export default ${probe};`);
    const mod = (await import(file)) as { default: (args: unknown) => Promise<unknown> };
    return await mod.default(args);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("quickjs parity shims match native and Bun", () => {
  const args = { base: `http://127.0.0.1:${echoServer.port}/echo` };
  const executors: Array<[string, () => ScriptExecutor, boolean]> = [
    ["native", () => new NativeScriptExecutor(), true],
    ["quickjs", () => new QuickJSScriptExecutor(), false],
  ];
  for (const [name, probe] of Object.entries(PARITY_PROBES)) {
    for (const [executorName, makeExecutor, spawns] of executors) {
      // The native case spawns a bun subprocess with a 10s script budget, so
      // the test timeout must outlast it (runbooks/testing.md hard rule 5).
      test.skipIf(spawns && SKIP_SANDBOX_SPAWN_TESTS)(
        `${name} (${executorName})`,
        async () => {
          const expected = await runInBun(probe, args);
          const output = await makeExecutor().run(
            input({
              source: `export default ${probe};`,
              args,
              resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 2048, wallClockMs: 10_000 },
            }),
          );
          expect(output.error).toBeUndefined();
          expect(output.result).toEqual(expected);
        },
        CHILD_PROCESS_TEST_BUDGET_MS,
      );
    }
  }
});

describe("quickjs structuredClone boundaries", () => {
  test("snapshots Map and Set entries before getters can mutate them", async () => {
    // StructuredSerializeInternal snapshots collections before recursing. Bun's
    // current live traversal differs, so use the standard's result as the oracle.
    const output = await new QuickJSScriptExecutor().run(
      input({
        source: `export default async () => {
          const map = new Map();
          map.set('first', { get value() { map.delete('second'); map.set('third', 3); return 1; } });
          map.set('second', 2);
          const set = new Set();
          set.add({ get value() { set.delete(2); set.add(3); return 1; } });
          set.add(2);
          return { map: [...structuredClone(map)], set: [...structuredClone(set)] };
        };`,
      }),
    );
    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({
      map: [
        ["first", { value: 1 }],
        ["second", 2],
      ],
      set: [{ value: 1 }, 2],
    });
  });

  test("rejects transfers without detaching the source buffer", async () => {
    const output = await new QuickJSScriptExecutor().run(
      input({
        source: `export default async () => {
          const buffer = new ArrayBuffer(8);
          try { structuredClone(buffer, { transfer: [buffer] }); }
          catch (error) { return { name: error.name, message: error.message, byteLength: buffer.byteLength }; }
        };`,
      }),
    );
    expect(output.error).toBeUndefined();
    expect(output.result).toEqual({
      name: "DataCloneError",
      message: "quickjs structuredClone does not support transfers",
      byteLength: 8,
    });
  });

  test("rejects shared, resizable and detached buffers instead of changing their semantics", async () => {
    const output = await new QuickJSScriptExecutor().run(
      input({
        source: `export default async () => {
          const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
          const detached = new ArrayBuffer(8);
          const view = new Uint8Array(detached);
          detached.transfer();
          return [new SharedArrayBuffer(8), resizable, new Uint8Array(resizable), detached, view].map(value => {
            try { structuredClone(value); return 'accepted'; }
            catch (error) { return error.name; }
          });
        };`,
      }),
    );
    expect(output.error).toBeUndefined();
    expect(output.result).toEqual(Array(5).fill("DataCloneError"));
  });

  test("uses captured intrinsics and a fresh clone function on the next run", async () => {
    const executor = new QuickJSScriptExecutor();
    const output = await executor.run(
      input({
        source: `export default async () => {
          const value = { map: new Map([['x', 7]]), bytes: new Uint8Array([1, 2]), error: new TypeError('bad') };
          const Type = TypeError;
          const broken = () => { throw Error('replaced intrinsic'); };
          Map.prototype.set = broken;
          Uint8Array.prototype.set = broken;
          Error.isError = broken;
          globalThis.TypeError = broken;
          const copy = structuredClone(value);
          globalThis.structuredClone = broken;
          return [copy.map.get('x'), copy.bytes[1], copy.error instanceof Type];
        };`,
      }),
    );
    expect(output.error).toBeUndefined();
    expect(output.result).toEqual([7, 2, true]);
    const next = await executor.run(
      input({ source: "export default async () => structuredClone({ value: 7 });" }),
    );
    expect(next.error).toBeUndefined();
    expect(next.result).toEqual({ value: 7 });
  });
});

// Retries: `retry()` in the stdlib, method-aware `ctx.stdlib.fetch` retries,
// and the bridge's own retries under `ctx.swarm`. The fixture fails the first
// N hits of a path whose segment reads `<status>-<N>-<tag>`, then answers 200.
// Routes with a fixed path (the MCP bridge, rooms/decode, scripts/run) carry
// the spec in the JSON body instead; their hits are keyed by the spec. A tag
// with `stall` holds the next answer for 20 s, one with `slow` for 6 s.
type RetryHit = { at: number; key: string | null };
const retryHits = new Map<string, RetryHit[]>();
const holdFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());
const retryServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.text() : "";
    const bodySpec = /(\d{3})-(\d+)-([\w-]+)/.exec(body);
    const spec = /(\d{3})-(\d+)-([^/]+)/.exec(path) ?? bodySpec;
    const hitKey = spec === bodySpec && spec ? spec[0] : path;
    const hits = retryHits.get(hitKey) ?? [];
    hits.push({ at: Date.now(), key: req.headers.get("idempotency-key") });
    retryHits.set(hitKey, hits);
    if (spec && hits.length <= Number(spec[2])) {
      if (spec[3].includes("held")) await holdFor(6_000);
      const status = Number(spec[1]);
      const headers: Record<string, string> =
        status === 429 && spec[3].includes("ra") ? { "retry-after": "1" } : {};
      return Response.json({ error: "transient" }, { status, headers });
    }
    if (spec?.[3].includes("stall")) await holdFor(20_000);
    if (spec?.[3].includes("slow")) await holdFor(6_000);
    return Response.json({ ok: true, key: "k", value: 1 });
  },
});
afterAll(() => retryServer.stop(true));
const retryBase = `http://127.0.0.1:${retryServer.port}`;
const hitsOf = (path: string) => retryHits.get(path) ?? [];

// A raw TCP server whose first connection for each path closes before any
// answer (a network error on the client); later connections answer 200.
const dropHits = new Map<string, number>();
const dropKeys = new Map<string, Array<string | null>>();
const dropServer = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    async data(socket, chunk) {
      const path = /^[A-Z]+ (\S+)/.exec(chunk.toString())?.[1] ?? "";
      const count = (dropHits.get(path) ?? 0) + 1;
      dropHits.set(path, count);
      const keys = dropKeys.get(path) ?? [];
      keys.push(/idempotency-key: ([^\r\n]+)/i.exec(chunk.toString())?.[1] ?? null);
      dropKeys.set(path, keys);
      if (count === 1) {
        if (path.includes("held")) await holdFor(6_000);
        socket.end();
        return;
      }
      const reply = JSON.stringify({ ok: true, key: "k", value: 1 });
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${reply.length}\r\nConnection: close\r\n\r\n${reply}`,
      );
    },
  },
});
afterAll(() => dropServer.stop(true));
const dropBase = `http://127.0.0.1:${dropServer.port}`;

describe("retries match across executors", () => {
  const executors: Array<[string, () => ScriptExecutor, boolean]> = [
    ["native", () => new NativeScriptExecutor(), true],
    ["quickjs", () => new QuickJSScriptExecutor(), false],
  ];
  const run = (
    makeExecutor: () => ScriptExecutor,
    source: string,
    args: unknown = {},
    mcpBaseUrl = retryBase,
  ) =>
    makeExecutor().run(
      input({
        source,
        args,
        configPayload: {
          ...payload,
          system: { ...payload.system, mcpBaseUrl: { value: mcpBaseUrl, isSecret: false } },
        },
        resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 2048, wallClockMs: 15_000 },
      }),
    );

  for (const [name, makeExecutor, spawns] of executors) {
    const retryTest = (title: string, fn: () => Promise<void>) =>
      test.skipIf(spawns && SKIP_SANDBOX_SPAWN_TESTS)(
        `${title} (${name})`,
        fn,
        CHILD_PROCESS_TEST_BUDGET_MS,
      );

    retryTest("retry() handles sync and async functions", async () => {
      const output = await run(
        makeExecutor,
        `import { retry } from "stdlib";
export default async (_args, ctx) => {
  const fast = { minDelayMs: 1 };
  const out = {};
  let calls = 0;
  out.syncReturn = [await retry(() => { calls++; return 5; }), calls];
  calls = 0;
  out.syncThrowThenOk = [await retry((a) => { calls++; if (a < 2) throw new Error("x"); return a; }, fast), calls];
  calls = 0;
  out.asyncRejectThenOk = [await retry(async (a) => { calls++; if (a < 3) throw new Error("x"); return "ok"; }, fast), calls];
  calls = 0;
  try {
    await retry((a) => { calls++; throw new Error("fail " + a); }, { ...fast, retries: 2 });
    out.exhausted = "resolved";
  } catch (error) {
    out.exhausted = [error.message, calls];
  }
  calls = 0;
  try {
    await ctx.stdlib.retry(() => { calls++; throw new Error("stop"); }, { ...fast, retryOn: () => false });
  } catch (error) {
    out.retryOnFalse = [error.message, calls];
  }
  calls = 0;
  out.lastResult = [await retry(() => { calls++; return { success: false, status: 502 }; }, { ...fast, retries: 1 }), calls];
  calls = 0;
  const add = retry.wrap((a, b) => { calls++; if (calls < 2) throw new Error("x"); return a + b; }, fast);
  out.wrap = [await add(2, 3), calls];
  return out;
};`,
      );
      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({
        syncReturn: [5, 1],
        syncThrowThenOk: [2, 2],
        asyncRejectThenOk: ["ok", 3],
        exhausted: ["fail 3", 3],
        retryOnFalse: ["stop", 1],
        lastResult: [{ success: false, status: 502 }, 2],
        wrap: [5, 2],
      });
    });

    retryTest("retry() honours Retry-After on a 429", async () => {
      const path = `/f/429-1-ra-${name}`;
      const output = await run(
        makeExecutor,
        `export default async (args, ctx) => {
  const res = await ctx.stdlib.retry(() => fetch(args.url), { minDelayMs: 1 });
  return res.status;
};`,
        { url: `${retryBase}${path}` },
      );
      expect(output.error).toBeUndefined();
      expect(output.result).toBe(200);
      const hits = hitsOf(path);
      expect(hits.length).toBe(2);
      expect(hits[1].at - hits[0].at).toBeGreaterThanOrEqual(900);
    });

    retryTest("stdlib.fetch retries by method and idempotency key", async () => {
      const paths = {
        postNoKey: `/f/502-5-postnokey-${name}`,
        postKey: `/f/502-2-postkey-${name}`,
        get: `/f/502-1-get-${name}`,
        off: `/f/502-5-off-${name}`,
        legacy: `/f/502-5-legacy-${name}`,
      };
      const urls = Object.fromEntries(
        Object.entries(paths).map(([key, path]) => [key, `${retryBase}${path}`]),
      );
      const output = await run(
        makeExecutor,
        `export default async (args, ctx) => {
  const f = ctx.stdlib.fetch;
  return {
    postNoKey: (await f(args.postNoKey, { method: "POST", body: "x", retry: { minDelayMs: 1 } })).status,
    postKey: (await f(args.postKey, { method: "POST", body: "x", retry: { minDelayMs: 1, idempotencyKey: true } })).status,
    get: (await f(args.get, { retry: { minDelayMs: 100 } })).status,
    off: (await f(args.off, { retry: false })).status,
    legacy: (await f(args.legacy, { retries: 2 })).status,
  };
};`,
        urls,
      );
      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({
        postNoKey: 502,
        postKey: 200,
        get: 200,
        off: 502,
        legacy: 502,
      });
      expect(hitsOf(paths.postNoKey).length).toBe(1);
      const keyed = hitsOf(paths.postKey);
      expect(keyed.length).toBe(3);
      expect(keyed[0].key).toMatch(/^[0-9a-f-]{36}$/);
      expect(new Set(keyed.map((hit) => hit.key)).size).toBe(1);
      const get = hitsOf(paths.get);
      expect(get.length).toBe(2);
      // Equal jitter: the first wait is at least half of minDelayMs.
      expect(get[1].at - get[0].at).toBeGreaterThanOrEqual(45);
      expect(hitsOf(paths.off).length).toBe(1);
      expect(hitsOf(paths.legacy).length).toBe(2);
    });

    // An abort during the backoff wait rejects at once with the signal's reason
    // and starts no further attempt. quickjs has no AbortController, so the
    // script falls back to a plain signal object there.
    retryTest("an abort ends the retry wait at once", async () => {
      const path = `/f/503-5-abort-${name}`;
      const output = await run(
        makeExecutor,
        `export default async (args, ctx) => {
  const controller = () => {
    if (typeof AbortController === "function") return new AbortController();
    const listeners = new Set();
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
    };
    return { signal, abort(reason) { signal.aborted = true; signal.reason = reason; for (const fn of [...listeners]) fn(); } };
  };
  const timed = async (start) => {
    const c = controller();
    setTimeout(() => c.abort(new Error("stop")), 100);
    const started = Date.now();
    try {
      await start(c.signal);
      return { error: null, ms: Date.now() - started };
    } catch (error) {
      return { error: error.message, ms: Date.now() - started };
    }
  };
  const slow = { retries: 1, minDelayMs: 2000, maxDelayMs: 2000 };
  let calls = 0;
  const fetchAbort = await timed((signal) => ctx.stdlib.fetch(args.url, { signal, retry: slow }));
  const retryAbort = await timed((signal) => ctx.stdlib.retry(() => { calls++; throw new Error("x"); }, { ...slow, signal }));
  const retryCalls = calls;
  calls = 0;
  const early = controller();
  early.abort(new Error("early"));
  let preAborted;
  try {
    await ctx.stdlib.retry(() => { calls++; return 1; }, { signal: early.signal });
  } catch (error) {
    preAborted = [error.message, calls];
  }
  return { fetchAbort, retryAbort, retryCalls, preAborted };
};`,
        { url: `${retryBase}${path}` },
      );
      expect(output.error).toBeUndefined();
      const result = output.result as {
        fetchAbort: { error: string | null; ms: number };
        retryAbort: { error: string | null; ms: number };
        retryCalls: number;
        preAborted: unknown;
      };
      // The first wait is at least 1000 ms, so anything under that is the abort.
      expect(result.fetchAbort.error).toBe("stop");
      expect(result.fetchAbort.ms).toBeLessThan(900);
      expect(hitsOf(path).length).toBe(1);
      expect(result.retryAbort.error).toBe("stop");
      expect(result.retryAbort.ms).toBeLessThan(900);
      expect(result.retryCalls).toBe(1);
      expect(result.preAborted).toEqual(["early", 0]);
    });

    retryTest("ctx.swarm retries 429 always and 5xx only when a repeat is safe", async () => {
      const keys = {
        write429: `429-1-w429-${name}`,
        read502: `502-1-r502-${name}`,
        write502: `502-1-w502-${name}`,
        trigger502: `502-1-trig-${name}`,
      };
      const output = await run(
        makeExecutor,
        `export default async (args, ctx) => {
  const pick = (r) => [r.success, r.status];
  return {
    write429: pick(await ctx.swarm.kv_set({ key: args.write429, value: 1 })),
    read502: pick(await ctx.swarm.kv_get({ key: args.read502 })),
    write502: pick(await ctx.swarm.kv_set({ key: args.write502, value: 1 })),
    trigger502: pick(await ctx.swarm.workflow_trigger({ id: args.trigger502, idempotencyKey: "same-key" })),
  };
};`,
        keys,
      );
      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({
        write429: [true, 200],
        read502: [true, 200],
        write502: [false, 502],
        trigger502: [true, 200],
      });
      expect(hitsOf(`/api/kv/${keys.write429}`).length).toBe(2);
      expect(hitsOf(`/api/kv/${keys.read502}`).length).toBe(2);
      expect(hitsOf(`/api/kv/${keys.write502}`).length).toBe(1);
      const trigger = hitsOf(`/api/workflows/${keys.trigger502}/trigger`);
      expect(trigger.map((hit) => hit.key)).toEqual(["same-key", "same-key"]);
    });

    retryTest("ctx.swarm retries a 502 on reads sent by POST", async () => {
      const keys = {
        appQuery: `502-1-appq-${name}`,
        userResolve: `502-1-user-${name}`,
        roomDecode: `502-1-room-${name}`,
        scriptRun: `502-1-srun-${name}`,
      };
      const output = await run(
        makeExecutor,
        `export default async (args, ctx) => {
  const out = {
    appQuery: (await ctx.swarm.app_query({ appId: args.appQuery, sql: "select 1" })).success,
    userResolve: (await ctx.swarm.user_resolve({ query: args.userResolve })).success,
    roomDecode: (await ctx.swarm.room.decode({ token: args.roomDecode })).ok,
  };
  try {
    await ctx.swarm.script_run({ name: args.scriptRun, idempotencyKey: "same-key", args: {} });
    out.scriptRun = "resolved";
  } catch (error) {
    out.scriptRun = error.message.includes("502");
  }
  return out;
};`,
        keys,
      );
      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({
        appQuery: true,
        userResolve: true,
        roomDecode: true,
        scriptRun: true,
      });
      expect(hitsOf(keys.appQuery).length).toBe(2);
      expect(hitsOf(keys.userResolve).length).toBe(2);
      expect(hitsOf(keys.roomDecode).length).toBe(2);
      // script_run's idempotencyKey does not dedupe the run, so a 502 never repeats it.
      expect(hitsOf(keys.scriptRun).length).toBe(1);
    });

    retryTest("ctx.swarm retries a network error on a read, never on a write", async () => {
      const keys = { read: `drop-read-${name}`, write: `drop-write-${name}` };
      const output = await run(
        makeExecutor,
        `export default async (args, ctx) => {
  const read = await ctx.swarm.kv_get({ key: args.read });
  let write;
  try {
    await ctx.swarm.kv_set({ key: args.write, value: 1 });
    write = "resolved";
  } catch {
    write = "threw";
  }
  return { read: [read.success, read.status], write };
};`,
        keys,
        dropBase,
      );
      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({ read: [true, 200], write: "threw" });
      expect(dropHits.get(`/api/kv/${keys.read}`)).toBe(2);
      expect(dropHits.get(`/api/kv/${keys.write}`)).toBe(1);
    });

    retryTest("ctx.swarm cuts a stalled read retry off at the retry budget", async () => {
      const keys = { read: `502-1-stall-${name}`, room: `502-1-stallroom-${name}` };
      const output = await run(
        makeExecutor,
        `export default async (args, ctx) => {
  let started = Date.now();
  const read = await ctx.swarm.kv_get({ key: args.read });
  const readMs = Date.now() - started;
  started = Date.now();
  let room;
  try {
    await ctx.swarm.room.decode({ token: args.room });
    room = "resolved";
  } catch (error) {
    room = error.message;
  }
  return { read: [read.success, read.status], readMs, room, roomMs: Date.now() - started };
};`,
        keys,
      );
      expect(output.error).toBeUndefined();
      const result = output.result as Record<string, unknown>;
      expect(result.read).toEqual([false, 502]);
      expect(result.readMs).toBeLessThan(6_000);
      expect(result.room).toContain("failed with 502");
      expect(result.room).toContain("retry budget");
      expect(result.roomMs).toBeLessThan(6_000);
      expect(hitsOf(`/api/kv/${keys.read}`).length).toBe(2);
      expect(hitsOf(keys.room).length).toBe(2);
    });

    retryTest("ctx.swarm never cuts off a write retried after a 429", async () => {
      const key = `429-1-slow-${name}`;
      const output = await run(
        makeExecutor,
        `export default async (args, ctx) => {
  const started = Date.now();
  const write = await ctx.swarm.kv_set({ key: args.key, value: 1 });
  return { write: [write.success, write.status], writeMs: Date.now() - started };
};`,
        { key },
      );
      expect(output.error).toBeUndefined();
      const result = output.result as Record<string, unknown>;
      // The 429 means the write never ran, so its retry is the real run and
      // may take longer than the retry budget.
      expect(result.write).toEqual([true, 200]);
      expect(result.writeMs).toBeGreaterThanOrEqual(5_900);
      expect(hitsOf(`/api/kv/${key}`).length).toBe(2);
    });

    // A keyed write is repeat-safe, but it is still a write: its retry may start
    // a run, so the read retry budget must not cut it off and report a failure.
    retryTest("ctx.swarm never cuts off a keyed write's retry", async () => {
      const keys = {
        after429: `429-1-slow-${name}-k429`,
        after502: `502-1-slow-${name}-k502`,
        held502: `502-1-held-${name}-k502`,
      };
      const droppedId = `held-drop-${name}`;
      const dropped = run(
        makeExecutor,
        `export default async (args, ctx) => {
  try {
    const r = await ctx.swarm.workflow_trigger({ id: args.id, idempotencyKey: "same-key" });
    return [r.success, r.status];
  } catch {
    return "threw";
  }
};`,
        { id: droppedId },
        dropBase,
      );
      const output = await run(
        makeExecutor,
        `export default async (args, ctx) => {
  const timed = async (id) => {
    const started = Date.now();
    const r = await ctx.swarm.workflow_trigger({ id, idempotencyKey: "same-key" });
    return { result: [r.success, r.status], ms: Date.now() - started };
  };
  const { held502: key } = args;
  const [after429, after502, held502, read] = await Promise.all([
    timed(args.after429), timed(args.after502), timed(args.held502),
    ctx.swarm.kv_get({ key }),
  ]);
  return { after429, after502, held502, read: [read.success, read.status] };
};`,
        keys,
      );
      expect(output.error).toBeUndefined();
      const result = output.result as Record<string, { result: unknown; ms: number }>;
      const droppedOutput = await dropped;
      expect(droppedOutput.error).toBeUndefined();
      expect({ held502: result.held502.result, dropped: droppedOutput.result }).toEqual({
        held502: [true, 200],
        dropped: [true, 200],
      });
      expect(dropKeys.get(`/api/workflows/${droppedId}/trigger`)).toEqual(["same-key", "same-key"]);
      expect(output.result).toMatchObject({ read: [false, 502] });
      expect(hitsOf(`/api/kv/${keys.held502}`).length).toBe(1);
      for (const [label, id] of Object.entries(keys)) {
        expect(result[label].result).toEqual([true, 200]);
        expect(result[label].ms).toBeGreaterThanOrEqual(5_900);
        const hits = hitsOf(`/api/workflows/${id}/trigger`);
        expect(hits.map((hit) => hit.key)).toEqual(["same-key", "same-key"]);
      }
    });
  }
});

describe("native-only executor behavior", () => {
  test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)("timeout maps to timeout", async () => {
    const output = await new NativeScriptExecutor().run(
      input({
        resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 2048, wallClockMs: 100 },
        source: "export default async () => new Promise(() => {});",
      }),
    );
    expect(output.error).toBe("timeout");
  });

  // Aborts before Bun.spawn — never spawn-dependent.
  test("AbortSignal maps to killed", async () => {
    const controller = new AbortController();
    controller.abort();
    const output = await new NativeScriptExecutor().run(input({ signal: controller.signal }));
    expect(output.error).toBe("killed");
  });

  // Before the fix the abort listener was added after the file writes, so an
  // abort that landed during them was missed and the script ran to the end.
  test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)(
    "an abort while args.json is written kills the run before the script starts",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "native-abort-"));
      const marker = join(dir, "side-effect.marker");
      const controller = new AbortController();
      const write = Bun.write;
      const spy = spyOn(Bun, "write").mockImplementation((async (
        ...writeArgs: Parameters<typeof Bun.write>
      ) => {
        const written = await write(...writeArgs);
        if (String(writeArgs[0]).endsWith("/args.json")) controller.abort();
        return written;
      }) as typeof Bun.write);
      try {
        const output = await new NativeScriptExecutor().run(
          input({
            source: `export default async () => { await Bun.write(${JSON.stringify(marker)}, "ran"); return "ran"; };`,
            signal: controller.signal,
            resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 2048, wallClockMs: 10_000 },
          }),
        );
        expect(output.error).toBe("killed");
        expect(output.result).toBeUndefined();
        expect(await Bun.file(marker).exists()).toBe(false);
      } finally {
        spy.mockRestore();
        await rm(dir, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  // PR #1326 review finding: exit 134 (SIGABRT) was classified `capacity_exceeded`
  // — and therefore retried by `runScript` — purely from the exit code, with no
  // evidence about *when* the abort happened. A script that causes a side effect
  // (e.g. an API POST) and then aborts must not be replayed. `process.abort()`
  // called from inside the user function reliably raises SIGABRT independent of
  // any real RLIMIT_NPROC exhaustion, so this is deterministic.
  //
  // wallClockMs is raised above the file's 1s default purely as headroom for a
  // slow CI runner to spawn + start a full bun subprocess; it is not load-bearing
  // for correctness. Earlier attempts here (ee39228e, 5c965fab) treated this as a
  // race against the wall-clock watchdog and kept bumping the budget, but that
  // race was actually a real bug in `classifyExit` (see the comment on
  // `SANDBOX_CAPACITY_EXIT_CODE` in native.ts): it let a racy `timedOut` flag
  // override a 134 exit code even though our own kill path can never produce
  // 134. That precedence is now fixed, so the assertion below no longer depends
  // on winning a timing race.
  // Explicit test timeout: these two tests each spawn a REAL bun subprocess and
  // give the script enough wall-clock headroom for spawn + interpreter startup.
  // A 5s script budget is not enough on a saturated runner: on 2d1a1801 the
  // top-level variant below took 8653ms, and PR #1371 measured both variants at
  // ~5.29s after the 5s watchdog fired and its 250ms process-group escalation
  // replaced the pending self-abort with SIGKILL (137). The explicit 30s test
  // timeout below allows this larger script budget. This is scheduling
  // headroom so the test measures self-abort classification instead of racing
  // framework teardown; every exit-code and classification assertion remains
  // strict.
  const SANDBOX_SPAWN_TIMEOUT_MS = 30_000;
  const SANDBOX_SCRIPT_WALL_CLOCK_MS = 20_000;

  test(
    "SIGABRT raised by user code is not classified capacity_exceeded",
    async () => {
      const output = await new NativeScriptExecutor().run(
        input({
          resources: {
            ...DEFAULT_SCRIPT_RESOURCES,
            memoryMb: 2048,
            wallClockMs: SANDBOX_SCRIPT_WALL_CLOCK_MS,
          },
          source: "export default async () => { process.abort(); };",
        }),
      );
      expect(output.exitCode).toBe(134);
      expect(output.error).not.toBe("capacity_exceeded");
      expect(output.error).toBe("eval_error");
    },
    SANDBOX_SPAWN_TIMEOUT_MS,
  );

  // PR #1326 review finding (comment 3932610586): the sentinel is written
  // immediately before `eval-harness.ts` dynamic-imports the user module, and
  // importing a module executes its top-level code. The prior test above only
  // proves the boundary holds for an abort inside the *exported* function
  // (which only runs after import — and therefore the sentinel write —
  // completes); it does not exercise an abort that happens *during* import,
  // while top-level module code is running. This test closes that gap: the
  // side effect (the console.log) and the abort both happen at module scope,
  // before the harness ever reaches `mod.default(...)`. If this were
  // misclassified `capacity_exceeded`, `runScript` in loader.ts would
  // transparently retry and the side effect would replay.
  // See the wallClockMs comment on the test above — same fix applies here.
  test(
    "SIGABRT during top-level module evaluation (after import starts) is not classified capacity_exceeded",
    async () => {
      const output = await new NativeScriptExecutor().run(
        input({
          resources: {
            ...DEFAULT_SCRIPT_RESOURCES,
            memoryMb: 2048,
            wallClockMs: SANDBOX_SCRIPT_WALL_CLOCK_MS,
          },
          source:
            "console.log('TOP_LEVEL_SIDE_EFFECT'); process.abort(); export default async () => {};",
        }),
      );
      expect(output.stdout).toContain("TOP_LEVEL_SIDE_EFFECT");
      expect(output.exitCode).toBe(134);
      expect(output.error).not.toBe("capacity_exceeded");
      expect(output.error).toBe("eval_error");
    },
    SANDBOX_SPAWN_TIMEOUT_MS,
  );
});

describe("classifyExit", () => {
  test("timeout and killed take precedence over other exit codes", () => {
    expect(classifyExit(1, true, false, false)).toBe("timeout");
    expect(classifyExit(1, false, true, false)).toBe("killed");
  });

  test("exit 134 is authoritative even if the watchdog also fired (our kill can't produce SIGABRT)", () => {
    expect(classifyExit(134, true, false, false)).toBe("capacity_exceeded");
    expect(classifyExit(134, false, true, false)).toBe("capacity_exceeded");
    expect(classifyExit(134, true, false, true)).toBe("eval_error");
  });

  test("exit 0 is success regardless of userCodeStarted", () => {
    expect(classifyExit(0, false, false, false)).toBeUndefined();
    expect(classifyExit(0, false, false, true)).toBeUndefined();
  });

  test("OOM-kill exit codes map to killed", () => {
    expect(classifyExit(137, false, false, false)).toBe("killed");
    expect(classifyExit(9, false, false, false)).toBe("killed");
  });

  test("134 before user code starts is capacity_exceeded (retryable)", () => {
    expect(classifyExit(134, false, false, false)).toBe("capacity_exceeded");
  });

  test("134 after user code starts is eval_error (not retryable)", () => {
    expect(classifyExit(134, false, false, true)).toBe("eval_error");
  });

  test("other non-zero exit codes map to eval_error", () => {
    expect(classifyExit(1, false, false, false)).toBe("eval_error");
  });
});
