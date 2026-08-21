import { describe, expect, test } from "bun:test";
import {
  BUN_NO_ORPHANS_FLAG,
  BUN_SANDBOX_VIRTUAL_MEMORY_MB,
  buildSandboxedCommand,
  createCappedStreamState,
  DEFAULT_SANDBOX_LIMITS,
  JAVASCRIPT_RUNTIME_SANDBOX_MAX_PROCS,
  readStreamCapped,
  sandboxSpawnEnv,
  snapshotCapped,
} from "../utils/sandboxed-process";

const TEST_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp" };

function sandboxPrelude(command: readonly string[]): string {
  return buildSandboxedCommand(command, TEST_ENV)[2] ?? "";
}

/**
 * Temporarily override `process.platform` for the duration of `fn`, then
 * restore it. Used to exercise the win32 branches of `buildSandboxedCommand`
 * / `sandboxSpawnEnv` on a Linux CI runner without an actual Windows host.
 */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

// ─── sandboxSpawnEnv (Codex PRRT_kwDOQr3Tmc6XCRuu — win32 env passthrough) ──

describe("sandboxSpawnEnv", () => {
  test("POSIX: returns only PATH — buildSandboxedCommand's env -i prelude injects the rest", () => {
    const env = withPlatform("linux", () =>
      sandboxSpawnEnv({ PATH: "/usr/bin:/bin", HOME: "/tmp", SWARM_SCRIPT_TMPDIR: "/tmp/x" }),
    );
    expect(env).toEqual({ PATH: "/usr/bin:/bin" });
  });

  test("win32: returns the complete env — there is no env -i prelude to inject it", () => {
    const fullEnv = {
      PATH: "C:\\Windows",
      SWARM_SCRIPT_TMPDIR: "C:\\tmp\\x",
      SCRIPT_RUN_STARTED_AT: "2026-08-06T00:00:00Z",
      MCP_BASE_URL: "http://localhost:3013",
    };
    const env = withPlatform("win32", () => sandboxSpawnEnv(fullEnv));
    expect(env).toEqual(fullEnv);
    // Must be a copy, not the same reference, so callers can't mutate shared state.
    expect(env).not.toBe(fullEnv);
  });

  test("win32: buildSandboxedCommand no-ops (matches existing native.ts behavior), so sandboxSpawnEnv is the only place the harness env reaches the child", () => {
    const cmd = withPlatform("win32", () =>
      buildSandboxedCommand(["bun", "run", "harness.ts"], {
        PATH: "C:\\Windows",
        SWARM_SCRIPT_TMPDIR: "C:\\tmp\\x",
      }),
    );
    expect(cmd).toEqual(["bun", "run", "harness.ts"]);
  });
});

describe("buildSandboxedCommand runtime-aware limits", () => {
  test.each(["bun", "node", "npx"])("raises AS and nproc for direct %s commands", (runtime) => {
    const command = buildSandboxedCommand([runtime, "--version"], TEST_ENV);
    expect(command[0]).toBe("bash");
    expect(command[2]).toContain(`ulimit -v ${BUN_SANDBOX_VIRTUAL_MEMORY_MB * 1024}`);
    expect(command[2]).toContain(`ulimit -u ${JAVASCRIPT_RUNTIME_SANDBOX_MAX_PROCS}`);
  });

  test.each(["bash", "sh", "dash"])("propagates the runtime profile through %s -c", (shell) => {
    const script = "bun /opt/meme-post.bundle.js";
    const prelude = sandboxPrelude([shell, "-c", script]);
    expect(prelude).toContain(`ulimit -v ${BUN_SANDBOX_VIRTUAL_MEMORY_MB * 1024}`);
    expect(prelude).toContain(`ulimit -u ${JAVASCRIPT_RUNTIME_SANDBOX_MAX_PROCS}`);
  });

  test("adds --no-orphans to a direct bun command exactly once, and only to bun", () => {
    const bunPrelude = sandboxPrelude(["bun", "run", "harness.ts"]);
    expect(bunPrelude).toContain(`'bun' '${BUN_NO_ORPHANS_FLAG}' 'run' 'harness.ts'`);

    const alreadyFlagged = sandboxPrelude(["bun", BUN_NO_ORPHANS_FLAG, "run", "harness.ts"]);
    expect(alreadyFlagged.split(BUN_NO_ORPHANS_FLAG)).toHaveLength(2);

    expect(sandboxPrelude(["node", "harness.js"])).not.toContain(BUN_NO_ORPHANS_FLAG);
    expect(sandboxPrelude(["git", "status"])).not.toContain(BUN_NO_ORPHANS_FLAG);
  });

  test("keeps strict defaults for direct non-interpreter commands", () => {
    const command = buildSandboxedCommand(["git", "status", "--short"], TEST_ENV);
    expect(command[0]).toBe("sh");
    const prelude = command[2] ?? "";
    expect(prelude).toContain(`ulimit -v ${DEFAULT_SANDBOX_LIMITS.virtualMemoryMb * 1024}`);
    expect(prelude).toContain(`ulimit -u ${DEFAULT_SANDBOX_LIMITS.maxProcs}`);
  });

  test("the raised profile starts a shell-wrapped Bun process with real nproc enforcement", () => {
    const result = Bun.spawnSync(
      buildSandboxedCommand(
        ["bash", "-c", "bun -e 'console.log(JSON.stringify({ started: true }))'"],
        TEST_ENV,
      ),
      { env: sandboxSpawnEnv(TEST_ENV) },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ started: true });
  });
});

// ─── readStreamCapped / snapshotCapped (Codex PRRT_kwDOQr3Tmc6XCRuy — deadline snapshot) ──

describe("readStreamCapped with an external CappedStreamState", () => {
  test("snapshotCapped mid-read returns bytes accumulated so far, not an empty result", async () => {
    const state = createCappedStreamState();
    let releaseSecondChunk: (() => void) | undefined;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("first-chunk"));
        await secondChunkGate;
        controller.enqueue(new TextEncoder().encode("second-chunk"));
        controller.close();
      },
    });

    const readPromise = readStreamCapped(stream, 1_000_000, state);

    // Give the reader a tick to consume the first chunk before snapshotting —
    // this mirrors withDeadline firing while the promise is still pending.
    await Bun.sleep(10);
    const partial = snapshotCapped(state);
    expect(partial.text).toBe("first-chunk");
    expect(partial.truncated).toBe(true); // snapshot is always partial/incomplete by construction

    releaseSecondChunk?.();
    const complete = await readPromise;
    expect(complete.text).toBe("first-chunksecond-chunk");
    expect(complete.truncated).toBe(false);
  });
});
