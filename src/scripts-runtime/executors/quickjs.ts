import type { QuickJSWorkerMessage, QuickJSWorkerRequest } from "./quickjs-worker";
import type { ExecutorInput, ExecutorOutput, ScriptExecutor, ScriptExecutorError } from "./types";

/**
 * Opt-in executor (`SCRIPT_EXECUTOR=quickjs`) that evaluates scripts in
 * QuickJS compiled to WASM, inside a small pool of worker threads. There is
 * no process spawn per run, so a short script costs about a millisecond
 * instead of the native floor (~10 ms on Linux, ~35 ms on macOS).
 *
 * The sandbox has no filesystem, no process APIs, and no network except the
 * host calls that the quickjs runner exposes (ctx.swarm, ctx.api, ctx.mcp,
 * fetch). Every value crosses as JSON. See quickjs-runner.ts for the limits.
 */

// Each worker keeps one QuickJS WASM module (~25 ms to load) and runs one job
// at a time. Jobs beyond the pool size wait in a queue.
const POOL_SIZE = 4;
// The worker enforces the wall clock itself. This margin only catches a
// worker that stopped answering, for example a host call that never settles.
const UNRESPONSIVE_GRACE_MS = 5_000;
// A worker's WASM memory keeps the peak of its largest job (up to memoryMb).
// Recycle a worker that grew past this, so idle workers stay small.
const RECYCLE_WASM_HEAP_BYTES = 64 * 1024 * 1024;

type Slot = { worker: Worker; ready: Promise<void>; busy: boolean };

/**
 * In the compiled API binary every module's `import.meta.url` is the binary
 * itself, and the extra worker entrypoint lives at its path relative to the
 * entrypoints' common root (`src/`). See the Dockerfile compile step.
 */
function workerSpecifier(): string {
  if (import.meta.url.includes("/$bunfs/")) return "./scripts-runtime/executors/quickjs-worker.ts";
  return new URL("./quickjs-worker.ts", import.meta.url).href;
}

function emptyOutput(error: ScriptExecutorError, stderr = ""): ExecutorOutput {
  return {
    result: undefined,
    stdout: "",
    stderr,
    truncated: { stdout: false, stderr: false },
    durationMs: 0,
    exitCode: 1,
    error,
  };
}

class QuickJSWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly waiters: Array<(slot: Slot) => void> = [];

  constructor(private readonly size: number) {}

  private spawn(): Slot {
    const worker = new Worker(workerSpecifier());
    // Idle workers must not keep the API process (or a test run) alive.
    worker.unref();
    const ready = new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent<QuickJSWorkerMessage>) => {
        if (event.data.type === "ready") resolve();
        else if (event.data.type === "fatal" && event.data.id === undefined) {
          reject(new Error(event.data.message));
        } else return;
        worker.removeEventListener("message", onMessage);
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", (event) => reject(new Error(event.message)), { once: true });
    });
    // A failed boot is reported to the job that waits on `ready`.
    ready.catch(() => {});
    const slot: Slot = { worker, ready, busy: true };
    this.slots.push(slot);
    return slot;
  }

  acquire(): Promise<Slot> {
    const idle = this.slots.find((slot) => !slot.busy);
    if (idle) {
      idle.busy = true;
      return Promise.resolve(idle);
    }
    if (this.slots.length < this.size) return Promise.resolve(this.spawn());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(slot: Slot): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(slot);
    else slot.busy = false;
  }

  /** Terminate a worker that is in an unknown state and hand its place to a waiter. */
  get workerCount(): number {
    return this.slots.length;
  }

  discard(slot: Slot): void {
    slot.worker.terminate();
    const index = this.slots.indexOf(slot);
    if (index !== -1) this.slots.splice(index, 1);
    const waiter = this.waiters.shift();
    if (waiter) waiter(this.spawn());
  }
}

let sharedPool: QuickJSWorkerPool | undefined;

/** Number of live workers in the shared pool. For tests and diagnostics. */
export function quickJSWorkerCount(): number {
  return sharedPool?.workerCount ?? 0;
}
let requestSeq = 0;

export class QuickJSScriptExecutor implements ScriptExecutor {
  readonly name = "quickjs";

  async run(input: ExecutorInput): Promise<ExecutorOutput> {
    if (input.fsMode === "workspace-rw") {
      return emptyOutput("executor_error", "workspace-rw not supported by quickjs executor");
    }
    if (input.signal?.aborted) return emptyOutput("killed");

    sharedPool ??= new QuickJSWorkerPool(POOL_SIZE);
    const pool = sharedPool;
    const slot = await pool.acquire();
    if (input.signal?.aborted) {
      pool.release(slot);
      return emptyOutput("killed");
    }
    try {
      await slot.ready;
    } catch (error) {
      pool.discard(slot);
      return emptyOutput(
        "executor_error",
        `quickjs worker failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const id = ++requestSeq;
    const start = performance.now();
    return await new Promise<ExecutorOutput>((resolve) => {
      let settled = false;
      const settle = (output: ExecutorOutput, healthy: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        slot.worker.removeEventListener("message", onMessage);
        slot.worker.removeEventListener("error", onError);
        input.signal?.removeEventListener("abort", onAbort);
        if (healthy) pool.release(slot);
        else pool.discard(slot);
        resolve(output);
      };
      const elapsed = () => Math.round(performance.now() - start);
      const onMessage = (event: MessageEvent<QuickJSWorkerMessage>) => {
        const message = event.data;
        if (message.type === "result" && message.id === id) {
          // Reuse the worker only if every host call settled and its memory stayed small.
          const reusable =
            message.leakedHostCalls === 0 &&
            (message.wasmHeapBytes ?? 0) <= RECYCLE_WASM_HEAP_BYTES;
          settle(message.output, reusable);
        } else if (message.type === "fatal" && message.id === id) {
          settle(
            { ...emptyOutput("executor_error", message.message), durationMs: elapsed() },
            false,
          );
        }
      };
      const onError = (event: ErrorEvent) => {
        settle({ ...emptyOutput("executor_error", event.message), durationMs: elapsed() }, false);
      };
      // Terminating the worker is the hard kill: it also stops a busy loop.
      const onAbort = () => settle({ ...emptyOutput("killed"), durationMs: elapsed() }, false);
      const watchdog = setTimeout(
        () => settle({ ...emptyOutput("timeout"), exitCode: 124, durationMs: elapsed() }, false),
        input.resources.wallClockMs + UNRESPONSIVE_GRACE_MS,
      );

      slot.worker.addEventListener("message", onMessage);
      slot.worker.addEventListener("error", onError);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      slot.worker.postMessage({
        id,
        job: {
          source: input.source,
          args: input.args,
          configPayload: input.configPayload,
          resources: input.resources,
        },
      } satisfies QuickJSWorkerRequest);
    });
  }
}
