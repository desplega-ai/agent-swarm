/**
 * Worker thread entry for the quickjs executor. Each worker loads the QuickJS
 * WASM module once and then runs one job at a time, each in a fresh QuickJS
 * runtime. The worker keeps the API event loop free while a script runs
 * synchronous code, and its own `globalThis.fetch` lets the egress patch stay
 * per job instead of per API process.
 *
 * The compiled API binary must list this file as an extra entrypoint
 * (see Dockerfile).
 */
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { patchFetchWithEgressSubstitution } from "../egress-secrets";
import { type QuickJSJob, type QuickJSJobResult, runQuickJSJob } from "./quickjs-runner";

declare const self: Worker;

export type QuickJSWorkerRequest = { id: number; job: QuickJSJob };
export type QuickJSWorkerMessage =
  | { type: "ready" }
  | {
      type: "result";
      id: number;
      output: QuickJSJobResult["output"];
      /** Size of the worker's WASM linear memory after the job, when known. */
      wasmHeapBytes?: number;
      /** Host calls that did not settle after the run was aborted. */
      leakedHostCalls: number;
    }
  | { type: "fatal"; id?: number; message: string };

const pristineFetch = globalThis.fetch;
const modulePromise = newQuickJSWASMModuleFromVariant(variant);

/**
 * WASM linear memory grows to the peak of any job and never shrinks, even
 * after the QuickJS runtime is disposed. The pool reads this to recycle a
 * worker whose memory grew. `module` is not public API, so this is best effort.
 */
function wasmHeapBytes(QuickJS: unknown): number | undefined {
  const heap = (QuickJS as { module?: { HEAPU8?: Uint8Array } }).module?.HEAPU8;
  return heap instanceof Uint8Array ? heap.byteLength : undefined;
}

self.onmessage = async (event: MessageEvent<QuickJSWorkerRequest>) => {
  const { id, job } = event.data;
  try {
    const QuickJS = await modulePromise;
    // Re-install from the pristine fetch so egress patches never stack across jobs.
    globalThis.fetch = pristineFetch;
    patchFetchWithEgressSubstitution(
      job.configPayload.egressSecrets ?? [],
      job.configPayload.failedBindings ?? [],
    );
    const { output, leakedHostCalls } = await runQuickJSJob(QuickJS, job);
    postMessage({
      type: "result",
      id,
      output,
      leakedHostCalls,
      wasmHeapBytes: wasmHeapBytes(QuickJS),
    } satisfies QuickJSWorkerMessage);
  } catch (error) {
    postMessage({
      type: "fatal",
      id,
      message: error instanceof Error ? error.message : String(error),
    } satisfies QuickJSWorkerMessage);
  } finally {
    globalThis.fetch = pristineFetch;
  }
};

modulePromise.then(
  () => postMessage({ type: "ready" } satisfies QuickJSWorkerMessage),
  (error) =>
    postMessage({
      type: "fatal",
      message: `failed to load QuickJS: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies QuickJSWorkerMessage),
);
