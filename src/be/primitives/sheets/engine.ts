import { ObjectsError } from "../objects";
import type { EngineMessage, EnginePatch, EngineRequest } from "./engine-worker";
import type { SheetCell, SheetTab } from "./format";

/**
 * Host side of the sheet engine: one long-lived Bun worker holds IronCalc.
 * Calls run one at a time, each with its own timeout. A call that times out
 * kills the worker; the next call starts a fresh one.
 */

export const ENGINE_TIMEOUT_MS = 10_000;
/** Calls waiting or running at once. Bounds the queue wait to about this many timeouts. */
export const MAX_ENGINE_CALLS = 8;
/** Calls one caller may have waiting or running, so one agent cannot fill the queue. */
export const MAX_ENGINE_CALLS_PER_CALLER = 2;

/** In the compiled API binary every `import.meta.url` is the binary; see the Dockerfile compile step. */
function workerSpecifier(): string {
  if (import.meta.url.includes("/$bunfs/")) return "./be/primitives/sheets/engine-worker.ts";
  return new URL("./engine-worker.ts", import.meta.url).href;
}

export type RecalcResult = { cells: Array<Record<string, SheetCell>>; changed: string[] };

export class SheetEngine {
  private worker: Promise<Worker> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private pending = new Map<string, number>();
  private total = 0;

  private spawn(): Promise<Worker> {
    const worker = new Worker(workerSpecifier());
    // An idle engine must not keep the API process (or a test run) alive.
    (worker as Worker & { unref?: () => void }).unref?.();
    return new Promise<Worker>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new ObjectsError("sheet engine failed to start in time; retry"));
      }, ENGINE_TIMEOUT_MS);
      worker.addEventListener("message", function onReady(event: MessageEvent<EngineMessage>) {
        if (event.data.type !== "ready") return;
        clearTimeout(timer);
        worker.removeEventListener("message", onReady);
        resolve(worker);
      });
      worker.addEventListener(
        "error",
        (event) => {
          clearTimeout(timer);
          reject(new Error(`sheet engine failed to start: ${event.message}`));
        },
        { once: true },
      );
    });
  }

  private kill(): void {
    const pending = this.worker;
    this.worker = undefined;
    pending?.then((worker) => worker.terminate()).catch(() => {});
  }

  /** Apply `patches` to `tabs` and return the recomputed cells. */
  recalc(
    tabs: SheetTab[],
    patches: EnginePatch[],
    options: { maxCells: number; timeoutMs?: number; caller?: string },
  ): Promise<RecalcResult> {
    // Refuse before queueing: a call that cannot fit never holds a workbook in memory or a queue slot.
    const caller = options.caller ?? "";
    const mine = this.pending.get(caller) ?? 0;
    if (this.total >= MAX_ENGINE_CALLS || mine >= MAX_ENGINE_CALLS_PER_CALLER) {
      return Promise.reject(
        new ObjectsError("sheet engine is busy with other recalculations; retry in a few seconds"),
      );
    }
    const cells = tabs.reduce((n, tab) => n + Object.keys(tab.cells).length, 0);
    if (cells > options.maxCells) {
      return Promise.reject(
        new ObjectsError(`the workbook has ${cells} cells; the limit is ${options.maxCells}`),
      );
    }
    this.pending.set(caller, mine + 1);
    this.total++;
    const release = () => {
      this.total--;
      const left = (this.pending.get(caller) ?? 1) - 1;
      if (left > 0) this.pending.set(caller, left);
      else this.pending.delete(caller);
    };
    const run = async (): Promise<RecalcResult> => {
      this.worker ??= this.spawn();
      let worker: Worker;
      try {
        worker = await this.worker;
      } catch (error) {
        this.worker = undefined;
        throw error;
      }
      const id = this.nextId++;
      const timeoutMs = options.timeoutMs ?? ENGINE_TIMEOUT_MS;
      return new Promise<RecalcResult>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
        };
        const timer = setTimeout(() => {
          done();
          this.kill();
          reject(
            new ObjectsError(
              `sheet engine timed out after ${timeoutMs} ms; the workbook is too heavy to recalculate`,
            ),
          );
        }, timeoutMs);
        const onMessage = (event: MessageEvent<EngineMessage>) => {
          const message = event.data;
          if (message.type === "result" && message.id === id) {
            done();
            resolve({ cells: message.cells, changed: message.changed });
          } else if (message.type === "error" && message.id === id) {
            done();
            if (message.fatal) this.kill();
            reject(new ObjectsError(message.message));
          }
        };
        const onError = (event: ErrorEvent) => {
          done();
          this.kill();
          reject(new Error(`sheet engine crashed: ${event.message}`));
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        const request: EngineRequest = { id, tabs, patches, maxCells: options.maxCells };
        worker.postMessage(request);
      });
    };
    // One call at a time: the timeout clock starts when the worker is free, not when the call queues.
    const result = this.queue.then(run, run).finally(release);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Stop the worker. The next call starts a new one. */
  stop(): void {
    this.kill();
  }
}

let shared: SheetEngine | undefined;
export const sheetEngine = (): SheetEngine => {
  shared ??= new SheetEngine();
  return shared;
};
