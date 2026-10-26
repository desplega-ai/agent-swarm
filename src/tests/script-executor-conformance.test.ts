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
