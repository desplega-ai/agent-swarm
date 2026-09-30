import { describe, expect, test } from "bun:test";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

const watchdogModule = JSON.stringify(`${import.meta.dir}/hang-watchdog`);

/** Runs `body` in a fresh `bun` process with the watchdog armed at `limitMs` (no test preload). */
function runWithWatchdog(body: string, limitMs: number) {
  return runChild(
    [
      process.execPath,
      "-e",
      `import { startHangWatchdog } from ${watchdogModule}; startHangWatchdog("fixture"); ${body}`,
    ],
    { env: { ...process.env, TEST_HANG_WATCHDOG_MS: String(limitMs) } },
  );
}

describe("startHangWatchdog", () => {
  test(
    "kills a process whose main thread is stuck in a synchronous loop, and only that one",
    async () => {
      const [spinning, yielding, disabled] = await Promise.all([
        runWithWatchdog("while (true) {}", 3000),
        // Yields every tick, so the heartbeat keeps moving well past the limit.
        runWithWatchdog('await Bun.sleep(4500); console.log("finished");', 3000),
        // 0 turns it off: a 4s synchronous spin is left alone.
        runWithWatchdog(
          'const end = Date.now() + 4000; while (Date.now() < end) {} console.log("finished");',
          0,
        ),
      ]);

      expect(spinning.signalCode).toBe("SIGKILL");
      expect(spinning.stderr).toContain("[hang-watchdog] fixture: main thread blocked for");
      expect(spinning.durationMs).toBeLessThan(10_000);

      expect(yielding.exitCode).toBe(0);
      expect(yielding.stdout).toContain("finished");

      expect(disabled.exitCode).toBe(0);
      expect(disabled.stdout).toContain("finished");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
