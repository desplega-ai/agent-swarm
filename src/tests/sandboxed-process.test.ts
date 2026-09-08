import { describe, expect, test } from "bun:test";
import {
  BUN_NO_ORPHANS_FLAG,
  BUN_SANDBOX_VIRTUAL_MEMORY_MB,
  buildSandboxedCommand,
  buildSandboxedCommandForNprocEnforcementTest,
  createCappedStreamState,
  DEFAULT_SANDBOX_LIMITS,
  JAVASCRIPT_RUNTIME_SANDBOX_MAX_PROCS,
  readStreamCapped,
  type SandboxResourceLimits,
  sandboxSpawnEnv,
  snapshotCapped,
} from "../utils/sandboxed-process";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

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

  test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)(
    "the raised profile starts a shell-wrapped Bun process with real nproc enforcement",
    async () => {
      const result = await runChild(
        buildSandboxedCommand(
          ["bash", "-c", "bun -e 'console.log(JSON.stringify({ started: true }))'"],
          TEST_ENV,
        ),
        { env: sandboxSpawnEnv(TEST_ENV) },
      );
      expectChildOk(result, "sandboxed bun -e probe");
      expect(JSON.parse(result.stdout)).toEqual({ started: true });
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  // ─── DES issue #1332: "many small processes" (fork-bomb-shaped) containment ──
  //
  // Covers only what a unit test can exercise: that `ulimit -u` inside
  // `buildSandboxedCommand`'s own prelude actually stops a runaway process
  // tree, not the independent `pids_limit` / RuntimeClass containment added
  // alongside this test (docker-compose*.yml, charts/agent-swarm) — those are
  // enforced by the container runtime/kubelet, outside anything a Bun unit
  // test can spin up. See the compose files and charts/agent-swarm/README.md
  // "Sandboxed-script pids containment" for that layer.
  //
  // `ulimit -u` (RLIMIT_NPROC) is accounted by the kernel per real UID,
  // fleet-wide — not per this process tree, and not visible to `ps` inside
  // this container's own PID namespace (confirmed empirically while writing
  // this test: `ps`-visible same-UID task count read ~100, yet a fixed
  // `ulimit -u 120` inside a fresh `bash -c` still failed the very first
  // fork; ~1000 was the observed floor for one fork to succeed). A ceiling
  // derived from an in-container measurement would therefore be unsound —
  // measuring more only proves the fleet-wide number is invisible, it does
  // not make deriving a safe headroom from it possible. Use a fixed ceiling
  // instead, deliberately far below any realistic ambient floor, so a
  // fork-bomb-shaped loop can never legitimately clear it either way.
  test.skipIf(SKIP_SANDBOX_SPAWN_TESTS)(
    "RLIMIT_NPROC containment stops a many-small-processes fork-bomb-shaped script well short of every attempt",
    async () => {
      const attemptCount = 40;
      const tinyLimits: SandboxResourceLimits = { ...DEFAULT_SANDBOX_LIMITS, maxProcs: 8 };

      // Fork background `sleep`s one at a time, counting each success; a
      // failed fork (EAGAIN once RLIMIT_NPROC is hit) stops the loop.
      const script = [
        "spawned=0",
        `for i in $(seq 1 ${attemptCount}); do`,
        "  sleep 5 & fork_ok=$?",
        "  if [ $fork_ok -eq 0 ]; then spawned=$((spawned + 1)); else break; fi",
        "done",
        "echo $spawned",
        "wait 2>/dev/null",
      ].join("; ");

      // Plain `buildSandboxedCommand` cannot exercise this: passing
      // `["bash", "-c", script]` gets `tinyLimits.maxProcs: 8` silently
      // discarded in favor of the `JAVASCRIPT_RUNTIME_SANDBOX_MAX_PROCS`
      // (4096) interpreter floor (Codex PRRT_kwDOQr3Tmc6gX9f1), and routing
      // through a non-shell inner command instead gets the "sh" branch,
      // whose dash `ulimit` silently no-ops on `-u` — so nothing would ever
      // actually be enforced either way. Use the test-only helper that
      // forces bash (so `-u` is real) while skipping only the floor, so
      // `tinyLimits.maxProcs` is both the rendered AND the enforced ceiling.
      const command = buildSandboxedCommandForNprocEnforcementTest(
        ["bash", "-c", script],
        TEST_ENV,
        tinyLimits,
      );
      // Prove the tiny limit is actually the one rendered, not just assert
      // on behavior that could pass for the wrong reason (e.g. ambient
      // fleet-wide UID pressure happening to be low that run).
      expect(command[0]).toBe("bash");
      expect(command[2]).toContain(`ulimit -u ${tinyLimits.maxProcs}`);

      const result = await runChild(command, { env: sandboxSpawnEnv(TEST_ENV) });

      // `Number("")` is 0, not NaN — even a total wrapper-level fork failure
      // under extreme ambient load (a real possibility now that the ceiling
      // is genuinely 8, not 4096) reads as "0 spawned", which is still a
      // correct containment outcome rather than a broken assertion.
      const spawned = Number(result.stdout.trim());
      expect(spawned).toBeLessThan(attemptCount);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
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
