import { describe, expect, test } from "bun:test";
import {
  buildSandboxedCommand,
  createCappedStreamState,
  readStreamCapped,
  sandboxSpawnEnv,
  snapshotCapped,
} from "../utils/sandboxed-process";

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
