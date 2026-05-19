import { describe, expect, test } from "bun:test";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import type {
  ExecutorInput,
  ExecutorOutput,
  ScriptExecutor,
} from "../scripts-runtime/executors/types";
import { DEFAULT_SCRIPT_RESOURCES } from "../scripts-runtime/executors/types";

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

function conformance(name: string, makeExecutor: () => ScriptExecutor) {
  describe(`${name} ScriptExecutor conformance`, () => {
    test("happy path run", async () => {
      const output = await makeExecutor().run(
        input({
          source: "export default async (args) => args.x + 1;",
          args: { x: 2 },
        }),
      );
      expect(output.exitCode).toBe(0);
      expect(output.error).toBeUndefined();
    });

    test("stdout cap is honored", async () => {
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

    test("workspace-rw returns executor_error", async () => {
      const output = await makeExecutor().run(input({ fsMode: "workspace-rw" }));
      expect(output.error).toBe("executor_error");
    });

    test("config payload is delivered", async () => {
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

conformance("native", () => new NativeScriptExecutor());
conformance("fake", () => new FakeScriptExecutor());

describe("native-only executor behavior", () => {
  test("timeout maps to timeout", async () => {
    const output = await new NativeScriptExecutor().run(
      input({
        resources: { ...DEFAULT_SCRIPT_RESOURCES, memoryMb: 2048, wallClockMs: 100 },
        source: "export default async () => new Promise(() => {});",
      }),
    );
    expect(output.error).toBe("timeout");
  });

  test("AbortSignal maps to killed", async () => {
    const controller = new AbortController();
    controller.abort();
    const output = await new NativeScriptExecutor().run(input({ signal: controller.signal }));
    expect(output.error).toBe("killed");
  });
});
