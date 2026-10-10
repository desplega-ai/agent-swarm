/**
 * Fail a wedged test worker in seconds instead of at the CI job limit.
 *
 * `bun test --timeout` is a timer on the test file's own event loop. A synchronous
 * busy loop (the intermittent `Run Tests (2/2)` hang, which spun one test worker at
 * ~80% CPU with no syscalls for 20 minutes) starves that loop, so the timeout never
 * fires and the job only ends at the workflow limit.
 *
 * The main thread bumps a shared counter every second. A second thread watches it and
 * kills the process when the counter stops moving, which makes `bun test` report the
 * file as failed. Tests that yield to the event loop at all never trip it.
 *
 * `TEST_HANG_WATCHDOG_MS=0` turns it off; any other number sets the limit (default 60s).
 */
import { Worker } from "node:worker_threads";

const DEFAULT_LIMIT_MS = 60_000;

export function startHangWatchdog(file: string = Bun.main): void {
  const raw = process.env.TEST_HANG_WATCHDOG_MS;
  const limitMs = raw === undefined ? DEFAULT_LIMIT_MS : Number(raw);
  if (!Number.isFinite(limitMs) || limitMs <= 0) return;

  const heartbeat = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(new URL("./hang-watchdog-worker.ts", import.meta.url), {
    workerData: { heartbeat, file, limitMs },
  });
  worker.unref();
  setInterval(() => Atomics.add(heartbeat, 0, 1), 1000).unref();
}
