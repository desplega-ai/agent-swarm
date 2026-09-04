import { describe, expect, test } from "bun:test";
import { classifyExit, NativeScriptExecutor } from "../scripts-runtime/executors/native";
import type {
  ExecutorInput,
  ExecutorOutput,
  ScriptExecutor,
} from "../scripts-runtime/executors/types";
import { DEFAULT_SCRIPT_RESOURCES } from "../scripts-runtime/executors/types";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

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
      result: runInput.configPayload.system.apiKey.value,
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
            "export default async (_args, ctx) => ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey);",
        }),
      );
      expect(output.result).toBe("conformance-secret");
    });
  });
}

conformance("native", () => new NativeScriptExecutor(), true);
conformance("fake", () => new FakeScriptExecutor(), false);

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
  test("SIGABRT raised by user code is not classified capacity_exceeded", async () => {
    const output = await new NativeScriptExecutor().run(
      input({
        resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 2048, wallClockMs: 5_000 },
        source: "export default async () => { process.abort(); };",
      }),
    );
    expect(output.exitCode).toBe(134);
    expect(output.error).not.toBe("capacity_exceeded");
    expect(output.error).toBe("eval_error");
  });

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
  test("SIGABRT during top-level module evaluation (after import starts) is not classified capacity_exceeded", async () => {
    const output = await new NativeScriptExecutor().run(
      input({
        resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 2048, wallClockMs: 5_000 },
        source:
          "console.log('TOP_LEVEL_SIDE_EFFECT'); process.abort(); export default async () => {};",
      }),
    );
    expect(output.stdout).toContain("TOP_LEVEL_SIDE_EFFECT");
    expect(output.exitCode).toBe(134);
    expect(output.error).not.toBe("capacity_exceeded");
    expect(output.error).toBe("eval_error");
  });
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
