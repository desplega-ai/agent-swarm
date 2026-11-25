import { WebSocket } from "ws";
import {
  apiMessage,
  encodeRunnerFrame,
  failedJob,
  RPC_CLEANUP_GRACE_MS,
} from "../../script-runner/protocol";
import type { StartScriptExecutionInput } from "../../script-workflows/executor";
import { heldScriptSlots } from "../../scripts-runtime/dispatch/held-reservations";
import type { ScriptJob, ScriptRunnerHandle } from "../../scripts-runtime/dispatch/types";
import type { ExecutorOutput, ScriptExecutorName } from "../../scripts-runtime/executors/types";
import type { ShellRuntime } from "../../scripts-runtime/shell-job";

import { scriptRunnerOwnerId } from "./owner-identity";

export class RemoteScriptRunner implements ScriptRunnerHandle {
  readonly kind = "remote";
  readonly ownerId: string;
  jobsCompleted = 0;
  draining = false;
  readonly pending = new Map<string, { finish: (output: ExecutorOutput) => void }>();
  constructor(
    readonly id: string,
    readonly slots: number,
    readonly executors: ScriptExecutorName[],
    readonly socket: WebSocket,
    credentialId: string,
    readonly runtimes: ShellRuntime[] = [],
  ) {
    this.ownerId = scriptRunnerOwnerId(credentialId, id);
  }
  async startHeld(input: StartScriptExecutionInput) {
    const { startRemoteDurable } = await import("./durable-dispatch");
    return startRemoteDurable(input, this);
  }
  run(job: ScriptJob, signal?: AbortSignal): Promise<ExecutorOutput> {
    if (signal?.aborted) return Promise.resolve(failedJob("killed"));
    let frame: string;
    try {
      frame = encodeRunnerFrame(apiMessage.parse({ type: "job", jobId: job.id, ...job }));
    } catch {
      return Promise.resolve(failedJob("executor_error"));
    }
    return new Promise((resolve) => {
      let cleanup: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        if (cleanup) return;
        cleanup = setTimeout(() => this.close(), RPC_CLEANUP_GRACE_MS);
        this.send(encodeRunnerFrame({ type: "cancel", jobId: job.id }));
      };
      const deadline = setTimeout(
        () => this.close(),
        (job.kind === "step-shell"
          ? (job.input.timeout ?? 30_000)
          : job.input.resources.wallClockMs) + RPC_CLEANUP_GRACE_MS,
      );
      this.pending.set(job.id, {
        finish: (output) => {
          clearTimeout(deadline);
          clearTimeout(cleanup);
          this.pending.delete(job.id);
          signal?.removeEventListener("abort", abort);
          resolve(signal?.aborted ? failedJob("killed") : output);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.send(frame);
    });
  }
  private send(frame: string) {
    try {
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error("closed");
      this.socket.send(frame, (error) => {
        if (error) this.close();
      });
    } catch {
      this.close();
    }
  }

  result(jobId: string, output: ExecutorOutput) {
    const pending = this.pending.get(jobId);
    if (!pending) return;
    this.jobsCompleted++;
    pending.finish(output);
    this.send(encodeRunnerFrame({ type: "ack", jobId }));
  }
  close() {
    this.socket.terminate();
    for (const pending of this.pending.values()) pending.finish(failedJob("executor_error"));
  }
}
export const scriptRunnerSessions = new Map<string, RemoteScriptRunner>();
export function listScriptRunnerSessions() {
  return [...scriptRunnerSessions.values()].map((runner) => ({
    instanceId: runner.id,
    slots: runner.slots,
    jobsInFlight: runner.pending.size + heldScriptSlots(runner.id),
    jobsCompleted: runner.jobsCompleted,
  }));
}

export type HeldStepHooks = {
  heartbeat(runner: RemoteScriptRunner, id: string): Promise<boolean>;
  result(runner: RemoteScriptRunner, id: string, output: ExecutorOutput): Promise<boolean>;
  reconnect(runner: RemoteScriptRunner, id: string): Promise<boolean>;
};
let stepHooks: HeldStepHooks | undefined;
export function registerHeldStepHooks(hooks: HeldStepHooks) {
  stepHooks = hooks;
}
export function heldStepHooks() {
  return stepHooks;
}
