import { WebSocket } from "ws";
import { apiMessage, failedJob } from "../../script-runner/protocol";
import type { ScriptJob, ScriptRunnerHandle } from "../../scripts-runtime/dispatch/types";
import type { ExecutorOutput, ScriptExecutorName } from "../../scripts-runtime/executors/types";

export class RemoteScriptRunner implements ScriptRunnerHandle {
  readonly kind = "remote";
  jobsCompleted = 0;
  readonly pending = new Map<string, { finish: (output: ExecutorOutput) => void }>();
  constructor(
    readonly id: string,
    readonly slots: number,
    readonly executors: ScriptExecutorName[],
    readonly socket: WebSocket,
  ) {}
  run(job: ScriptJob, signal?: AbortSignal): Promise<ExecutorOutput> {
    if (signal?.aborted) return Promise.resolve(failedJob("killed"));
    return new Promise((resolve) => {
      const abort = () => {
        if (this.socket.readyState === WebSocket.OPEN)
          this.socket.send(JSON.stringify({ type: "cancel", jobId: job.id }));
      };
      this.pending.set(job.id, {
        finish: (output) => {
          this.pending.delete(job.id);
          signal?.removeEventListener("abort", abort);
          resolve(signal?.aborted ? failedJob("killed") : output);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const frame = JSON.stringify(apiMessage.parse({ type: "job", jobId: job.id, ...job }));
        if (this.socket.readyState !== WebSocket.OPEN) throw new Error("closed");
        this.socket.send(frame, (error) => {
          if (error) this.close();
        });
      } catch {
        this.pending.get(job.id)?.finish(failedJob("executor_error"));
      }
    });
  }
  result(jobId: string, output: ExecutorOutput) {
    const pending = this.pending.get(jobId);
    if (!pending) return;
    this.jobsCompleted++;
    pending.finish(output);
    this.socket.send(JSON.stringify({ type: "ack", jobId }));
  }
  close() {
    for (const pending of this.pending.values()) pending.finish(failedJob("executor_error"));
  }
}
export const scriptRunnerSessions = new Map<string, RemoteScriptRunner>();
export function listScriptRunnerSessions() {
  return [...scriptRunnerSessions.values()].map((runner) => ({
    instanceId: runner.id,
    slots: runner.slots,
    jobsInFlight: runner.pending.size,
    jobsCompleted: runner.jobsCompleted,
  }));
}
