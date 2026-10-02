/**
 * Runs on its own thread, so it keeps ticking while the test file's main thread
 * is stuck in a synchronous loop. See `hang-watchdog.ts` for why it exists.
 */
import { writeSync } from "node:fs";
import { workerData } from "node:worker_threads";

const { heartbeat, file, limitMs } = workerData as {
  heartbeat: Int32Array;
  file: string;
  limitMs: number;
};

// Synchronous write: the process is SIGKILLed right after, which drops anything buffered.
const log = (message: string) => writeSync(2, `[hang-watchdog] ${message}\n`);

const POLL_MS = 1000;
const WARN_MS = 10_000;
let last = Atomics.load(heartbeat, 0);
let lastChange = Date.now();
let warned = false;

while (true) {
  // Sleep on a slot nobody notifies: a timed wait that does not need this thread's event loop.
  Atomics.wait(heartbeat, 1, 0, POLL_MS);
  const current = Atomics.load(heartbeat, 0);
  const now = Date.now();
  if (current !== last) {
    last = current;
    lastChange = now;
    warned = false;
    continue;
  }
  const stalledMs = now - lastChange;
  if (!warned && stalledMs >= WARN_MS) {
    warned = true;
    log(`${file}: main thread has not yielded for ${Math.round(stalledMs / 1000)}s`);
  }
  if (stalledMs >= limitMs) {
    log(
      `${file}: main thread blocked for ${Math.round(stalledMs / 1000)}s ` +
        `(limit ${Math.round(limitMs / 1000)}s), killing test worker pid ${process.pid}. ` +
        "A synchronous busy loop cannot be interrupted by --timeout.",
    );
    process.kill(process.pid, "SIGKILL");
  }
}
