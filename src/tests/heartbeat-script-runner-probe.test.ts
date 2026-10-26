import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { probeScriptRunner } from "../heartbeat/script-runner-probe";
import type { RunScriptOutput } from "../scripts-runtime/loader";

const ok: RunScriptOutput = {
  result: true,
  stdout: "",
  stderr: "",
  truncated: { stdout: false, stderr: false },
  durationMs: 1,
  exitCode: 0,
};

afterEach(() => mock.restore());

describe("heartbeat script runner probe", () => {
  test("success leaves the gate verdict unchanged and clears its deadline", async () => {
    const clear = spyOn(globalThis, "clearTimeout");
    const runner = mock(async () => ok);
    expect(await probeScriptRunner("lead", runner)).toBeNull();
    expect(runner).toHaveBeenCalledWith({
      source: "export default async function () { return true; }",
      agentId: "lead",
      fsMode: "none",
      timeoutMs: 10_000,
      signal: expect.any(AbortSignal),
    });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  test("timeout wakes without waiting for a stalled runner and aborts it", async () => {
    let expire: (() => void) | undefined;
    spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      expect(ms).toBe(10_000);
      expire = callback;
      return 1;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    let rejectRun: ((error: Error) => void) | undefined;
    const result = probeScriptRunner("lead", async (input) => {
      signal = input.signal;
      return new Promise<RunScriptOutput>((_, reject) => {
        rejectRun = reject;
      });
    });
    expire!();
    expect(await result).toEqual({
      quiet: false,
      reason: "script-runner-unhealthy: timeout after 10000ms",
    });
    expect(signal?.aborted).toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
    // A runner that rejects after the deadline remains handled by Promise.race.
    rejectRun!(new Error("late rejection"));
    await Promise.resolve();
  });

  test("a thrown runner error wakes", async () => {
    expect(
      await probeScriptRunner("lead", async () => {
        throw new Error("ECONNRESET");
      }),
    ).toEqual({
      quiet: false,
      reason: "script-runner-unhealthy: ECONNRESET",
    });
  });

  for (const [label, failure, reason] of [
    ["nonzero exit", { exitCode: 1 }, "script exited with code 1"],
    ["runner error", { error: "killed" }, "killed"],
    ["runtime error", { runtimeError: { message: "runtime failed" } }, "runtime failed"],
  ] as const) {
    test(`${label} wakes`, async () => {
      const result = await probeScriptRunner(
        "lead",
        async () => ({ ...ok, ...failure }) as RunScriptOutput,
      );
      expect(result).toEqual({ quiet: false, reason: `script-runner-unhealthy: ${reason}` });
    });
  }
});
